# Watch Ticket · 发布与自动更新指南

本项目使用 [`tauri-plugin-updater`](https://v2.tauri.app/plugin/updater/) 做自动更新，产物托管在 GitHub Releases。

## 一次性准备（发版前必做）

### 1. 生成 updater 签名密钥（本机执行一次即可）

```bash
# 交互式提示输入密码保护私钥
pnpm tauri signer generate -w ~/.tauri/watch-ticket.key
```

命令会输出：
- 私钥文件 `~/.tauri/watch-ticket.key`（保管好，不要提交）
- 公钥字符串（形如 `dW50cnVzdGVkIGNvbW1lbnQ6...`）

### 2. 写入公钥到项目

打开 `src-tauri/tauri.conf.json`，把 `plugins.updater.pubkey` 的占位符 `__PUBKEY_PLACEHOLDER__` 替换为上一步输出的公钥字符串。

### 3. 替换 endpoint 里的仓库地址

同一文件 `plugins.updater.endpoints`：

```json
"https://github.com/OWNER/REPO/releases/latest/download/latest.json"
```

将 `OWNER/REPO` 替换为你的 GitHub `<用户名>/<仓库名>`。

### 4. 配置 GitHub Repo Secrets

在 GitHub 仓库 → Settings → Secrets and variables → Actions → New repository secret 中新增：

| Secret Name | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | 私钥文件 `~/.tauri/watch-ticket.key` 的**全部内容** |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 生成密钥时输入的密码 |

`GITHUB_TOKEN` 由 Actions 自动注入，无需手动配置。

---

## 发版流程

1. 修改版本号（**两处必须同步**）：
   - `src-tauri/tauri.conf.json` → `version`
   - `package.json` → `version`

2. 提交并推 tag：
   ```bash
   git add -A
   git commit -m "chore: release v0.2.0"
   git tag v0.2.0
   git push origin main --tags
   ```

3. GitHub Actions 自动跑 `.github/workflows/release.yml`：
   - 编译 Windows msi
   - 用私钥签名生成 `.msi.sig`
   - 生成 `latest.json`（updater manifest）
   - 全部上传到 Release `v0.2.0`

4. 客户端下次启动会自动检测到该版本并弹更新提示。

---

## 客户端更新行为

- **启动时**：静默调用 `check()`，有新版才弹 `UpdateDialog`；无网络/无新版都不打扰。
- **手动**：顶部工具栏的 <kbd>🔄</kbd> 按钮触发，无论结果都反馈 toast。
- **安装模式**：`passive`（msi 有进度条、无交互），装完自动 `relaunch()`。

---

## 已知限制 / 待办

### ⚠️ Python sidecar 打包尚未接入

当前 `src-tauri/tauri.conf.json` 没有配置 `bundle.externalBin`，`python-sidecar/build.py` 也不存在。

**后果**：`v0.1.0` 打出的 msi 装到干净机器上会因为找不到 sidecar 而启动失败。

**跟进方案**（后续 PR）：
1. 写 `python-sidecar/build.py`，用 PyInstaller 打成 `sidecar-x86_64-pc-windows-msvc.exe`
2. `tauri.conf.json` 加：
   ```json
   "bundle": {
     "externalBin": ["binaries/sidecar"]
   }
   ```
3. 修改 `src-tauri/src/sidecar.rs`，release 模式下从 `tauri::api::process::Command::new_sidecar("sidecar")` 拉起
4. 在 `.github/workflows/release.yml` 里放开 sidecar 构建段落

---

## 本地验证（不发版）

```bash
# 打 msi 到 src-tauri/target/release/bundle/msi/
pnpm tauri build --bundles msi

# 只想跑更新链路本地调试（不签名，不推荐）
# 需临时把 tauri.conf.json 的 plugins.updater.active 改为 false
```

---

## 排错

| 症状 | 原因 | 解决 |
|---|---|---|
| 客户端启动不弹更新 | endpoint 里的 OWNER/REPO 未替换，或 Release 未 public | 检查 `tauri.conf.json`；仓库/Release 需公开可访问 |
| CI 报 "TAURI_SIGNING_PRIVATE_KEY not set" | Secrets 未配置 | 参考"一次性准备 → 4" |
| 更新时报 "signature verification failed" | 客户端 pubkey 与打包时 privkey 不匹配 | 检查 `tauri.conf.json` 的 pubkey 是否为签名密钥对应公钥 |
| msi 装不上 / 提示"来自未知发布者" | msi 未做 Authenticode 代码签名 | 与 updater 签名无关；如需消除警告需另购代码签名证书 |
