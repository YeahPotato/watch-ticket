//! 统一错误类型。前端拿到的都是可序列化的 { code, message }。

use serde::{Serialize, Serializer};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("sidecar error: {0}")]
    Sidecar(String),

    #[error("sidecar http error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("sidecar business error: code={code} msg={msg}")]
    SidecarBusiness { code: i32, msg: String },

    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),

    #[error("db migrate error: {0}")]
    Migrate(#[from] sqlx::migrate::MigrateError),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("tauri error: {0}")]
    Tauri(#[from] tauri::Error),

    #[error("{0}")]
    #[allow(dead_code)]
    Msg(String),
}

impl AppError {
    #[allow(dead_code)]
    pub fn msg<S: Into<String>>(s: S) -> Self {
        AppError::Msg(s.into())
    }
}

// 让 AppError 能通过 Tauri command 返回：序列化成 { code, message } 结构
impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let (code, message) = match self {
            AppError::SidecarBusiness { code, msg } => (*code, msg.clone()),
            other => (-1, other.to_string()),
        };
        let mut s = serializer.serialize_struct("AppError", 2)?;
        s.serialize_field("code", &code)?;
        s.serialize_field("message", &message)?;
        s.end()
    }
}

pub type AppResult<T> = Result<T, AppError>;
