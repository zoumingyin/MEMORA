use tauri::menu::{
    CheckMenuItem, CheckMenuItemBuilder, Menu, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Listener, Manager, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_global_shortcut::{Code, Modifiers, ShortcutState};
use tauri_plugin_sql::{Migration, MigrationKind};

mod ai;
mod db_safety;
// pub 仅为让 examples/search_probe.rs 直接调用 ai_web_search 做端到端验证
pub mod web_search;

/// 托盘菜单中的「开机自启动」勾选项：事件回调里通过 state 同步勾选状态
/// （TrayIcon 没有读取菜单的 API，只能保存引用后 set_checked）
struct TrayMenuState(std::sync::Mutex<Option<CheckMenuItem<tauri::Wry>>>);

/// 托盘「主题」子菜单的三个勾选项：单选语义靠互斥 set_checked 实现，
/// 状态由前端广播的 theme:changed 回灌（前端是主题唯一真源）。
struct TrayThemeState(std::sync::Mutex<Vec<(String, CheckMenuItem<tauri::Wry>)>>);

/// 前端 theme:changed 广播载荷（只取 mode，resolved 由前端自行解析）
#[derive(serde::Deserialize)]
struct ThemeChangedPayload {
    mode: String,
}

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

/// DWM 斗篷开关：斗篷期间 DWM 不合成该窗口（比 hide/show 轻量——
/// 不改 WS_VISIBLE、不丢焦点、不触发 WebView2 重绘问题）。
/// 用于启动防白屏与收纳缩窗防白边两处。
#[cfg(windows)]
fn apply_window_cloak(window: &tauri::WebviewWindow, cloaked: bool) -> Result<(), String> {
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

#[cfg(not(windows))]
fn apply_window_cloak(_window: &tauri::WebviewWindow, _cloaked: bool) -> Result<(), String> {
    Ok(())
}

/// WebView2 默认对 getUserMedia 的设备权限请求静默拒绝，语音输入的麦克风
/// 在此订阅 PermissionRequested 自动放行；系统级隐私开关仍由 Windows 设置约束。
/// 仅主窗口需要（QuickCapture 与 AI 助手都在主窗口内）。
#[cfg(windows)]
fn grant_webview_microphone(window: &tauri::WebviewWindow) {
    let _ = window.with_webview(|webview| {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
            COREWEBVIEW2_PERMISSION_STATE_ALLOW, ICoreWebView2_4,
        };
        use windows::core::Interface;

        let controller = webview.controller();
        let Ok(core) = (unsafe { controller.CoreWebView2() }) else {
            return;
        };
        let Ok(core4) = core.cast::<ICoreWebView2_4>() else {
            return;
        };
        let handler = webview2_com::PermissionRequestedEventHandler::create(Box::new(
            |_sender, args| {
                if let Some(args) = args {
                    let mut kind = COREWEBVIEW2_PERMISSION_KIND(0);
                    if unsafe { args.PermissionKind(&mut kind) }.is_ok()
                        && kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE
                    {
                        let _ = unsafe {
                            args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)
                        };
                    }
                }
                Ok(())
            },
        ));
        let mut token: i64 = 0;
        let _ = unsafe { core4.add_PermissionRequested(&handler, &mut token) };
    });
}

#[cfg(not(windows))]
fn grant_webview_microphone(_window: &tauri::WebviewWindow) {}

/// 前端调用：启动就绪后揭开窗口 / 收纳缩窗时临时斗篷
#[tauri::command]
fn set_window_cloaked(window: tauri::WebviewWindow, cloaked: bool) -> Result<(), String> {
    apply_window_cloak(&window, cloaked)
}

/// 启动页进度：只记录真实到达的里程碑，供晚加载的启动页回放
#[derive(Clone, serde::Serialize)]
struct SplashState {
    progress: f64,
    status: String,
    error: Option<String>,
}

impl Default for SplashState {
    fn default() -> Self {
        Self {
            progress: 0.0,
            status: "正在启动…".to_string(),
            error: None,
        }
    }
}

struct SplashProgress(std::sync::Mutex<SplashState>);

/// 启动页窗口标签（与 tauri.conf.json / src/window/splash.ts 一致）
const SPLASH_LABEL: &str = "splash";

fn splash_emit(app: &tauri::AppHandle, state: &SplashState) {
    let _ = app.emit_to(SPLASH_LABEL, "splash:state", state.clone());
}

