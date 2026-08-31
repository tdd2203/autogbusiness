import type { ExtensionConfig } from "./types";

const KEY = "autogpt.config";

export async function getConfig(): Promise<ExtensionConfig | null> {
  const obj = await chrome.storage.local.get(KEY);
  return (obj[KEY] as ExtensionConfig | undefined) ?? null;
}

export async function setConfig(config: ExtensionConfig | null): Promise<void> {
  if (config) {
    await chrome.storage.local.set({ [KEY]: config });
  } else {
    await chrome.storage.local.remove(KEY);
  }
}

/**
 * Cấu hình để gọi API cho NHÁNH CANVA: cùng backend, khác khoá.
 *
 * Trả `null` khi máy này chưa nhập khoá Canva — nhánh ChatGPT vẫn chạy bình thường,
 * chỉ là không có gì để làm bên Canva. Trả về đúng hình dạng `ExtensionConfig` để
 * mọi hàm trong `shared/api.ts` dùng lại được nguyên vẹn, không phải chẻ đôi.
 */
export async function getCanvaConfig(): Promise<ExtensionConfig | null> {
  const config = await getConfig();
  if (!config?.canvaApiKey) return null;
  return { apiBaseUrl: config.apiBaseUrl, apiKey: config.canvaApiKey };
}
