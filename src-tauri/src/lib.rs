//! Watch Ticket · 应用装配入口。

mod akshare_client;
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

use tauri::Manager;
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
                    crate::sidecar::spawn_sidecar(Duration::from_secs(15)).await?;
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
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.try_state::<AppState>() {
                    state.sidecar.kill();
                }
            }
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