/// 推进到某个真实里程碑；进度只增不减，避免并行里程碑让进度条回退
fn splash_advance(app: &tauri::AppHandle, progress: f64, status: &str) {
    let state = app.state::<SplashProgress>();
    let mut guard = state.0.lock().unwrap();
    if guard.error.is_some() || progress < guard.progress {
        return;
    }
    guard.progress = progress;
    guard.status = status.to_string();
    splash_emit(app, &guard);
}

/// 前端调用：报告真实初始化里程碑（界面 bundle 就绪 / 开始读库等）
#[tauri::command]
fn splash_report(app: tauri::AppHandle, progress: f64, status: String) {
    splash_advance(&app, progress, &status);
}

/// 关闭启动页并把焦点交还主窗口；窗口已销毁时静默跳过
fn close_splash(app: &tauri::AppHandle) {
    if let Some(splash) = app.get_webview_window(SPLASH_LABEL) {
        let _ = splash.close();
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.set_focus();
    }
}

/// 前端调用：主窗口首帧就绪后收尾。error 非空时保留启动页展示失败原因，
/// 由用户点「关闭」或兜底线程收场，不让错误一闪而过。
#[tauri::command]
fn splash_finish(app: tauri::AppHandle, error: Option<String>) {
    match error {
        Some(message) => {
            let state = app.state::<SplashProgress>();
            let mut guard = state.0.lock().unwrap();
            guard.status = "启动未完成".to_string();
            guard.error = Some(message);
            splash_emit(&app, &guard);
        }
        None => {
            {
                let state = app.state::<SplashProgress>();
                let mut guard = state.0.lock().unwrap();
                if guard.error.is_some() {
                    return;
                }
                guard.progress = 1.0;
                guard.status = "准备就绪".to_string();
                splash_emit(&app, &guard);
            }
            close_splash(&app);
        }
    }
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

/// 图片预览数据中转：base64 图片常有数 MB，超过 WebView localStorage 的 5MB 配额；
/// 主窗口先按 key 写入内存，预览窗口加载后取走，既不经过 URL 也不用本地存储。
#[derive(Default)]
struct ImagePreviewRelay(std::sync::Mutex<Vec<(String, String)>>);

/// 在途预览上限：仅用于丢弃「窗口没加载完就被关掉」的残留，正常路径取走即释放
const IMAGE_PREVIEW_RELAY_KEEP: usize = 8;

#[tauri::command]
fn set_image_preview_payload(state: tauri::State<ImagePreviewRelay>, key: String, payload: String) {
    let mut guard = state.0.lock().unwrap();
    guard.retain(|(existing, _)| existing != &key);
    guard.push((key, payload));
    while guard.len() > IMAGE_PREVIEW_RELAY_KEEP {
        guard.remove(0);
    }
}

#[tauri::command]
fn take_image_preview_payload(
    state: tauri::State<ImagePreviewRelay>,
    key: String,
) -> Option<String> {
    let mut guard = state.0.lock().unwrap();
    let index = guard.iter().position(|(existing, _)| existing == &key)?;
    Some(guard.remove(index).1)
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

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutoBackupConfig {
    enabled: bool,
    /// 用户自定义镜像目录（如网盘同步文件夹）；None 时仅备份到应用数据目录
    #[serde(default)]
    custom_dir: Option<String>,
}

impl Default for AutoBackupConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            custom_dir: None,
        }
    }
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

fn save_backup_config(app: &tauri::AppHandle, config: &AutoBackupConfig) -> Result<(), String> {
    let path = backup_config_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("创建配置目录失败：{error}"))?;
    }
    std::fs::write(
        path,
        serde_json::to_string_pretty(config).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("保存备份设置失败：{error}"))
}

/// 手动备份：VACUUM INTO 一致性快照 + 校验 + `.json` 元数据
#[tauri::command]
async fn backup_db(
    app: tauri::AppHandle,
    dest_path: String,
    gate: tauri::State<'_, db_safety::DbGateState>,
) -> Result<db_safety::BackupMetadata, String> {
    if db_safety::gate_snapshot(&gate).status != "ready" {
        return Err("数据库当前处于只读保护状态，无法备份".to_string());
    }
    db_safety::create_backup(&app, std::path::Path::new(&dest_path), "manual").await
}

