//! SQLite 数据库初始化与迁移。

use std::path::{Path, PathBuf};

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::SqlitePool;
use tracing::info;

use crate::error::{AppError, AppResult};

pub const DB_FILENAME: &str = "watch_ticket.db";

/// 初始化数据库：建目录 → 建连接池 → 跑 migration。
pub async fn init_db(data_dir: &Path) -> AppResult<(SqlitePool, PathBuf)> {
    std::fs::create_dir_all(data_dir).map_err(AppError::Io)?;
    let db_path = data_dir.join(DB_FILENAME);
    info!("初始化 SQLite: {:?}", db_path);

    let options = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .foreign_keys(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await?;

    // migration：把 migrations/ 目录下的 sql 编译进二进制并按序执行
    sqlx::migrate!("./migrations").run(&pool).await?;

    Ok((pool, db_path))
}

/// 快速健康检查：SELECT 1
pub async fn ping(pool: &SqlitePool) -> AppResult<()> {
    let _: (i64,) = sqlx::query_as("SELECT 1").fetch_one(pool).await?;
    Ok(())
}
