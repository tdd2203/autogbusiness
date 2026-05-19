/**
 * Định kỳ fetch /ui-labels/bundle về chrome.storage.local — content script đọc
 * từ đó (sync) lúc dispatch action.
 *
 * Trigger:
 *   - SW boot / onInstalled / onStartup → refresh ngay
 *   - chrome.alarms LABELS_REFRESH_ALARM mỗi 15 phút
 *   - Khi config (api key) thay đổi → refresh
 */

import {
  fetchLabelBundle,
  postLabelMismatch,
  saveBundleToStorage,
  type UiLabelLocale,
  type UiLabelPage,
} from "../shared/ui-labels";
import { getConfig } from "../shared/storage";

const ALARM = "autogpt-labels-refresh";
// Defensive: 2 phút thay vì 15 phút cũ — admin sửa DB qua Settings phải thấy
// thay đổi nhanh ngay cả khi dashboard tab không mở (không gọi được message
// "refresh-labels" tức thì). 2 phút vẫn an toàn về quota API (1 GET nhẹ).
const REFRESH_INTERVAL_MIN = 2;

export async function refreshLabelBundle(): Promise<void> {
  const config = await getConfig();
  if (!config) return;
  try {
    const bundle = await fetchLabelBundle(config);
    await saveBundleToStorage(bundle);
    console.log(
      `[autogpt-labels] refreshed bundle v${bundle.version} (${Object.keys(bundle.labels).length} locales)`,
    );
  } catch (e) {
    console.warn("[autogpt-labels] refresh failed", e);
  }
}

export function setupLabelsRefreshAlarm(): void {
  chrome.alarms.create(ALARM, {
    delayInMinutes: 0.2,
    periodInMinutes: REFRESH_INTERVAL_MIN,
  });
}

export function isLabelsAlarm(name: string): boolean {
  return name === ALARM;
}

export async function handleLabelMismatchReport(body: {
  locale: UiLabelLocale;
  page: UiLabelPage;
  control_key: string;
  expected?: string;
  dom_sample?: string;
}): Promise<void> {
  const config = await getConfig();
  if (!config) return;
  try {
    await postLabelMismatch(config, body);
    console.log(
      `[autogpt-labels] reported mismatch ${body.locale}/${body.page}/${body.control_key}`,
    );
  } catch (e) {
    console.warn("[autogpt-labels] report mismatch failed", e);
  }
}
