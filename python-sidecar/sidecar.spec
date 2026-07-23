# -*- mode: python ; coding: utf-8 -*-
# Watch Ticket · Sidecar PyInstaller spec.
# onedir 模式：启动快、Defender 误报少；产物在 dist/sidecar/ 下。
#
# 关键点：
#   - akshare 依赖庞大，hiddenimports 列出常见动态导入以防 ModuleNotFoundError
#   - datas 收集 akshare/curl_cffi 内部的静态资源（json/csv/证书）
#   - uvicorn 的 loop/http/lifespan 实现走动态导入，需要显式包含
#
# 如果打完 exe 运行时报 "No module named XXX"，把 XXX 加进 hiddenimports 重打即可。

from PyInstaller.utils.hooks import (
    collect_all,
    collect_submodules,
    collect_data_files,
)

hiddenimports = []
datas = []
binaries = []


def _add(pkg):
    d, b, h = collect_all(pkg)
    datas.extend(d)
    binaries.extend(b)
    hiddenimports.extend(h)


# 数据源核心
_add("akshare")
_add("curl_cffi")

# fastapi / uvicorn 及其动态实现
_add("uvicorn")
hiddenimports += [
    "uvicorn.logging",
    "uvicorn.lifespan.on",
    "uvicorn.lifespan.off",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.http.httptools_impl",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.protocols.websockets.wsproto_impl",
    "uvicorn.protocols.websockets.websockets_impl",
    "uvicorn.loops.auto",
    "uvicorn.loops.asyncio",
]

# 数据处理常见动态导入
hiddenimports += collect_submodules("pandas")
hiddenimports += [
    "numpy",
    "openpyxl",
    "lxml",
    "lxml.etree",
    "html5lib",
    "bs4",
    "jsonpath",
    "mini_racer",
    "tabulate",
    "requests",
    "urllib3",
    "certifi",
    "charset_normalizer",
    "idna",
]

datas += collect_data_files("certifi")


block_cipher = None


a = Analysis(
    ["main.py"],
    pathex=["."],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # 减小体积：这些是开发/测试用，不需要
        "tkinter",
        "matplotlib",
        "IPython",
        "jupyter",
        "notebook",
        "pytest",
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="sidecar",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,           # UPX 会引起 Defender 误报，禁用
    console=True,        # 保留 console：Rust 端用 CREATE_NO_WINDOW 隐藏，且需要 stdout 传 ready 事件
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="sidecar",
)