/// 恢复数据库：前端须先关闭所有 SQLite 连接；后端负责校验、快照与原子替换
#[tauri::command]
async fn restore_db(
    app: tauri::AppHandle,
    src_path: String,
    gate: tauri::State<'_, db_safety::DbGateState>,
) -> Result<db_safety::RestoreResult, String> {
    db_safety::restore_database(&app, src_path, &gate).await
}

#[tauri::command]
fn auto_backup_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, db_safety::AutoBackupState>,
) -> Result<db_safety::AutoBackupStatus, String> {
    let config = load_backup_config(&app);
    Ok(db_safety::auto_backup_status(
        &app,
        config.enabled,
        config.custom_dir.as_deref(),
        &state,
    ))
}

#[tauri::command]
async fn set_auto_backup(
    app: tauri::AppHandle,
    enabled: bool,
    state: tauri::State<'_, db_safety::AutoBackupState>,
) -> Result<db_safety::AutoBackupStatus, String> {
    // 只改开关，保留已配置的镜像目录
    let mut config = load_backup_config(&app);
    config.enabled = enabled;
    save_backup_config(&app, &config)?;
    if enabled {
        if let Err(error) =
            db_safety::run_daily_backup(&app, true, config.custom_dir.as_deref(), &state).await
        {
            *state.0.lock().unwrap() = Some(error.clone());
            return Err(error);
        }
    }
    Ok(db_safety::auto_backup_status(
        &app,
        enabled,
        config.custom_dir.as_deref(),
        &state,
    ))
}

/// 设置 / 清除每日备份的镜像目录（如网盘同步文件夹，实现异地备份）。
/// Some(dir)：校验目录可写后保存；None：清除。
#[tauri::command]
async fn set_backup_dir(
    app: tauri::AppHandle,
    dir: Option<String>,
    state: tauri::State<'_, db_safety::AutoBackupState>,
) -> Result<db_safety::AutoBackupStatus, String> {
    if let Some(path) = &dir {
        let target = std::path::Path::new(path);
        std::fs::create_dir_all(target).map_err(|error| format!("创建目录失败：{error}"))?;
        // 可写探测：写删一个探针文件
        let probe = target.join(".bianqian-write-test");
        std::fs::write(&probe, b"ok")
            .and_then(|_| std::fs::remove_file(&probe))
            .map_err(|error| format!("目录不可写：{error}"))?;
    }
    let mut config = load_backup_config(&app);
    config.custom_dir = dir;
    save_backup_config(&app, &config)?;
    if config.enabled {
        if let Err(error) =
            db_safety::run_daily_backup(&app, true, config.custom_dir.as_deref(), &state).await
        {
            *state.0.lock().unwrap() = Some(error.clone());
        }
    }
    Ok(db_safety::auto_backup_status(
        &app,
        config.enabled,
        config.custom_dir.as_deref(),
        &state,
    ))
}

#[tauri::command]
async fn run_auto_backup_now(
    app: tauri::AppHandle,
    state: tauri::State<'_, db_safety::AutoBackupState>,
) -> Result<db_safety::AutoBackupStatus, String> {
    let config = load_backup_config(&app);
    match db_safety::run_backup_now(&app, config.enabled, config.custom_dir.as_deref(), &state)
        .await
    {
        Ok(status) => Ok(status),
        Err(error) => {
            *state.0.lock().unwrap() = Some(error.clone());
            Err(error)
        }
    }
}

#[tauri::command]
fn db_gate_status(gate: tauri::State<'_, db_safety::DbGateState>) -> db_safety::DbGateStatus {
    db_safety::gate_snapshot(&gate)
}

#[tauri::command]
fn db_gate_migration_complete(gate: tauri::State<'_, db_safety::DbGateState>) {
    db_safety::mark_migration_complete(&gate, db_safety::SCHEMA_VERSION);
}

/// 前端加载/迁移失败：尝试回退到迁移前备份，失败则保持只读保护
#[tauri::command]
async fn db_gate_load_failed(
    app: tauri::AppHandle,
    gate: tauri::State<'_, db_safety::DbGateState>,
    message: String,
) -> Result<db_safety::DbGateStatus, String> {
    let had_backup = db_safety::gate_snapshot(&gate).pre_migration_backup.is_some();
    if had_backup {
        match db_safety::recover_pre_migration_backup(&app, &gate).await {
            Ok(_) => {
                db_safety::mark_load_failed(
                    &gate,
                    "数据库迁移失败，已回退到迁移前备份；请重启应用后重试。",
                );
                return Ok(db_safety::gate_snapshot(&gate));
            }
            Err(error) => {
                db_safety::mark_load_failed(
                    &gate,
                    &format!("数据库迁移失败，且自动回退失败：{error}。原始错误：{message}"),
                );
                return Ok(db_safety::gate_snapshot(&gate));
            }
        }
    }
    db_safety::mark_load_failed(&gate, &format!("数据库加载失败：{message}"));
    Ok(db_safety::gate_snapshot(&gate))
}

