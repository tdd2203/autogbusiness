import { humanType, querySelectorFirst, sleep, waitFor } from "../../human";
import { SELECTORS } from "../../selectors";
import { findMemberRow } from "../member-row";

/**
 * Tìm input "Lọc theo tên" trên tab Người dùng /admin/members.
 * UI 2026 có ô search filter list — dùng để zoom thẳng vào row cần xoá thay
 * vì scroll qua hết list (failmode khi list > 50 row).
 */
export function findMemberFilterInput(): HTMLInputElement | null {
  return querySelectorFirst<HTMLInputElement>(SELECTORS.memberFilterInput);
}

/**
 * Filter list xuống chỉ còn row khớp email, rồi đợi DOM render xong.
 * Trả về row tìm được, hoặc null nếu hết timeout vẫn không có row khớp.
 *
 * Nếu không tìm được filter input → fallback scroll-find theo cách cũ
 * (findMemberRow trực tiếp trên DOM hiện tại).
 */
/** Đếm số row member đang hiển thị (debug). */
function visibleRowCount(): number {
  return document.querySelectorAll(
    'tr[data-testid^="member-row"], table tbody tr, [role="row"]',
  ).length;
}

export async function filterAndFindRow(email: string): Promise<HTMLElement | null> {
  // Tab mới (v0.8.13: mỗi action mở /admin/members MỚI) → content chạy NGAY khi
  // trang vừa load, ô lọc có thể CHƯA render → tra 1 lần sẽ null → fast-path bị bỏ
  // qua oan, rớt xuống scroll-scan chậm/ồn. POLL chờ ô lọc render tới 8s rồi mới
  // kết luận "không có ô lọc". Cùng lớp render-wait như clickTabAndWait
  // (waitForButtonMs) — nhưng cho ô lọc thay vì nút tab.
  let input = findMemberFilterInput();
  if (!input) {
    try {
      input = await waitFor(() => findMemberFilterInput(), 8000, 250);
    } catch {
      input = null;
    }
  }
  if (!input) {
    console.warn(
      "[autogpt-locate] KHÔNG tìm được ô lọc sau 8s — fallback scroll-find",
    );
    return findMemberRow(email);
  }
  console.log(
    `[autogpt-locate] ô lọc OK (placeholder="${input.placeholder}"), tìm ${email}`,
  );

  // Gõ CHÍNH XÁC email ĐẦY ĐỦ (user 2026-07-13: không gõ nửa (local-part) rồi gõ
  // full = 2 lần tra, tốn thời gian). ChatGPT "Filter by name" match cả email.
  //
  // FALSE-NEGATIVE OAN (user report 2026-07-21: "đồng bộ mấy lần vẫn còn pending
  // dù đã tham gia thật"): tab admin ChatGPT chạy NỀN (runner mở active:false) →
  // Chrome THROTTLE timer tab nền ~1000ms → chuỗi event `input` khi gõ ô lọc THI
  // THOẢNG bị nuốt/gộp → fetch server-side KHÔNG kích hoạt → list không bao giờ
  // hiện row trong cửa sổ chờ → báo "không có row" oan (member đã active). Bằng
  // chứng DB: cùng batch sync lại sau ~90s thì mọi email ra 'active'. Chờ LÂU HƠN
  // vô ích (đã chờ ~4.7s vẫn miss) — phải GÕ LẠI để kích hoạt lại fetch. Nên: thử
  // tối đa 2 lần, mỗi lần clear + gõ lại; chỉ kết luận null sau khi cả 2 lần miss.
  const ATTEMPTS = 2;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt > 0) {
      // Query lần trước có thể đã bị throttle nuốt → clear + gõ lại để kích hoạt
      // lại fetch lọc (chứ không chờ dài thêm — chờ không cứu được query bị nuốt).
      await clearMemberFilter();
      await sleep(400);
    }
    await humanType(input, email);
    await sleep(600); // chờ React Query / debounce filter
    console.log(
      `[autogpt-locate] đã lọc "${email}" (lần ${attempt + 1}/${ATTEMPTS}) → ${visibleRowCount()} row hiển thị`,
    );
    try {
      const row = await waitFor(() => findMemberRow(email), 3000, 200);
      if (row) {
        console.log(
          `[autogpt-locate] ✓ thấy row sau khi lọc "${email}" (lần ${attempt + 1})`,
        );
        return row;
      }
    } catch {
      console.warn(
        `[autogpt-locate] lọc "${email}" lần ${attempt + 1} không ra row`,
      );
    }
  }
  console.warn(
    `[autogpt-locate] lọc "${email}" MISS sau ${ATTEMPTS} lần gõ lại → coi như không có ở tab này`,
  );
  return null;
}

/**
 * Clear filter input để list về trạng thái ban đầu sau khi xoá xong.
 * Best-effort — không throw nếu input đã unmount.
 */
export async function clearMemberFilter(): Promise<void> {
  try {
    const input = findMemberFilterInput();
    if (!input) return;
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    nativeSetter?.call(input, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  } catch (e) {
    console.warn("[autogpt-remove] clear filter failed:", e);
  }
}
