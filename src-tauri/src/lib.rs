use tauri::menu::{CheckMenuItem, CheckMenuItemBuilder, Menu, MenuItemBuilder, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Listener, Manager, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_global_shortcut::{Code, Modifiers, ShortcutState};
use tauri_plugin_sql::{Migration, MigrationKind};

mod ai;
// pub 仅为让 examples/search_probe.rs 直接调用 ai_web_search 做端到端验证
pub mod web_search;

/// 托盘菜单中的「开机自启动」勾选项：事件回调里通过 state 同步勾选状态
/// （TrayIcon 没有读取菜单的 API，只能保存引用后 set_checked）
struct TrayMenuState(std::sync::Mutex<Option<CheckMenuItem<tauri::Wry>>>);

/// 主窗口最后可见位置（客户区物理像素）：托盘 hide→show 循环位置漂移的校正基准。
/// Windows 上无装饰 + 阴影窗口每次 hide/show 都会被 tao 重写窗口样式并强制
/// 非客户区重算（SWP_FRAMECHANGED），位置可能被挪动且逐次累积；
/// 显示路径据此把窗口拉回用户上次看到的位置。
struct LastWindowPos(std::sync::Mutex<Option<(i32, i32)>>);

/// 位置校正容差（物理像素）：小于此值的偏差视为取整误差，不校正
const POS_GUARD_TOLERANCE: i32 = 2;

/// 「显示主窗口」后的位置漂移校正：对比记录的最后可见客户区位置，
/// 偏差超容差时按当前内外框偏移换算，把客户区拉回记录位置。
/// 窄条 / 最小化等异常尺寸不在此处理（分别由收纳展开与 ensure_main_window_visible 兜底）。
fn correct_window_position(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    let recorded = app.state::<LastWindowPos>().0.lock().unwrap().clone();
    let Some((recorded_x, recorded_y)) = recorded else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    if size.width < 200 || size.height < 200 {
        return;
    }
    let (Ok(outer), Ok(inner)) = (window.outer_position(), window.inner_position()) else {
        return;
    };
    if (inner.x - recorded_x).abs() <= POS_GUARD_TOLERANCE
        && (inner.y - recorded_y).abs() <= POS_GUARD_TOLERANCE
    {
        return;
    }
    // set_position 设置的是外框位置：按当前内外框偏移换算，让客户区落回记录位置
    let _ = window.set_position(tauri::PhysicalPosition::new(
        recorded_x - (inner.x - outer.x),
        recorded_y - (inner.y - outer.y),
    ));
}

/// 前端设置页切换「开机自启动」后回传的新开关状态，用于同步托盘菜单勾选态
#[derive(serde::Deserialize)]
struct AutostartSetPayload {
    enabled: bool,
}

/// 临时斗篷窗口（DWMWA_CLOAK，Win8+）：收纳时关投影会触发 tao 重写窗口样式并
/// 强制非客户区重算（SWP_FRAMECHANGED + WM_NCCALCSIZE），客户区向外扩一圈不可见
/// 边框，DWM 对重算后的边框按经典亮色绘一帧——表现为收纳时画面闪现白边。
/// 斗篷期间 DWM 不合成该窗口，重算与缩窗全程不可见，揭开时即是最终窄条。
#[tauri::command]
#[cfg(windows)]
fn set_window_cloaked(window: tauri::WebviewWindow, cloaked: bool) -> Result<(), String> {
    use windows::core::BOOL;
    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_CLOAK};
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let value = BOOL::from(cloaked);
    unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_CLOAK,
            &value as *const BOOL as *const std::ffi::c_void,
            std::mem::size_of::<BOOL>() as u32,
        )
        .map_err(|error| format!("设置窗口斗篷失败: {error}"))
    }
}

/// 非 Windows 平台无 DWM，直接成功
#[tauri::command]
#[cfg(not(windows))]
fn set_window_cloaked(window: tauri::WebviewWindow, _cloaked: bool) -> Result<(), String> {
    let _ = window;
    Ok(())
}

