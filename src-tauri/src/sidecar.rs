//! Python Sidecar 启动与生命周期管理。
//!
//! 两种模式：
//!   - **Release / 打包**：从 Tauri resource_dir 加载 PyInstaller 打包好的
//!     `sidecar/sidecar-<triple>.exe`（onedir 结构，同目录带一堆运行时依赖）。
//!   - **Dev**：直接调用 `python-sidecar/.venv/Scripts/python.exe python-sidecar/main.py`。
//!
//! 优先级：resource_dir 里的打包产物 > 环境变量指定 > dev venv。
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
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;
use tracing::{debug, info, warn};

use crate::error::{AppError, AppResult};

#[derive(Debug, Deserialize)]
struct ReadyEvent {
    #[allow(dead_code)]
    event: String,
    port: u16,
}

// =============== Windows Job Object：主进程死时连带杀 sidecar ===============
//
// 原理：把 sidecar 进程加入一个 Job Object（设置 KILL_ON_JOB_CLOSE），
// 只要主进程持有 job handle 直到退出。主进程无论正常/崩溃/被强杀，
// Windows 关闭 handle 时会自动 kill 掉 job 里的所有进程。
//
// 参考：https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
#[cfg(windows)]
mod job {
    use std::mem;
    use std::os::windows::io::{AsRawHandle, RawHandle};
    use std::ptr;

    use tracing::{info, warn};
    use winapi::shared::minwindef::FALSE;
    use winapi::um::handleapi::CloseHandle;
    use winapi::um::jobapi2::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
    };
    use winapi::um::winnt::{
        JobObjectExtendedLimitInformation, HANDLE, JOBOBJECT_BASIC_LIMIT_INFORMATION,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// 封装 job handle，Drop 时关闭（关闭 = 触发 kill-on-job-close）。
    pub struct JobHandle(HANDLE);

    // HANDLE 是 *mut c_void，Rust 默认不认为它 Send。
    // 我们只在自有线程用；显式实现 Send 是安全的。
    unsafe impl Send for JobHandle {}
    unsafe impl Sync for JobHandle {}

    impl JobHandle {
        pub fn as_raw(&self) -> HANDLE {
            self.0
        }
    }

    impl Drop for JobHandle {
        fn drop(&mut self) {
            unsafe {
                if !self.0.is_null() {
                    // 关闭 handle 会因为 KILL_ON_JOB_CLOSE 触发批量 kill
                    CloseHandle(self.0);
                }
            }
        }
    }

    /// 创建一个已配置好 KILL_ON_JOB_CLOSE 的 Job Object。
    pub fn create_kill_on_close_job() -> Result<JobHandle, String> {
        unsafe {
            let job = CreateJobObjectW(ptr::null_mut(), ptr::null());
            if job.is_null() {
                return Err("CreateJobObjectW 返回 NULL".to_string());
            }

            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = mem::zeroed();
            let mut basic: JOBOBJECT_BASIC_LIMIT_INFORMATION = mem::zeroed();
            basic.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            info.BasicLimitInformation = basic;

            let ok = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &mut info as *mut _ as *mut _,
                mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == FALSE {
                CloseHandle(job);
                return Err("SetInformationJobObject 失败".to_string());
            }

            Ok(JobHandle(job))
        }
    }

    /// 把一个已启动的进程加入 job。process_handle 从 child.as_raw_handle() 取。
    pub fn assign_to_job(job: &JobHandle, process_handle: RawHandle) -> Result<(), String> {
        unsafe {
            let ok = AssignProcessToJobObject(job.as_raw(), process_handle as HANDLE);
            if ok == FALSE {
                return Err("AssignProcessToJobObject 失败".to_string());
            }
            Ok(())
        }
    }

    /// 便捷组合：为已 spawn 出来的 child 创建 job 并加入。
    pub fn wrap_child_in_job(child: &std::process::Child) -> Option<JobHandle> {
        match create_kill_on_close_job() {
            Ok(job) => match assign_to_job(&job, child.as_raw_handle()) {
                Ok(()) => {
                    info!("sidecar 已加入 Job Object（主进程死亡将连带清理）");
                    Some(job)
                }
                Err(e) => {
                    warn!("sidecar 加入 Job Object 失败: {}（不影响 sidecar 启动，但主进程崩溃时可能残留孤儿）", e);
                    None
                }
            },
            Err(e) => {
                warn!("创建 Job Object 失败: {}（不影响 sidecar 启动，但主进程崩溃时可能残留孤儿）", e);
                None
            }
        }
    }
}

