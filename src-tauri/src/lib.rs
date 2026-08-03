//! Watch Ticket · 应用装配入口。

mod akshare_client;
mod analyzer;
mod commands;
mod db;
mod error;
mod events;
mod indicators;
mod market_time;
mod models;
mod repo;
mod scheduler;
mod sidecar;
mod state;

use std::sync::Arc;
use std::time::Duration;

use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WindowEvent};
use tracing::{error, info};
use tracing_subscriber::EnvFilter;

use crate::akshare_client::AkClient;
use crate::state::AppState;

fn init_logging() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        EnvFilter::new("info,tauri_app_lib=debug,sidecar=debug")
    });
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(true)
        .try_init();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_logging();
    info!("Watch Ticket 启动");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let handle = app.handle().clone();

            let data_dir = handle
                .path()
                .app_data_dir()
                .map_err(|e| format!("获取 app_data_dir 失败: {}", e))?;

            let state = tauri::async_runtime::block_on(async {
                // 1) 启动 sidecar
                let sidecar =
                    crate::sidecar::spawn_sidecar(&handle, Duration::from_secs(30)).await?;
                let port = sidecar.port();
                info!("sidecar 就绪，port={}", port);

                // 2) 初始化 DB
                let (db, db_path) = crate::db::init_db(&data_dir).await?;
                info!("SQLite 初始化完成: {:?}", db_path);

                // 3) HTTP client
                let ak = Arc::new(AkClient::new(port)?);

                // 4) 启动调度器
                let scheduler = crate::scheduler::start(
                    handle.clone(),
                    db.clone(),
                    ak.clone(),
                );

                Ok::<AppState, crate::error::AppError>(AppState {
                    db,
                    db_path,
                    sidecar: Arc::new(sidecar),
                    ak,
                    scheduler: Arc::new(scheduler),
                })
            })
            .map_err(|e| {
                error!("初始化失败: {}", e);
                Box::<dyn std::error::Error>::from(e.to_string())
            })?;

            app.manage(state);

            // 构建系统托盘（Windows）
            // 菜单：关于（disabled，仅显示版本号） + 分隔线 + 退出
            let version = handle.package_info().version.to_string();
            let about_label = format!("关于 Watch Ticket v{}", version);
            let about_item = MenuItemBuilder::with_id("about", &about_label)
                .enabled(false)
                .build(&handle)?;
            let quit_item = MenuItemBuilder::with_id("quit", "退出").build(&handle)?;
            let sep = PredefinedMenuItem::separator(&handle)?;
            let tray_menu = MenuBuilder::new(&handle)
                .item(&about_item)
                .item(&sep)
                .item(&quit_item)
                .build()?;

            TrayIconBuilder::with_id("main-tray")
                .icon(handle.default_window_icon().cloned().unwrap())
                .tooltip("Watch Ticket · 行情监听")
                .menu(&tray_menu)
                // 左键单击时不弹菜单，交给下面的 on_tray_icon_event 处理
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "quit" => {
                        info!("托盘菜单：退出");
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // 左键单击：切换主窗口显示/隐藏
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            match window.is_visible() {
                                Ok(true) => {
                                    let _ = window.hide();
                                }
                                _ => {
                                    let _ = window.show();
                                    let _ = window.unminimize();
                                    let _ = window.set_focus();
                                }
                            }
                        }
                    }
                })
                .build(&handle)?;

            Ok(())
        })
        .on_window_event(|window, event| match event {
            // 关闭窗口时拦截：不真正销毁，而是隐藏到托盘
            WindowEvent::CloseRequested { api, .. } => {
                info!("窗口关闭请求：隐藏到系统托盘（非退出）");
                api.prevent_close();
                let _ = window.hide();
            }
            // 窗口被销毁（走托盘退出流程时才会到这里）：清理 sidecar
            WindowEvent::Destroyed => {
                if let Some(state) = window.try_state::<AppState>() {
                    state.sidecar.kill();
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            commands::sidecar_health,
            commands::get_quote,
            commands::get_kline,
            commands::search_symbol,
            commands::list_subscriptions,
            commands::add_subscription,
            commands::remove_subscription,
            commands::update_subscription_periods,
            commands::update_subscription_note,
            commands::get_cached_kline,
            commands::refresh_intraday,
            commands::list_settings,
            commands::update_setting,
            commands::get_setting,
            commands::list_alerts,
            commands::ack_alert,
            commands::ack_all_alerts,
            commands::count_unack_alerts,
            commands::clear_alerts,
            commands::analyze_symbol,
            commands::is_market_open,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