/// 「显示主窗口」兜底：show() 对「可见但矩形落在工作区外」或「窄条/异常小窗」无能为力。
/// 拖放贴边相关的各种竞态可能把窗口留在看不见的位置；这里检查窗口外框与所在
/// 显示器工作区的交集，完全不可见或窄条尺寸时重置为默认尺寸放回工作区，
/// 保证「显示主窗口」一定能让用户看到窗口。
fn ensure_main_window_visible(window: &tauri::WebviewWindow) {
    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return;
    };
    let area = monitor.work_area();
    let (ax, ay) = (area.position.x, area.position.y);
    let (aw, ah) = (area.size.width as i32, area.size.height as i32);
    // 外框与工作区的交集面积：为 0 说明窗口完全不可见
    let ix = pos.x.max(ax);
    let iy = pos.y.max(ay);
    let ix2 = (pos.x + size.width as i32).min(ax + aw);
    let iy2 = (pos.y + size.height as i32).min(ay + ah);
    let visible_px = (ix2 - ix).max(0) * (iy2 - iy).max(0);
    // 正常窗口 422×540 逻辑像素起步；任一边小于 100 物理像素即窄条/异常小窗
    if visible_px > 0 && size.width >= 100 && size.height >= 100 {
        return;
    }
    let scale = window.scale_factor().unwrap_or(1.0);
    let w = ((422.0 * scale).round() as u32).min(area.size.width);
    let h = ((540.0 * scale).round() as u32).min(area.size.height);
    // 放回工作区中央偏上，避开贴边位置与任务栏
    let x = ax + (((aw - w as i32) / 2).max(0));
    let y = ay + (((ah - h as i32) / 3).max(0));
    let _ = window.set_size(tauri::PhysicalSize::new(w, h));
    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
}

/// 前端「退出应用」：绕过关闭拦截直接结束进程（点 X 的选择弹窗里触发）
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// 一步下发窗口位置与客户区尺寸：单个 SetWindowPos 原子生效。
/// 前端分开调 setSize/setPosition 时两条消息先后落地，中间态窗口按左上角锚点放大——
/// 右侧/顶部收纳的贴边窗口会被甩出屏幕，钉在边缘的窄条闪没一帧再弹回
/// （收纳展开时「小条闪烁」即由此而来）。
#[tauri::command]
fn set_window_bounds(
    window: tauri::WebviewWindow,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::RECT;
        use windows::Win32::UI::WindowsAndMessaging::{
            GetClientRect, GetWindowRect, SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER,
        };
        let hwnd = window.hwnd().map_err(|error| error.to_string())?;
        unsafe {
            let mut frame = RECT::default();
            let mut client = RECT::default();
            if GetWindowRect(hwnd, &mut frame).is_err()
                || GetClientRect(hwnd, &mut client).is_err()
            {
                return Err("读取窗口矩形失败".into());
            }
            // SetWindowPos 的宽高是外框（含边框）口径；调用方给的是客户区尺寸，
            // 补上透明窗口那圈不可见边框，与 setSize 的客户区口径对齐
            let frame_w = (frame.right - frame.left) - (client.right - client.left);
            let frame_h = (frame.bottom - frame.top) - (client.bottom - client.top);
            SetWindowPos(
                hwnd,
                None,
                x,
                y,
                width as i32 + frame_w,
                height as i32 + frame_h,
                SWP_NOZORDER | SWP_NOACTIVATE,
            )
            .map_err(|error| format!("下发窗口矩形失败: {error}"))?;
        }
    }
    #[cfg(not(windows))]
    let _ = (window, x, y, width, height);
    Ok(())
}

/// SQLite 数据库文件实际路径：应用数据目录下的 bianqian.db
fn db_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|error| error.to_string())?;
    Ok(dir.join("bianqian.db"))
}

/// 备份数据库：把当前 SQLite 文件完整复制到用户选择的位置（设置 → 数据管理）
#[tauri::command]
fn backup_db(app: tauri::AppHandle, dest_path: String) -> Result<(), String> {
    let src = db_path(&app)?;
    std::fs::copy(&src, &dest_path).map_err(|error| format!("备份失败：{error}"))?;
    Ok(())
}

