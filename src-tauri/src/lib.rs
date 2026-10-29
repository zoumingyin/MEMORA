use tauri::menu::{CheckMenuItem, CheckMenuItemBuilder, Menu, MenuItemBuilder, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_global_shortcut::{Code, Modifiers, ShortcutState};
use tauri_plugin_sql::{Migration, MigrationKind};

/// 托盘菜单中的「开机自启动」勾选项：事件回调里通过 state 同步勾选状态
/// （TrayIcon 没有读取菜单的 API，只能保存引用后 set_checked）
struct TrayMenuState(std::sync::Mutex<Option<CheckMenuItem<tauri::Wry>>>);

/// 前端「退出应用」：绕过关闭拦截直接结束进程（点 X 的选择弹窗里触发）
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
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

/// 应用入口：注册插件（SQL / 通知 / 自启动 / 单实例）、执行数据库迁移、
/// 构建系统托盘菜单（显示/隐藏、新建便签、开机自启动开关、退出）、启动主窗口。
/// 透明度由前端 CSS 背景 alpha 控制（背景半透明、文字不透明），无需 Rust 自定义命令。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
    ];

    tauri::Builder::default()
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
                let _ = window.show();
                let _ = window.set_focus();
            }
            let _ = app.emit("app:second-instance", ());
        }))
        // 剪贴板：快速记录「从剪贴板创建」读取文本
        .plugin(tauri_plugin_clipboard_manager::init())
        // 文件对话框：数据导出 / 导入、数据库备份 / 恢复的文件选择
        .plugin(tauri_plugin_dialog::init())
        // 全局快捷键：Ctrl+Shift+N 在任何应用唤起快速记录输入框（选中文字后直接记录）
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed
                        && shortcut.matches(Modifiers::CONTROL | Modifiers::SHIFT, Code::KeyN)
                    {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                        let _ = app.emit("global:quick-capture", ());
                    }
                })
                .build(),
        )
        .setup(|app| {
            build_tray(app)?;
            // 注册全局快捷键 Ctrl+Shift+N：唤起快速记录
            {
                use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
                let shortcut =
                    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyN);
                if let Err(error) = app.global_shortcut().register(shortcut) {
                    eprintln!("注册全局快捷键失败: {error}");
                }
            }
            // 关闭拦截：点 X 时不直接退出，交由前端弹「最小化到后台 / 退出应用」选择
            if let Some(window) = app.get_webview_window("main") {
                let window_clone = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = window_clone.emit("window:close-requested", ());
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            quit_app,
            backup_db,
            restore_db,
            write_entries_json,
            read_entries_json
        ])
        .run(tauri::generate_context!())
        .expect("启动便签应用失败");
}

/// 构建系统托盘：图标 + 菜单（显示/隐藏主窗口、新建便签、开机自启动勾选、退出）。
/// 左键单击切换显示/隐藏，左键双击显示并聚焦。
fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let show_item = MenuItemBuilder::with_id("show", "显示主窗口").build(app)?;
    let hide_item = MenuItemBuilder::with_id("hide", "隐藏主窗口").build(app)?;
    let new_item = MenuItemBuilder::with_id("new", "新建便签").build(app)?;
    // 开机自启动勾选状态：启动时读取插件当前开关
    let autostart_enabled = app.autolaunch().is_enabled().unwrap_or(false);
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
            &hide_item,
            &new_item,
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
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "hide" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            "new" => {
                // 通知前端新建一条便签（主窗口若隐藏则一并显示聚焦）
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                let _ = app.emit("tray:new-note", ());
            }
            "autostart" => {
                let enabled = app.autolaunch().is_enabled().unwrap_or(false);
                let result = if enabled {
                    app.autolaunch().disable()
                } else {
                    app.autolaunch().enable()
                };
                if let Ok(now_enabled) = result.and_then(|_| app.autolaunch().is_enabled()) {
                    // 同步菜单勾选状态
                    let state = app.state::<TrayMenuState>();
                    let guard = state.0.lock().unwrap();
                    if let Some(item) = guard.as_ref() {
                        let _ = item.set_checked(now_enabled);
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
                    // 单击切换显示/隐藏
                    if let Some(window) = tray.app_handle().get_webview_window("main") {
                        if window.is_visible().unwrap_or(true) {
                            let _ = window.hide();
                        } else {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                }
                TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                } => {
                    if let Some(window) = tray.app_handle().get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                _ => {}
            }
        })
        .build(app)?;

    Ok(())
}