/// 已启动的 sidecar 句柄。Drop 时自动终止子进程。
pub struct SidecarHandle {
    pub port: u16,
    child: Arc<Mutex<Option<Child>>>,
    /// Windows 上持有 Job Object handle；drop 时关闭 = 触发 kill-on-job-close
    /// 非 Windows 平台字段不存在
    #[cfg(windows)]
    #[allow(dead_code)]
    _job: Option<job::JobHandle>,
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

/// 当前平台的 Rust target triple；用于定位 `sidecar-<triple>.exe`。
fn current_target_triple() -> &'static str {
    if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "x86_64-pc-windows-msvc"
    } else if cfg!(all(target_os = "windows", target_arch = "aarch64")) {
        "aarch64-pc-windows-msvc"
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "x86_64-apple-darwin"
    } else if cfg!(target_os = "linux") {
        "x86_64-unknown-linux-gnu"
    } else {
        "unknown"
    }
}

/// 查找 Tauri 资源目录里打包好的 sidecar exe。
///
/// 结构（打包后）：
///     <resource_dir>/sidecar/sidecar-<triple>.exe
///     <resource_dir>/sidecar/_internal/...          (PyInstaller onedir 依赖)
///
/// tauri.conf.json 里 `bundle.resources` 把源目录
/// `binaries/sidecar-<triple>/` 整个映射到 `sidecar/`，保留内部结构。
fn locate_bundled_sidecar(app: &AppHandle) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok()?;
    let triple = current_target_triple();
    let exe_name = if cfg!(windows) {
        format!("sidecar-{}.exe", triple)
    } else {
        format!("sidecar-{}", triple)
    };
    let candidate = resource_dir.join("sidecar").join(&exe_name);
    if candidate.exists() {
        Some(candidate)
    } else {
        debug!("bundled sidecar 不存在: {:?}", candidate);
        None
    }
}

/// dev 模式：查找本地 python venv + main.py。
///
/// 优先级：
///   1. 环境变量 `WATCH_TICKET_SIDECAR_PYTHON` + `WATCH_TICKET_SIDECAR_MAIN`（显式指定）
///   2. `<workspace>/python-sidecar/.venv/Scripts/python.exe` + `<workspace>/python-sidecar/main.py`
fn locate_dev_sidecar() -> AppResult<(PathBuf, PathBuf)> {
    if let (Ok(py), Ok(main)) = (
        std::env::var("WATCH_TICKET_SIDECAR_PYTHON"),
        std::env::var("WATCH_TICKET_SIDECAR_MAIN"),
    ) {
        return Ok((PathBuf::from(py), PathBuf::from(main)));
    }

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
        "找不到 python-sidecar。cwd={:?}，请设置 WATCH_TICKET_SIDECAR_PYTHON/MAIN 或安装 .venv",
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
/// 拉起策略：优先 bundled（release）→ 再 dev venv。
///
/// * `startup_timeout` 首行输出的等待时长；超时视为启动失败。
pub async fn spawn_sidecar(
    app: &AppHandle,
    startup_timeout: Duration,
) -> AppResult<SidecarHandle> {
    // 启动优先级：
    //   - Debug（pnpm tauri dev）：优先 dev python 源码，找不到才降级 bundled exe
    //     这样修改 Python 代码后重启 tauri dev 即可生效，不需要重新打包 sidecar
    //   - Release（打包版）：优先 bundled exe，找不到才降级 dev
    //     保证发布版本用 PyInstaller 产物，用户机器无需 Python 环境
    let mut cmd = if cfg!(debug_assertions) {
        // Debug 分支：先试 dev
        match locate_dev_sidecar() {
            Ok((python, main_py)) => {
                info!("启动 dev sidecar（debug 模式优先）: {:?} {:?}", python, main_py);
                let mut c = Command::new(python);
                c.arg(main_py);
                c
            }
            Err(dev_err) => match locate_bundled_sidecar(app) {
                Some(exe) => {
                    warn!(
                        "dev sidecar 不可用（{}），降级用 bundled: {:?}",
                        dev_err, exe
                    );
                    Command::new(exe)
                }
                None => return Err(dev_err),
            },
        }
    } else {
        // Release 分支：先试 bundled
        if let Some(exe) = locate_bundled_sidecar(app) {
            info!("启动 bundled sidecar: {:?}", exe);
            Command::new(exe)
        } else {
            let (python, main_py) = locate_dev_sidecar()?;
            info!("启动 dev sidecar（release 降级）: {:?} {:?}", python, main_py);
            let mut c = Command::new(python);
            c.arg(main_py);
            c
        }
    };

    cmd.arg("--port")
        .arg("0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::Sidecar(format!("spawn 失败: {}", e)))?;

    // Windows: 立即把 sidecar 加入 Job Object，
    // 保证主进程无论怎样退出（正常/崩溃/被 taskkill）都能连带杀掉 sidecar。
    #[cfg(windows)]
    let job_handle = job::wrap_child_in_job(&child);

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
        #[cfg(windows)]
        _job: job_handle,
    })
}