/// 恢复数据库：用备份文件覆盖当前 SQLite（须重启应用后生效，SQLite 连接仍指向旧句柄）
#[tauri::command]
fn restore_db(app: tauri::AppHandle, src_path: String) -> Result<(), String> {
    let dest = db_path(&app)?;
    std::fs::copy(&src_path, &dest).map_err(|error| format!("恢复失败：{error}"))?;
    Ok(())
}

/// 导出数据：把前端传来的完整 JSON 写入用户选择的位置（不经过数据库，纯应用层备份）
#[tauri::command]
fn write_entries_json(path: String, data: String) -> Result<(), String> {
    std::fs::write(&path, data).map_err(|error| format!("写入失败：{error}"))
}

/// 导入数据：读取用户选择的 JSON 文件内容返回前端解析合并
#[tauri::command]
fn read_entries_json(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|error| format!("读取失败：{error}"))
}

/// 导出分享图：前端把 canvas 转成 base64 PNG，这里解码并写入用户选择的路径
#[tauri::command]
fn write_image_file(path: String, data: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|error| format!("图片解码失败：{error}"))?;
    std::fs::write(&path, bytes).map_err(|error| format!("写入失败：{error}"))
}

/// 每日自动备份保留份数
const AUTO_BACKUP_KEEP: usize = 7;

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutoBackupConfig {
    enabled: bool,
}

impl Default for AutoBackupConfig {
    fn default() -> Self {
        Self { enabled: true }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AutoBackupStatus {
    enabled: bool,
    dir: String,
    last_backup_at: Option<u64>,
    count: usize,
}

/// 自动备份目录：应用数据目录下的 backups
fn backup_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("backups");
    Ok(dir)
}

fn backup_config_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|error| error.to_string())?;
    Ok(dir.join("backup-config.json"))
}

fn load_backup_config(app: &tauri::AppHandle) -> AutoBackupConfig {
    backup_config_path(app)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// UTC 日期戳（YYYY-MM-DD）：仅用于备份文件命名，跨时区午夜附近可能差一天
fn utc_date_stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year_base = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year_base + 1 } else { year_base };
    format!("{year:04}-{month:02}-{day:02}")
}

/// 备份文件列表：按文件名（日期）从新到旧
fn list_backups(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<std::path::PathBuf> = entries
        .filter_map(|entry| entry.ok().map(|item| item.path()))
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("bianqian-") && name.ends_with(".db"))
        })
        .collect();
    files.sort();
    files.reverse();
    files
}

fn backup_status(app: &tauri::AppHandle) -> Result<AutoBackupStatus, String> {
    let dir = backup_dir(app)?;
    let files = list_backups(&dir);
    let last_backup_at = files.first().and_then(|path| {
        path.metadata()
            .ok()
            .and_then(|meta| meta.modified().ok())
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64)
    });
    Ok(AutoBackupStatus {
        enabled: load_backup_config(app).enabled,
        dir: dir.to_string_lossy().to_string(),
        last_backup_at,
        count: files.len(),
    })
}

/// 每日自动备份：同一天只生成一份，超过保留份数后删除最旧的
fn run_daily_backup(app: &tauri::AppHandle) -> Result<(), String> {
    if !load_backup_config(app).enabled {
        return Ok(());
    }
    let db = db_path(app)?;
    if !db.exists() {
        return Ok(());
    }
    let dir = backup_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|error| format!("创建备份目录失败：{error}"))?;
    let target = dir.join(format!("bianqian-{}.db", utc_date_stamp()));
    if !target.exists() {
        std::fs::copy(&db, &target).map_err(|error| format!("自动备份失败：{error}"))?;
    }
    for stale in list_backups(&dir).into_iter().skip(AUTO_BACKUP_KEEP) {
        let _ = std::fs::remove_file(stale);
    }
    Ok(())
}

#[tauri::command]
fn auto_backup_status(app: tauri::AppHandle) -> Result<AutoBackupStatus, String> {
    backup_status(&app)
}

