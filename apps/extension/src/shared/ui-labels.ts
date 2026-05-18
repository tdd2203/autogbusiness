/**
 * UI Labels — calibrate text ChatGPT mỗi 3 locale × 4 page.
 *
 * Flow:
 *   1. Background fetch /api/v1/ui-labels/bundle định kỳ, lưu vào chrome.storage.local.
 *   2. Content script load module này → đọc bundle vào memory cache (sync access).
 *   3. Actions gọi `dbLabelsFor(controlKey, page?)` → trả [label_text, aria_label]
 *      cho locale hiện tại; merge với TEXT_FALLBACKS để dùng làm input cho text search.
 *   4. Khi action không match được DOM dù DB có label → gọi `reportLabelMismatch()`
 *      qua chrome.runtime.sendMessage → background POST /report-mismatch để dashboard
 *      hiện banner stale.
 */

import type { ExtensionConfig } from "./types";
import { ApiError } from "./api";

export type UiLabelLocale = "vi" | "en" | "zh";
export type UiLabelPage =
  | "/admin/members"
  | "/admin/billing"
  | "/admin/billing?tab=invoices"
  | "/admin/identity";

export type UiLabelEntry = {
  label_text: string | null;
  aria_label: string | null;
  notes?: Record<string, unknown> | null;
  version: number;
  stale: boolean;
};

export type UiLabelBundle = {
  version: number;
  generated_at: string;
  labels: Record<string, Record<string, Record<string, UiLabelEntry>>>;
};

const STORAGE_KEY = "autogpt.uiLabels";

let cached: UiLabelBundle | null = null;

export async function loadBundleFromStorage(): Promise<UiLabelBundle | null> {
  const obj = await chrome.storage.local.get(STORAGE_KEY);
  cached = (obj[STORAGE_KEY] as UiLabelBundle | undefined) ?? null;
  return cached;
}

export async function saveBundleToStorage(bundle: UiLabelBundle): Promise<void> {
  cached = bundle;
  await chrome.storage.local.set({ [STORAGE_KEY]: bundle });
}

export function getCachedBundle(): UiLabelBundle | null {
  return cached;
}

export function normalizeLocale(raw: string | null | undefined): UiLabelLocale {
  const l = (raw ?? "").toLowerCase();
  if (l.startsWith("vi")) return "vi";
  if (l.startsWith("zh")) return "zh";
  return "en";
}

export function detectPageFromUrl(
  pathname: string,
  search: string,
): UiLabelPage | null {
  if (pathname.includes("/admin/members")) return "/admin/members";
  if (pathname.includes("/admin/billing")) {
    if (search.includes("tab=invoices")) return "/admin/billing?tab=invoices";
    return "/admin/billing";
  }
  if (pathname.includes("/admin/identity")) return "/admin/identity";
  return null;
}

/**
 * Trả về [label_text, aria_label] đã calibrate cho (locale hiện tại, page hiện
 * tại, controlKey). Dùng làm input cho text-search helpers.
 * Trả rỗng nếu chưa harvest hoặc bundle chưa load.
 */
export function dbLabelsFor(controlKey: string, page?: UiLabelPage): string[] {
  if (!cached) return [];
  const p =
    page ??
    detectPageFromUrl(
      typeof location !== "undefined" ? location.pathname : "",
      typeof location !== "undefined" ? location.search : "",
    );
  if (!p) return [];
  const locale = normalizeLocale(
    typeof document !== "undefined" ? document.documentElement.lang : "",
  );
  const entry = cached.labels?.[locale]?.[p]?.[controlKey];
  if (!entry) return [];
  const out: string[] = [];
  if (entry.label_text) out.push(entry.label_text);
  if (entry.aria_label && entry.aria_label !== entry.label_text) {
    out.push(entry.aria_label);
  }
  return out;
}

function parseJsonSafe(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // Backend trả non-JSON (5xx "Internal Server Error", proxy HTML, ...) —
    // không crash extension, trả lại raw text cho caller log.
    return { __raw__: text };
  }
}

export async function fetchLabelBundle(
  config: ExtensionConfig,
): Promise<UiLabelBundle> {
  const res = await fetch(`${config.apiBaseUrl}/api/v1/ui-labels/bundle`, {
    headers: { "X-API-KEY": config.apiKey },
  });
  const text = await res.text();
  const data = parseJsonSafe(text) as
    | UiLabelBundle
    | { __raw__: string }
    | { detail?: unknown }
    | undefined;
  if (!res.ok) {
    const detail =
      (data as { detail?: unknown })?.detail ??
      (data as { __raw__?: string })?.__raw__ ??
      res.statusText;
    throw new ApiError(res.status, detail);
  }
  if (data && "__raw__" in (data as Record<string, unknown>)) {
    throw new ApiError(
      res.status,
      `Bundle response không phải JSON: ${(data as { __raw__: string }).__raw__.slice(0, 200)}`,
    );
  }
  return data as UiLabelBundle;
}

export async function postLabelMismatch(
  config: ExtensionConfig,
  body: {
    locale: UiLabelLocale;
    page: UiLabelPage;
    control_key: string;
    expected?: string;
    dom_sample?: string;
  },
): Promise<void> {
  const res = await fetch(
    `${config.apiBaseUrl}/api/v1/ui-labels/report-mismatch`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": config.apiKey,
      },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok && res.status !== 202) {
    const text = await res.text();
    throw new ApiError(res.status, text || res.statusText);
  }
}

/**
 * Báo về background: action không match được DOM dù DB có label (hoặc DB rỗng
 * và muốn admin biết). Background gọi /report-mismatch.
 * Fire-and-forget — không await để không block action.
 */
export function reportLabelMismatch(
  controlKey: string,
  expected: string | undefined,
  page?: UiLabelPage,
): void {
  const p =
    page ??
    detectPageFromUrl(
      typeof location !== "undefined" ? location.pathname : "",
      typeof location !== "undefined" ? location.search : "",
    );
  if (!p) return;
  const locale = normalizeLocale(
    typeof document !== "undefined" ? document.documentElement.lang : "",
  );
  const sample =
    typeof document !== "undefined"
      ? (document.body?.innerText ?? "").slice(0, 800)
      : "";
  try {
    chrome.runtime.sendMessage({
      type: "report-label-mismatch",
      body: {
        locale,
        page: p,
        control_key: controlKey,
        expected,
        dom_sample: sample,
      },
    });
  } catch {
    // Background SW có thể đang sleep; bỏ qua, lần sau action fail lại sẽ retry.
  }
}