#[tauri::command]
async fn db_gate_retry(
    app: tauri::AppHandle,
    gate: tauri::State<'_, db_safety::DbGateState>,
) -> Result<db_safety::DbGateStatus, String> {
    Ok(db_safety::retry_gate(&app, &gate).await)
}

async fn run_startup_auto_backup(app: tauri::AppHandle) {
    let config = load_backup_config(&app);
    if !config.enabled {
        return;
    }
    let gate = app.state::<db_safety::DbGateState>();
    if db_safety::gate_snapshot(&gate).status != "ready" {
        return;
    }
    let auto = app.state::<db_safety::AutoBackupState>();
    if let Err(error) = db_safety::run_daily_backup(&app, true, config.custom_dir.as_deref(), &auto)
        .await
    {
        *auto.0.lock().unwrap() = Some(error);
    }
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

pub(crate) fn database_migrations() -> Vec<Migration> {
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
        Migration {
            version: 8,
            description: "add agent execution history tables (records + real tool steps)",
            kind: MigrationKind::Up,
            sql: r#"
CREATE TABLE IF NOT EXISTS agent_executions (
  id             TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  message_id     TEXT NOT NULL,
  request_id     TEXT NOT NULL,
  title          TEXT NOT NULL,
  user_input     TEXT NOT NULL,
  status         TEXT NOT NULL,
  phase          TEXT NOT NULL,
  started_at     INTEGER NOT NULL,
  finished_at    INTEGER,
  duration_ms    INTEGER,
  tool_count     INTEGER NOT NULL DEFAULT 0,
  success_count  INTEGER NOT NULL DEFAULT 0,
  failed_count   INTEGER NOT NULL DEFAULT 0,
  skipped_count  INTEGER NOT NULL DEFAULT 0,
  summary        TEXT,
  failure_json   TEXT,
  error_message  TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_executions_request ON agent_executions(request_id);
CREATE INDEX IF NOT EXISTS idx_agent_executions_started ON agent_executions(started_at);
CREATE INDEX IF NOT EXISTS idx_agent_executions_status ON agent_executions(status);

CREATE TABLE IF NOT EXISTS agent_execution_steps (
  id             TEXT PRIMARY KEY,
  execution_id   TEXT NOT NULL,
  ordinal        INTEGER NOT NULL,
  tool_call_id   TEXT NOT NULL,
  tool_name      TEXT NOT NULL,
  label          TEXT NOT NULL,
  status         TEXT NOT NULL,
  started_at     INTEGER,
  finished_at    INTEGER,
  duration_ms    INTEGER,
  effect_json    TEXT,
  failure_json   TEXT,
  targets_json   TEXT,
  input_summary  TEXT,
  output_summary TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_steps_execution ON agent_execution_steps(execution_id, ordinal);
"#,
        },
        Migration {
            version: 9,
            description: "link delete confirmation steps to one-time proposals",
            kind: MigrationKind::Up,
            sql: r#"
ALTER TABLE agent_execution_steps ADD COLUMN proposal_id TEXT;
"#,
        },
        Migration {
            version: 10,
            description: "add optimistic version to entries",
            kind: MigrationKind::Up,
            sql: r#"
ALTER TABLE entries ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
"#,
        },
    ];
    migrations
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

    let migrations = database_migrations();

    tauri::Builder::default()
        // AI 助手请求取消标记（跨命令共享）
        .manage(ai::AiState::default())
        // 主窗口最后可见位置：hide→show 循环位置漂移的校正基准
        .manage(LastWindowPos(std::sync::Mutex::new(None)))
        // 启动页进度：真实里程碑的当前值，供晚加载的启动页回放
        .manage(SplashProgress(std::sync::Mutex::new(SplashState::default())))
        // 图片预览数据中转：绕过 localStorage 5MB 配额
        .manage(ImagePreviewRelay::default())
        // 数据库启动闸门：迁移前备份与只读保护状态
        .manage(db_safety::DbGateState(std::sync::Mutex::new(
            db_safety::DbGateStatus::default(),
        )))
        .manage(db_safety::AutoBackupState::default())
        .plugin(tauri_plugin_notification::init())
        // 在线升级：检查更新 / 下载签名安装包 / 重启安装（密钥与端点见 tauri.conf.json plugins.updater）
        .plugin(tauri_plugin_updater::Builder::new().build())
        // 配套 relaunch：安装完更新后重启应用
        .plugin(tauri_plugin_process::init())
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
                        .matches(Modifiers::CONTROL | Modifiers::SHIFT, Code::KeyF)
                    {
                        // 全局快捷搜索（Spotlight）：主窗口常驻托盘，由前端监听该事件
                        // 负责搜索窗口的显示/隐藏切换与数据快照下发
                        let _ = app.emit("global:spotlight", ());
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
            // 数据库启动闸门：必须在任何数据库连接（包括插件迁移）之前完成
            // 只读检查 → 迁移前一致性备份 → 校验，失败则进入只读保护
            {
                let gate = app.state::<db_safety::DbGateState>();
                tauri::async_runtime::block_on(db_safety::prepare_gate(app.handle(), &gate));
            }
            // 启动页兜底：前端异常/卡死时不让启动页永久挡住主窗口
            // （正常路径由前端 splash_finish 关闭；失败路径留出阅读错误的时间）
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(20));
                    if handle.get_webview_window(SPLASH_LABEL).is_some() {
                        close_splash(&handle);
                    }
                });
                let replay_handle = std::sync::Arc::new(app.handle().clone());
                replay_handle.listen("splash:ready", {
                    let handle = replay_handle.clone();
                    move |_| {
                        let state = handle.state::<SplashProgress>();
                        let guard = state.0.lock().unwrap();
                        splash_emit(&handle, &guard);
                    }
                });
            }
            build_tray(app)?;
            splash_advance(app.handle(), 0.3, "正在准备系统托盘…");
            // 启动防闪屏：无装饰+阴影窗口在 WebView2 首帧合成前，DWM 会按未初始化
            // 表面绘出一帧白屏（Win11 上尤甚）；且窗口默认位置与前端恢复的保存位置
            // 不同，直接显示会先白屏再跳位。这里创建后立即斗篷再显示——斗篷期间
            // DWM 不合成窗口，前端恢复位置、完成首帧渲染后揭开（set_window_cloaked
            // false），用户看到的就是最终位置上的完整界面，无白屏无跳变。
            // 5 秒兜底自动揭开：前端资源异常/加载卡死时不至于永久不可见
            if let Some(window) = app.get_webview_window("main") {
                let _ = apply_window_cloak(&window, true);
                let _ = window.show();
                // 语音输入前置：WebView2 默认拒绝麦克风权限，此处自动放行
                grant_webview_microphone(&window);
                let fallback_window = window.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(5));
                    let _ = apply_window_cloak(&fallback_window, false);
                });
            }
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
            // 主题广播回灌托盘勾选：前端（设置页 / 托盘 / 系统跟随）任一路径改了主题，
            // 菜单勾选都据此同步，Rust 侧不自己维护主题状态
            let theme_handle = std::sync::Arc::new(app.handle().clone());
            theme_handle.listen("theme:changed", {
                let handle = theme_handle.clone();
                move |event| {
                    let Ok(payload) =
                        serde_json::from_str::<ThemeChangedPayload>(event.payload())
                    else {
                        return;
                    };
                    let state = handle.state::<TrayThemeState>();
                    let guard = state.0.lock().unwrap();
                    for (mode, item) in guard.iter() {
                        let _ = item.set_checked(mode == &payload.mode);
                    }
                }
            });
            // 每日自动备份：后台执行，失败写入设置页可见状态，不阻塞启动
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    run_startup_auto_backup(handle).await;
                });
            }
            // 注册全局快捷键 Ctrl+Shift+N：唤起快速记录
            {
                use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
                let shortcut =
                    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyN);
                if let Err(error) = app.global_shortcut().register(shortcut) {
                    eprintln!("注册全局快捷键失败: {error}");
                }
                // Ctrl+Shift+F：全局快捷搜索（Spotlight 式小窗）
                let search = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyF);
                if let Err(error) = app.global_shortcut().register(search) {
                    eprintln!("注册全局快捷搜索快捷键失败: {error}");
                }
                // Ctrl+Shift+Space：显示 / 隐藏主窗口
                let toggle =
                    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space);
                if let Err(error) = app.global_shortcut().register(toggle) {
                    eprintln!("注册窗口显示/隐藏快捷键失败: {error}");
                }
            }
            splash_advance(app.handle(), 0.45, "正在准备后台服务…");
            // 关闭拦截：点 X / Alt+F4 不直接隐藏或退出，转发给前端按用户选择的
            // 退出语义处理（继续到托盘 / 退出并停止提醒 / 取消），避免静默退出
            if let Some(window) = app.get_webview_window("main") {
                let window_clone = window.clone();
                window.on_window_event(move |event| {
                    match event {
                        WindowEvent::CloseRequested { api, .. } => {
                            api.prevent_close();
                            let _ = window_clone.emit("app:close-requested", ());
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
            splash_report,
            splash_finish,
            backup_db,
            restore_db,
            write_entries_json,
            read_entries_json,
            write_image_file,
            auto_backup_status,
            set_auto_backup,
            set_backup_dir,
            run_auto_backup_now,
            db_gate_status,
            db_gate_migration_complete,
            db_gate_load_failed,
            db_gate_retry,
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
            ai::ai_transcribe,
            web_search::ai_web_search,
            get_autostart_enabled,
            get_system_theme,
            set_window_cloaked,
            set_image_preview_payload,
            take_image_preview_payload
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

/// 读取 Windows 应用主题（浅色 / 深色），供前端「跟随系统」模式解析。
///
/// 直接读 HKCU\...\Themes\Personalize\AppsUseLightTheme：这是系统设置的权威值。
/// WebView2 的 prefers-color-scheme 在部分版本上不随该键即时更新，只作前端快路径兜底。
/// 键不存在（Win10 早期版本）或读取被拒时按浅色处理，与系统默认一致。
#[tauri::command]
fn get_system_theme() -> String {
    #[cfg(windows)]
    {
        use windows_registry::CURRENT_USER;
        const PERSONALIZE_KEY: &str =
            r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";
        let use_light = CURRENT_USER
            .open(PERSONALIZE_KEY)
            .and_then(|key| key.get_u32("AppsUseLightTheme"))
            .unwrap_or(1);
        if use_light == 0 {
            "dark".to_string()
        } else {
            "light".to_string()
        }
    }
    #[cfg(not(windows))]
    {
        "light".to_string()
    }
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

    // 主题子菜单：三档互斥勾选。初始勾选按系统主题猜一个近似值，
    // 前端初始化后广播 theme:changed 会立即校正为真实持久化选择。
    let theme_light = CheckMenuItemBuilder::with_id("theme-light", "浅色").build(app)?;
    let theme_dark = CheckMenuItemBuilder::with_id("theme-dark", "深色").build(app)?;
    let theme_system = CheckMenuItemBuilder::with_id("theme-system", "跟随系统")
        .checked(true)
        .build(app)?;
    app.manage(TrayThemeState(std::sync::Mutex::new(vec![
        ("light".to_string(), theme_light.clone()),
        ("dark".to_string(), theme_dark.clone()),
        ("system".to_string(), theme_system.clone()),
    ])));
    let theme_menu = SubmenuBuilder::with_id(app, "theme", "主题")
        .items(&[&theme_light, &theme_dark, &theme_system])
        .build()?;

    let menu = Menu::with_items(
        app,
        &[
            &show_item,
            &minimize_item,
            &hide_item,
            &new_item,
            &assistant_item,
            &PredefinedMenuItem::separator(app)?,
            &theme_menu,
            &autostart_item,
            &PredefinedMenuItem::separator(app)?,
            &quit_item,
        ],
    )?;

    // 托盘走独立位图：窗口图标在 16px 任务栏上细节会糊
    let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))
        .expect("读取托盘图标失败");
    let _tray = TrayIconBuilder::with_id("main-tray")
        .icon(tray_icon)
        // 鼠标悬停提示：不设置时 Windows 托盘图标没有任何 tooltip
        .tooltip("MEMORA 便签")
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
            "theme-light" | "theme-dark" | "theme-system" => {
                // 主题真源在前端：这里只转发意图，由主窗口落盘并广播到全部窗口
                let mode = event.id.as_ref().trim_start_matches("theme-");
                let _ = app.emit("tray:set-theme", mode);
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