#[tauri::command]
fn set_auto_backup(app: tauri::AppHandle, enabled: bool) -> Result<AutoBackupStatus, String> {
    let path = backup_config_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("创建配置目录失败：{error}"))?;
    }
    let config = AutoBackupConfig { enabled };
    std::fs::write(
        path,
        serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("保存备份设置失败：{error}"))?;
    if enabled {
        run_daily_backup(&app)?;
    }
    backup_status(&app)
}

/// 递归复制目录：WebView2 的 localStorage 是 LevelDB 目录，须整目录搬运
#[cfg(windows)]
fn copy_dir_all(source: &std::path::Path, dest: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let target = dest.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// 旧数据目录迁移：0.1.0 之前标识符为 `com.bianqian.app`（Tauri 警告以 `.app` 结尾会
/// 与 macOS 应用包扩展名冲突），更换标识符后 Windows 的数据目录（`%APPDATA%\<标识符>`）
/// 随之改变。新版首次启动时把旧目录的数据库、AI 配置与 WebView2 localStorage（窗口设置、
/// AI 对话记录）复制到新目录，避免用户数据“丢失”。
#[cfg(windows)]
fn migrate_legacy_data_dir(identifier: &str) {
    const LEGACY_IDENTIFIER: &str = "com.bianqian.app";
    // 数据库（含 WAL 附属文件）与 AI 接入配置、免费模型缓存
    const FILES: [&str; 5] = [
        "bianqian.db",
        "bianqian.db-wal",
        "bianqian.db-shm",
        "ai-config.json",
        "ai-free-models.json",
    ];

    let Some(roaming) = std::env::var_os("APPDATA") else {
        return;
    };
    let roaming = std::path::PathBuf::from(roaming);
    let old_dir = roaming.join(LEGACY_IDENTIFIER);
    let new_dir = roaming.join(identifier);

    // 新目录已有数据库时不覆盖（已迁移，或新版本已正常用过）
    if !old_dir.is_dir() || new_dir.join("bianqian.db").exists() {
        return;
    }
    if let Err(error) = std::fs::create_dir_all(&new_dir) {
        eprintln!("创建数据目录失败：{error}");
        return;
    }
    for name in FILES {
        let source = old_dir.join(name);
        if source.is_file() {
            if let Err(error) = std::fs::copy(&source, new_dir.join(name)) {
                eprintln!("迁移 {name} 失败：{error}");
            }
        }
    }

    // WebView2 用户数据目录（Tauri 在 Windows 下设为 app_local_data_dir）
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let local = std::path::PathBuf::from(local);
        let new_root = local.join(identifier);
        let old_storage = local
            .join(LEGACY_IDENTIFIER)
            .join("EBWebView")
            .join("Default")
            .join("Local Storage");
        if old_storage.is_dir() && !new_root.join("EBWebView").exists() {
            let storage = new_root
                .join("EBWebView")
                .join("Default")
                .join("Local Storage");
            if let Err(error) = copy_dir_all(&old_storage, &storage) {
                eprintln!("迁移浏览器存储失败：{error}");
            }
        }
    }
}

