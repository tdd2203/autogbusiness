/**
 * Content → background → backend progress reporting.
 *
 * Throttle 1 call/500ms để tránh spam endpoint khi scrape nhanh.
 */

export type ProgressInfo = {
  phase: string;
  current?: number;
  total?: number;
  message?: string;
  [k: string]: unknown;
};

let lastSentAt = 0;
const MIN_INTERVAL_MS = 500;

export async function reportProgress(
  taskId: string,
  progress: ProgressInfo,
  force = false,
): Promise<void> {
  const now = Date.now();
  if (!force && now - lastSentAt < MIN_INTERVAL_MS) return;
  lastSentAt = now;
  try {
    await chrome.runtime.sendMessage({ type: "task-progress", taskId, progress });
  } catch {
    // background SW có thể đang sleep; bỏ qua, lần next sẽ thử lại
  }
}
