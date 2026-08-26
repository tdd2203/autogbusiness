/**
 * Gắp số liệu SUẤT của lệnh mời NGOÀI TÊN MIỀN từ Phase A sang kết quả cuối.
 *
 * Lệnh mời email ngoài tên miền chạy HAI PHA (v0.8.14):
 *   - Phase A  — bật toggle "mời ngoài tên miền", ĐẾM/MUA SUẤT, rồi trả về
 *     `awaiting_external_reload` để background hard-reload trang;
 *   - Phase A' — gọi lại với `externalReady=true`, BỎ QUA hẳn bước suất và mở
 *     dialog mời thật sự.
 *
 * `response` của Phase A' GHI ĐÈ `response` của Phase A, nên nếu không gắp lại
 * thì mọi con số suất đọc/mua ở Phase A biến mất trước khi kết quả về backend.
 *
 * Ca thật 26/8/2026 — GPT1: lệnh mời mua bù 1 suất, ChatGPT lên 152 mà dashboard
 * vẫn đứng 151 suốt. Mọi lệnh mời của workspace này đều là email ngoài tên miền
 * ⇒ đều đi đường hai pha ⇒ `result` về backend TRẮNG mọi trường `seat_*` ⇒
 * `_absorb_seat_reading` không có gì để ghi. Tổng suất trên dashboard chỉ còn
 * trông vào SYNC_BILLING, mà cái đó không chạy sau mỗi lệnh mời.
 */

import type { ExecuteActionResponse } from "../shared/messages";

/**
 * Các trường `seat_*` trong `data` của một response.
 *
 * CHỈ lấy tiền tố `seat_`: `awaiting_external_reload` là cờ điều phối riêng của
 * Phase A, mang sang kết quả cuối là gửi cờ vô nghĩa (và dễ gây hiểu nhầm) về
 * backend.
 */
export function pickSeatFields(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (k.startsWith("seat_")) out[k] = v;
  }
  return out;
}

/**
 * Gắn thêm `extra` vào `response.data`.
 *
 * Khoá do response ĐÃ CÓ luôn thắng: Phase A' là lần chạy sau, nếu nó tự sinh ra
 * cùng tên khoá thì số của nó mới là số mới nhất.
 */
export function withExtraData(
  resp: ExecuteActionResponse,
  extra: Record<string, unknown>,
): ExecuteActionResponse {
  if (Object.keys(extra).length === 0) return resp;
  const cur = (resp as { data?: Record<string, unknown> }).data;
  return { ...resp, data: { ...extra, ...(cur ?? {}) } };
}
