/**
 * 应用自动更新封装（基于 tauri-plugin-updater）。
 *
 * 流程：
 *   check() → 返回 Update | null
 *   有 Update 时调用 update.downloadAndInstall((event) => ...) 拿进度
 *   安装完成后调用 relaunch() 重启应用
 *
 * 语义：
 *   - "silent" 模式：无网络或未发现更新时不打扰用户
 *   - "manual" 模式：点击"检查更新"触发，无论结果都反馈
 */

import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export interface UpdateProgress {
  /** 已下载字节 */
  downloaded: number;
  /** 总字节，若服务器未返回则为 undefined */
  contentLength?: number;
  /** 阶段：started / downloading / finished */
  phase: "started" | "downloading" | "finished";
}

/** 检查是否有可用更新。失败时抛异常（由调用方决定是否吞掉）。 */
export async function checkForUpdate(): Promise<Update | null> {
  const update = await check();
  if (!update) return null;
  return update;
}

/** 下载并安装更新，安装完自动重启应用。 */
export async function downloadAndInstall(
  update: Update,
  onProgress?: (p: UpdateProgress) => void,
): Promise<void> {
  let downloaded = 0;
  let contentLength: number | undefined;

  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":
        contentLength = event.data.contentLength ?? undefined;
        onProgress?.({ downloaded: 0, contentLength, phase: "started" });
        break;
      case "Progress":
        downloaded += event.data.chunkLength;
        onProgress?.({ downloaded, contentLength, phase: "downloading" });
        break;
      case "Finished":
        onProgress?.({
          downloaded,
          contentLength,
          phase: "finished",
        });
        break;
    }
  });

  // 安装完成后重启应用（Windows msi passive 模式下会先退出再拉起）
  await relaunch();
}
