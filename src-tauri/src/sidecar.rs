//! Python Sidecar 启动与生命周期管理。
//!
//! P3 阶段使用「开发模式」直接调用 `python-sidecar/.venv/Scripts/python.exe`，
//! P7 打包时再切换到从 tauri resource_dir 读取 PyInstaller 产物。
//!
//! 通信协议：
//!   - 启动 sidecar 时传 `--port 0` 让系统分配空闲端口
//!   - sidecar 会向 stdout 首行输出 `{"event":"ready","port":<n>}`
//!   - Rust 读取该行拿到端口，之后所有交互走 HTTP

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Deserialize;
use tokio::sync::oneshot;
use tracing::{debug, info, warn};

use crate::error::{AppError, AppResult};

#[derive(Debug, Deserialize)]
struct ReadyEvent {
    #[allow(dead_code)]
    event: String,
    port: u16,
}

/// 已启动的 sidecar 句柄。Drop 时自动终止子进程。
pub struct SidecarHandle {
    pub port: u16,
    child: Arc<Mutex<Option<Child>>>,
}

impl SidecarHandle {
    pub fn port(&self) -> u16 {
        self.port
    }

    /// 主动终止子进程；重复调用无副作用。
    pub fn kill(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
                info!("sidecar 子进程已终止");
            }
        }
    }
}

impl Drop for SidecarHandle {
    fn drop(&mut self) {
        self.kill();
    }
}

/// 定位 Python 解释器和 sidecar 脚本入口。
///
/// dev 模式查找顺序：
///   1. 环境变量 `WATCH_TICKET_SIDECAR_PYTHON` + `WATCH_TICKET_SIDECAR_MAIN`（显式指定）
///   2. `<workspace>/python-sidecar/.venv/Scripts/python.exe` + `<workspace>/python-sidecar/main.py`
///
/// `<workspace>` 是 `src-tauri` 的父目录（因为 tauri dev 的 cwd 是 `src-tauri/`）。
fn locate_sidecar() -> AppResult<(PathBuf, PathBuf)> {
    if let (Ok(py), Ok(main)) = (
        std::env::var("WATCH_TICKET_SIDECAR_PYTHON"),
        std::env::var("WATCH_TICKET_SIDECAR_MAIN"),
    ) {
        return Ok((PathBuf::from(py), PathBuf::from(main)));
    }

    // 从当前工作目录向上找 python-sidecar
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let candidates = [
        cwd.clone(),
        cwd.parent().map(Path::to_path_buf).unwrap_or(cwd.clone()),
    ];

    for base in &candidates {
        let sidecar_dir = base.join("python-sidecar");
        let py = if cfg!(windows) {
            sidecar_dir.join(".venv").join("Scripts").join("python.exe")
        } else {
            sidecar_dir.join(".venv").join("bin").join("python")
        };
        let main = sidecar_dir.join("main.py");
        if py.exists() && main.exists() {
            return Ok((py, main));
        }
    }

    Err(AppError::Sidecar(format!(
        "找不到 python-sidecar。cwd={:?}，请检查项目结构或设置 WATCH_TICKET_SIDECAR_PYTHON/MAIN",
        cwd
    )))
}

/// Windows 隐藏子进程黑窗口
#[cfg(windows)]
fn hide_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console(_cmd: &mut Command) {}

/// 拉起 sidecar 并等待其发出 ready 事件。
///
/// * `startup_timeout` 首行输出的等待时长；超时视为启动失败。
pub async fn spawn_sidecar(startup_timeout: Duration) -> AppResult<SidecarHandle> {
    let (python, main_py) = locate_sidecar()?;
    info!("启动 sidecar: {:?} {:?}", python, main_py);

    let mut cmd = Command::new(&python);
    cmd.arg(&main_py)
        .arg("--port")
        .arg("0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::Sidecar(format!("spawn 失败: {}", e)))?;

    // 拿到 stdout / stderr
    let stdout = child.stdout.take().ok_or_else(|| {
        AppError::Sidecar("无法获取 sidecar stdout".into())
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        AppError::Sidecar("无法获取 sidecar stderr".into())
    })?;

    // 用一个 oneshot 传递端口号；后台线程读 stdout 首行
    let (tx, rx) = oneshot::channel::<AppResult<u16>>();

    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut tx = Some(tx);
        for line in reader.lines() {
            match line {
                Ok(l) => {
                    // 只解析首个有效 JSON 行；之后的 stdout 转为普通日志
                    if let Some(sender) = tx.take() {
                        match serde_json::from_str::<ReadyEvent>(&l) {
                            Ok(evt) => {
                                info!("sidecar ready，port={}", evt.port);
                                let _ = sender.send(Ok(evt.port));
                            }
                            Err(e) => {
                                let _ = sender.send(Err(AppError::Sidecar(format!(
                                    "解析 ready 事件失败: {} 原文: {}",
                                    e, l
                                ))));
                            }
                        }
                    } else {
                        debug!(target: "sidecar", "{}", l);
                    }
                }
                Err(e) => {
                    warn!("sidecar stdout 读取错误: {}", e);
                    break;
                }
            }
        }
        debug!("sidecar stdout 流关闭");
    });

    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            debug!(target: "sidecar", "{}", line);
        }
    });

    // 用 tokio 超时等待
    let port = match tokio::time::timeout(startup_timeout, rx).await {
        Ok(Ok(res)) => res?,
        Ok(Err(_)) => {
            let _ = child.kill();
            return Err(AppError::Sidecar("sidecar 未发送 ready 事件".into()));
        }
        Err(_) => {
            let _ = child.kill();
            return Err(AppError::Sidecar(format!(
                "sidecar 启动超时（>{:?}）",
                startup_timeout
            )));
        }
    };

    Ok(SidecarHandle {
        port,
        child: Arc::new(Mutex::new(Some(child))),
    })
}