/// 应用入口：注册插件（SQL / 通知 / 自启动 / 单实例）、执行数据库迁移、
/// 构建系统托盘菜单（显示/最小化/隐藏、新建便签、AI 助手、开机自启动开关、退出）。
/// 主窗口配置 skipTaskbar：启动时正常显示但不占任务栏，程序图标只在系统托盘；
/// 关闭窗口只是隐藏到托盘，退出需通过托盘菜单。
/// 透明度由前端 CSS 背景 alpha 控制（背景半透明、文字不透明），无需 Rust 自定义命令。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    // 必须在 SQL 插件初始化（preload 打开数据库）之前完成旧数据目录迁移
    #[cfg(windows)]
    migrate_legacy_data_dir(&context.config().identifier);

    let migrations = vec![
        Migration {
            version: 1,
            description: "create entries table: note / reminder / todo unified schema",
            kind: MigrationKind::Up,
            sql: r#"
CREATE TABLE IF NOT EXISTS entries (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('note','reminder','todo')),
  title         TEXT NOT NULL,
  content       TEXT NOT NULL DEFAULT '',
  remind_at     INTEGER,
  done          INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER,
  notified      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  sync_status  TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_entries_kind ON entries(kind);
CREATE INDEX IF NOT EXISTS idx_entries_updated ON entries(updated_at);
"#,
        },
        Migration {
            version: 2,
            description: "add items column: todo checklist (JSON array of TodoItem)",
            kind: MigrationKind::Up,
            sql: r#"
ALTER TABLE entries ADD COLUMN items TEXT NOT NULL DEFAULT '[]';
"#,
        },
        Migration {
            version: 3,
            description: "add alarms column: reminder alarm list (JSON array of AlarmItem)",
            kind: MigrationKind::Up,
            sql: r#"
ALTER TABLE entries ADD COLUMN alarms TEXT NOT NULL DEFAULT '[]';
"#,
        },
        Migration {
            version: 4,
            description: "add tags column: searchable tag list (JSON string array)",
            kind: MigrationKind::Up,
            sql: r#"
ALTER TABLE entries ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
CREATE INDEX IF NOT EXISTS idx_entries_created ON entries(created_at);
"#,
        },
        Migration {
            version: 5,
            description: "add color/paper columns: note paper appearance (tint color & texture)",
            kind: MigrationKind::Up,
            sql: r#"
ALTER TABLE entries ADD COLUMN color TEXT;
ALTER TABLE entries ADD COLUMN paper TEXT;
"#,
        },
        Migration {
            version: 6,
            description: "add deleted_at column: trash soft-delete timestamp (NULL = not deleted)",
            kind: MigrationKind::Up,
            sql: r#"
ALTER TABLE entries ADD COLUMN deleted_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_entries_deleted ON entries(deleted_at);
"#,
        },
        Migration {
            version: 7,
            description: "allow draw kind: rebuild entries table with updated kind CHECK constraint",
            kind: MigrationKind::Up,
            sql: r#"
CREATE TABLE entries_new (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('note','reminder','todo','draw')),
  title         TEXT NOT NULL,
  content       TEXT NOT NULL DEFAULT '',
  remind_at     INTEGER,
  done          INTEGER NOT NULL DEFAULT 0,
  completed_at  INTEGER,
  notified      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  sync_status  TEXT NOT NULL DEFAULT 'pending',
  items         TEXT NOT NULL DEFAULT '[]',
  alarms        TEXT NOT NULL DEFAULT '[]',
  tags          TEXT NOT NULL DEFAULT '[]',
  color         TEXT,
  paper         TEXT,
  deleted_at    INTEGER
);
INSERT INTO entries_new
  (id, kind, title, content, remind_at, done, completed_at, notified, created_at, updated_at, sync_status, items, alarms, tags, color, paper, deleted_at)
SELECT
  id, kind, title, content, remind_at, done, completed_at, notified, created_at, updated_at, sync_status, items, alarms, tags, color, paper, deleted_at
FROM entries;
DROP TABLE entries;
ALTER TABLE entries_new RENAME TO entries;
CREATE INDEX IF NOT EXISTS idx_entries_kind ON entries(kind);
CREATE INDEX IF NOT EXISTS idx_entries_updated ON entries(updated_at);
CREATE INDEX IF NOT EXISTS idx_entries_created ON entries(created_at);
CREATE INDEX IF NOT EXISTS idx_entries_deleted ON entries(deleted_at);
"#,
        },
    ];

    tauri::Builder::default()
        // AI 助手请求取消标记（跨命令共享）
        .manage(ai::AiState::default())
        // 主窗口最后可见位置：hide→show 循环位置漂移的校正基准
        .manage(LastWindowPos(std::sync::Mutex::new(None)))
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:bianqian.db", migrations)
                .build(),
        )
        // 开机自启动（Windows 注册表启动项；参数对 Windows 无意义，仅为跨平台兼容）
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        // 单实例：二次启动时聚焦已有主窗口并向前端发事件（重复启动不新开窗口）
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                // 最小化时 show() 不会还原窗口（仍停在屏幕外的最小化矩形），必须先 unminimize
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
                correct_window_position(app, &window);
                ensure_main_window_visible(&window);
            }
            let _ = app.emit("app:second-instance", ());
        }))
        // 剪贴板：快速记录「从剪贴板创建」读取文本
        .plugin(tauri_plugin_clipboard_manager::init())
        // 文件对话框：数据导出 / 导入、数据库备份 / 恢复的文件选择
        .plugin(tauri_plugin_dialog::init())
        // 系统浏览器打开外链（设置页友情链接）
        .plugin(tauri_plugin_opener::init())
        // 全局快捷键：Ctrl+Shift+N 在任何应用唤起快速记录输入框（选中文字后直接记录）
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    if shortcut.matches(Modifiers::CONTROL | Modifiers::SHIFT, Code::KeyN) {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                            correct_window_position(app, &window);
                            ensure_main_window_visible(&window);
                        }
                        let _ = app.emit("global:quick-capture", ());
                    } else if shortcut
                        .matches(Modifiers::CONTROL | Modifiers::SHIFT, Code::Space)
                    {
                        if let Some(window) = app.get_webview_window("main") {
                            // 已可见且持有焦点 → 交给前端隐藏（收纳窄条态由前端改为展开）；
                            // 可见但失焦 → 仅聚焦；隐藏 → 显示并聚焦，前端收到事件后展开窄条
                            if window.is_visible().unwrap_or(false)
                                && window.is_focused().unwrap_or(false)
                            {
                                let _ = app.emit("global:toggle-window", ());
                            } else {
                                let _ = window.unminimize();
                                let _ = window.show();
                                let _ = window.set_focus();
                                correct_window_position(app, &window);
                                ensure_main_window_visible(&window);
                                let _ = app.emit("global:window-shown", ());
                            }
                        }
                    }
                })
                .build(),
        )
        .setup(|app| {
            build_tray(app)?;
            // 主窗口在 tauri.conf.json 中配置为 skipTaskbar: true：
            // 任何方式启动（手动 / 开机自启）都正常显示窗口，但不显示任务栏图标，
            // 程序图标仅在系统托盘；通过托盘单击、托盘菜单或全局快捷键操作主窗口
            // 设置页切换「开机自启动」后，前端回传新状态：该侧已通过插件完成 enable/disable，
            // 这里只同步托盘菜单的勾选视觉（更新后无需再发事件，避免与下方 tray 回发形成回环）
            let sync_handle = std::sync::Arc::new(app.handle().clone());
            sync_handle.listen("autostart:set", {
                let handle = sync_handle.clone();
                move |event| {
                    let Ok(payload) =
                        serde_json::from_str::<AutostartSetPayload>(event.payload())
                    else {
                        return;
                    };
                    let state = handle.state::<TrayMenuState>();
                    let guard = state.0.lock().unwrap();
                    if let Some(item) = guard.as_ref() {
                        let _ = item.set_checked(payload.enabled);
                    }
                }
            });
            // 每日自动备份：启动时检查当天是否已备份，失败只记录日志，不阻塞启动
            if let Err(error) = run_daily_backup(app.handle()) {
                eprintln!("每日自动备份失败: {error}");
            }
            // 注册全局快捷键 Ctrl+Shift+N：唤起快速记录
            {
                use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
                let shortcut =
                    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyN);
                if let Err(error) = app.global_shortcut().register(shortcut) {
                    eprintln!("注册全局快捷键失败: {error}");
                }
                // Ctrl+Shift+Space：显示 / 隐藏主窗口
                let toggle =
                    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space);
                if let Err(error) = app.global_shortcut().register(toggle) {
                    eprintln!("注册窗口显示/隐藏快捷键失败: {error}");
                }
            }
            // 关闭拦截：点 X / Alt+F4 不退出，直接隐藏到系统托盘继续运行
            // （提醒、闹钟、自动备份等后台能力不受影响；退出走托盘菜单「退出」）
            if let Some(window) = app.get_webview_window("main") {
                let window_clone = window.clone();
                window.on_window_event(move |event| {
                    match event {
                        WindowEvent::CloseRequested { api, .. } => {
                            api.prevent_close();
                            let _ = window_clone.hide();
                        }
                        // 记录可见状态下的最后客户区位置（物理像素），供显示后的漂移校正。
                        // 隐藏 / 最小化期间的屏幕外坐标（最小化约 -32000）不记录；
                        // tao 的 hide/show 样式重算引发的漂移发生在隐藏阶段，也不会被记录
                        WindowEvent::Moved(_) => {
                            if !matches!(window_clone.is_visible(), Ok(true)) {
                                return;
                            }
                            if let Ok(inner) = window_clone.inner_position() {
                                if inner.x > -10_000 && inner.y > -10_000 {
                                    let state =
                                        window_clone.app_handle().state::<LastWindowPos>();
                                    *state.0.lock().unwrap() = Some((inner.x, inner.y));
                                }
                            }
                        }
                        _ => {}
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            quit_app,
            set_window_bounds,
            backup_db,
            restore_db,
            write_entries_json,
            read_entries_json,
            write_image_file,
            auto_backup_status,
            set_auto_backup,
            ai::ai_get_status,
            ai::ai_save_profile,
            ai::ai_activate_profile,
            ai::ai_delete_profile,
            ai::ai_clear_key,
            ai::ai_set_free_key,
            ai::ai_test,
            ai::ai_list_models,
            ai::ai_chat,
            ai::ai_cancel,
            web_search::ai_web_search,
            get_autostart_enabled,
            set_window_cloaked
        ])
        .run(context)
        .expect("启动便签应用失败");
}

/// 读取「开机自启动」真实开关状态。
///
/// 插件底层 auto_launch 0.6 的 `is_enabled()` 在 Windows 上会先读 `HKLM\...\Run`，
/// 非管理员无权限时返回 access-denied 且未被忽略，导致整个判定抛错——表现为托盘点击
/// 永远按「启用」处理、勾选与事件不更新、且关不掉。这里改为直接读 Run 键：
/// HKCU 优先（Dynamic 模式对非管理员写入此处），HKLM 仅在可访问时检查，被拒则忽略。
#[cfg(windows)]
fn autostart_is_enabled(app: &tauri::AppHandle) -> bool {
    use windows_registry::{CURRENT_USER, LOCAL_MACHINE};
    const RUN_KEY: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Run";
    let name = app.package_info().name.clone();
    [CURRENT_USER, LOCAL_MACHINE].iter().any(|root| {
        root.open(RUN_KEY)
            .and_then(|key| key.get_string(&name))
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
    })
}

/// 非 Windows 平台：插件原逻辑正常，直接复用
#[cfg(not(windows))]
fn autostart_is_enabled(app: &tauri::AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

/// 供前端（设置页）读取开机自启动真实状态，绕过插件 is_enabled 在 Windows 上的缺陷
#[tauri::command]
fn get_autostart_enabled(app: tauri::AppHandle) -> bool {
    autostart_is_enabled(&app)
}

/// 构建系统托盘：图标 + 菜单（显示/最小化/隐藏主窗口、新建便签、AI 助手、开机自启动勾选、退出）。
/// 左键单击切换显示/隐藏，左键双击显示并聚焦。
fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let show_item = MenuItemBuilder::with_id("show", "显示主窗口").build(app)?;
    let minimize_item = MenuItemBuilder::with_id("minimize", "最小化主窗口").build(app)?;
    let hide_item = MenuItemBuilder::with_id("hide", "隐藏主窗口").build(app)?;
    let new_item = MenuItemBuilder::with_id("new", "新建便签").build(app)?;
    let assistant_item = MenuItemBuilder::with_id("assistant", "AI 助手").build(app)?;
    // 开机自启动勾选状态：启动时读取真实开关（绕过插件在 Windows 上的缺陷）
    let autostart_enabled = autostart_is_enabled(app.handle());
    let autostart_item = CheckMenuItemBuilder::with_id("autostart", "开机自启动")
        .checked(autostart_enabled)
        .build(app)?;
    app.manage(TrayMenuState(std::sync::Mutex::new(Some(
        autostart_item.clone(),
    ))));
    let quit_item = MenuItemBuilder::with_id("quit", "退出").build(app)?;

    let menu = Menu::with_items(
        app,
        &[
            &show_item,
            &minimize_item,
            &hide_item,
            &new_item,
            &assistant_item,
            &PredefinedMenuItem::separator(app)?,
            &autostart_item,
            &PredefinedMenuItem::separator(app)?,
            &quit_item,
        ],
    )?;

    let _tray = TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().cloned().unwrap_or_else(|| {
            // 兜底：直接嵌入打包图标（正常情况 default_window_icon 已存在）
            tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))
                .expect("读取托盘图标失败")
        }))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                    // 显示兜底：窗口若被留在屏幕外/窄条尺寸，强制拉回可见区
                    correct_window_position(app, &window);
                    ensure_main_window_visible(&window);
                }
                // 通知前端把收纳窄条展开（未收纳时前端侧为空操作）
                let _ = app.emit("global:window-shown", ());
            }
            "hide" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            "minimize" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.minimize();
                }
            }
            "new" => {
                // 显示聚焦主窗口，由前端弹出「新建便签」类型选择弹窗
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                    correct_window_position(app, &window);
                }
                let _ = app.emit("tray:create-entry", ());
            }
            "assistant" => {
                // 显示聚焦主窗口，由前端打开 AI 助手面板
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                    correct_window_position(app, &window);
                }
                let _ = app.emit("tray:open-assistant", ());
            }
            "autostart" => {
                // 用真实状态判定（插件 is_enabled 在 Windows 非管理员下会因 HKLM 读权限抛错而失效）
                let target = !autostart_is_enabled(app);
                let result = if target {
                    app.autolaunch().enable()
                } else {
                    app.autolaunch().disable()
                };
                match result {
                    Ok(()) => {
                        // enable/disable 已落地，重新读取确认真实状态
                        let now_enabled = autostart_is_enabled(app);
                        // 同步菜单勾选状态
                        let state = app.state::<TrayMenuState>();
                        let guard = state.0.lock().unwrap();
                        if let Some(item) = guard.as_ref() {
                            let _ = item.set_checked(now_enabled);
                        }
                        // 回发前端设置页，刷新开关 Switch（与设置页→托盘方向相反，不会成环）
                        let _ = app.emit("autostart:changed", now_enabled);
                    }
                    Err(err) => {
                        // 写注册表失败（如权限不足）时如实记录，避免静默无反馈
                        eprintln!("切换开机自启动失败: {err}");
                    }
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            match event {
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } => {
                    // 单击分治：隐藏态由 Rust 直接唤起（前端未就绪/事件丢失时也保证窗口可见），
                    // 可见态交给前端判定——只有前端知道收纳态（隐藏/展开切换）
                    if let Some(window) = tray.app_handle().get_webview_window("main") {
                        let visible = window.is_visible().unwrap_or(false);
                        let minimized = window.is_minimized().unwrap_or(false);
                        if visible && !minimized {
                            let _ = tray.app_handle().emit("tray:toggle-main", ());
                        } else {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                            correct_window_position(tray.app_handle(), &window);
                            ensure_main_window_visible(&window);
                            let _ = tray.app_handle().emit("global:window-shown", ());
                        }
                    }
                }
                TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                } => {
                    if let Some(window) = tray.app_handle().get_webview_window("main") {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                        correct_window_position(tray.app_handle(), &window);
                        ensure_main_window_visible(&window);
                    }
                    // 通知前端把收纳窄条展开（未收纳时前端侧为空操作）
                    let _ = tray.app_handle().emit("global:window-shown", ());
                }
                _ => {}
            }
        })
        .build(app)?;

    Ok(())
}
