"""
Watch Ticket · Python Sidecar 打包脚本。

用 PyInstaller 把 sidecar 打成 onedir 结构，输出到 src-tauri/binaries/
供 Tauri 通过 externalBin 打进 msi。

命名约定（Tauri 强制要求）：
    sidecar-<TARGET_TRIPLE>.exe
    Windows x64 就是 sidecar-x86_64-pc-windows-msvc.exe

用法：
    python python-sidecar/build.py
"""

from __future__ import annotations

import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent          # python-sidecar/
PROJECT_ROOT = ROOT.parent                       # 项目根
SRC_TAURI = PROJECT_ROOT / "src-tauri"
BINARIES_DIR = SRC_TAURI / "binaries"

SPEC_FILE = ROOT / "sidecar.spec"
DIST_DIR = ROOT / "dist"
BUILD_DIR = ROOT / "build"


def get_target_triple() -> str:
    """获取当前平台 Rust target triple；Tauri sidecar 命名需要它。"""
    machine = platform.machine().lower()
    system = platform.system().lower()

    if system == "windows":
        # Windows 上 machine 可能是 AMD64 / ARM64
        if machine in ("amd64", "x86_64"):
            return "x86_64-pc-windows-msvc"
        if machine in ("arm64", "aarch64"):
            return "aarch64-pc-windows-msvc"
    elif system == "darwin":
        return "aarch64-apple-darwin" if machine == "arm64" else "x86_64-apple-darwin"
    elif system == "linux":
        return "x86_64-unknown-linux-gnu"

    raise RuntimeError(f"不支持的平台: {system}/{machine}")


def clean() -> None:
    """清掉上次的构建产物，避免陈旧文件混入。"""
    for path in (DIST_DIR, BUILD_DIR):
        if path.exists():
            print(f"[clean] rm {path}")
            shutil.rmtree(path)


def run_pyinstaller() -> None:
    """调用 PyInstaller 走 spec 打包。"""
    cmd = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        str(SPEC_FILE),
    ]
    print("[pyinstaller]", " ".join(cmd))
    result = subprocess.run(cmd, cwd=ROOT)
    if result.returncode != 0:
        raise SystemExit(f"PyInstaller 失败，退出码 {result.returncode}")


def deploy_to_tauri(triple: str) -> None:
    """把 dist/sidecar/ 拷到 src-tauri/binaries/sidecar-<triple>/，
    并把入口 exe 重命名为 sidecar-<triple>.exe（Tauri 约定）。
    """
    dist_sidecar = DIST_DIR / "sidecar"
    if not dist_sidecar.exists():
        raise SystemExit(f"未生成产物: {dist_sidecar}")

    BINARIES_DIR.mkdir(parents=True, exist_ok=True)

    # 目标目录：src-tauri/binaries/sidecar-<triple>/
    target_dir = BINARIES_DIR / f"sidecar-{triple}"
    if target_dir.exists():
        print(f"[deploy] 清理旧目录 {target_dir}")
        shutil.rmtree(target_dir)
    shutil.copytree(dist_sidecar, target_dir)

    # 入口 exe：PyInstaller onedir 下叫 sidecar.exe → 重命名成 sidecar-<triple>.exe
    src_exe = target_dir / "sidecar.exe"
    dst_exe = target_dir / f"sidecar-{triple}.exe"
    if src_exe.exists():
        src_exe.rename(dst_exe)
        print(f"[deploy] 入口 exe -> {dst_exe.name}")
    elif dst_exe.exists():
        print(f"[deploy] 入口 exe 已就绪: {dst_exe.name}")
    else:
        raise SystemExit(f"未找到入口 exe: {src_exe}")

    print(f"[deploy] OK -> {target_dir}")


def main() -> None:
    triple = get_target_triple()
    print(f"[info] target triple = {triple}")

    if not SPEC_FILE.exists():
        raise SystemExit(f"缺少 spec 文件: {SPEC_FILE}")

    os.chdir(ROOT)
    clean()
    run_pyinstaller()
    deploy_to_tauri(triple)
    print("[done] sidecar 打包完成。可执行 `pnpm tauri build --bundles msi` 出 msi。")


if __name__ == "__main__":
    main()
