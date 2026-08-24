/**
 * Sau khi runner ĐIỀU HƯỚNG một tab, làm sao biết message tiếp theo sẽ tới
 * content script của TRANG MỚI — chứ không phải trang cũ đang bị Chrome đóng băng?
 *
 * VÌ SAO CẦN (4 ca thật, 2 tháng, 1 lần mất tiền):
 * Mỗi lần mời email NGOÀI tên miền, runner buộc phải hard-navigate tab
 * (`chrome.tabs.update`) để ChatGPT nạp lại org-config với toggle "mời ngoài tên
 * miền" = ON — điều hướng SPA không làm nó refetch (xem chú thích v0.8.14 trong
 * `runner.ts`). Trang cũ khi đó bị đẩy vào **back/forward cache**: nó không chết,
 * nó ĐÓNG BĂNG — và Chrome đóng luôn mọi kênh message của nó:
 *
 *   "The page keeping the extension port is moved into back/forward cache,
 *    so the message channel is closed."
 *
 * `chrome.tabs.update()` chỉ RA LỆNH điều hướng rồi trả về ngay, còn
 * `waitForTabComplete` chỉ nghe `status === "complete"`. Giữa hai mốc đó có một
 * khe: `PING` có thể được TRANG CŨ trả lời (nó vẫn sống, vẫn có listener), runner
 * tưởng "content sẵn sàng" và gửi luôn lệnh mời vào đó. Content cũ mở dialog, gõ
 * email... rồi navigation commit, trang tụt vào bfcache, kênh đứt giữa chừng —
 * task chết mà không ai biết lời mời đã đi hay chưa.
 *
 * Bằng chứng trên production (`queue_items.progress`):
 *   2a5d6450 31/7: progress cuối `submit-done` → chết SAU cú bấm Gửi → hoàn 340k
 *                  OAN, hôm sau chủ hệ thống phải thu lại tay.
 *   e5c67d9e 24/8: progress cuối `typing-email` → chết trước khi bấm Gửi.
 * Cả 4 ca đều là email @gmail trong workspace `ndaigroup.*` — tức 100% đi qua
 * đúng nhánh hard-navigate này. Không phải xui ngẫu nhiên.
 *
 * CÁCH PHÂN BIỆT: mỗi lần content script khởi tạo, nó sinh một `loadId` mới và
 * trả kèm mọi `PING` (xem `content/index.ts`). Runner đọc `loadId` TRƯỚC khi điều
 * hướng, rồi chờ tới khi `PING` trả về một `loadId` KHÁC — đó mới là instance của
 * trang mới. Trang được phục hồi từ bfcache cũng bị bắt: nó sống lại với `loadId`
 * CŨ, nên vẫn bị coi là chưa sẵn sàng.
 *
 * Tách khỏi `runner.ts` để test được bằng dữ liệu thuần — cùng lý do với
 * `invite-salvage.ts` và `invite-outcome.ts`: đây là chỗ đã làm mất tiền thật.
 */

/** Kết quả chờ. `loadId` = instance đang trả lời (null nếu không ping được). */
export type FreshContentResult = {
  /** `true` ⇒ content script trả lời là instance MỚI, gửi lệnh được. */
  fresh: boolean;
  loadId: string | null;
  /** Vì sao không fresh — để log/chẩn đoán, không hiện cho người dùng. */
  reason: "fresh" | "same_load_id" | "no_answer" | "timeout";
};

export type WaitForFreshContentDeps = {
  /** Ping content script: trả `loadId`, hoặc null nếu không ai trả lời. */
  ping: () => Promise<string | null>;
  /** Mốc thời gian hiện tại (ms) — tiêm vào để test không phụ thuộc đồng hồ. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

/**
 * Chờ content script của TRANG MỚI trả lời.
 *
 * @param prevLoadId `loadId` đọc được TRƯỚC khi điều hướng. `null` = lúc đó không
 *   ping được ai (tab trắng / content chưa inject) → instance nào trả lời cũng
 *   tính là mới, vì không có trang cũ nào để lẫn.
 * @param timeoutMs hết giờ mà vẫn chỉ có instance cũ trả lời → `fresh: false`,
 *   caller phải inject lại hoặc bỏ cuộc — TUYỆT ĐỐI không gửi lệnh vào instance cũ.
 * @param pollMs nhịp ping.
 */
export async function waitForFreshContent(
  prevLoadId: string | null,
  timeoutMs: number,
  deps: WaitForFreshContentDeps,
  pollMs = 300,
): Promise<FreshContentResult> {
  const deadline = deps.now() + timeoutMs;
  let last: FreshContentResult = {
    fresh: false,
    loadId: null,
    reason: "no_answer",
  };
  for (;;) {
    const loadId = await deps.ping();
    if (loadId !== null && loadId !== prevLoadId) {
      return { fresh: true, loadId, reason: "fresh" };
    }
    last =
      loadId === null
        ? { fresh: false, loadId: null, reason: "no_answer" }
        : { fresh: false, loadId, reason: "same_load_id" };
    if (deps.now() + pollMs > deadline) {
      return { ...last, reason: last.reason === "no_answer" ? "timeout" : "same_load_id" };
    }
    await deps.sleep(pollMs);
  }
}
