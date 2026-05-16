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
