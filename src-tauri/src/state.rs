//! 全局 App 状态：由 Tauri 的 `manage` 注入，命令中通过 `State<AppState>` 拿到。

use std::path::PathBuf;
use std::sync::Arc;

use sqlx::SqlitePool;

use crate::akshare_client::AkClient;
use crate::scheduler::Scheduler;
use crate::sidecar::SidecarHandle;

pub struct AppState {
    pub db: SqlitePool,
    pub db_path: PathBuf,
    pub sidecar: Arc<SidecarHandle>,
    pub ak: Arc<AkClient>,
    pub scheduler: Arc<Scheduler>,
}
