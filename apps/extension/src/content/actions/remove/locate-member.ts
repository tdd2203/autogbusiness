import { humanClick, sleep } from "../../human";
import { findMemberRow } from "../member-row";
import {
  findPaginationState,
  goToFirstPage,
  isDisabled,
  MAX_PAGINATION_PAGES,
} from "../sync/pagination";
import {
  clearMemberFilter,
  filterAndFindRow,
  findMemberFilterInput,
} from "./member-filter";

/**
 * Gom các scroll-container khả dĩ (window + inner div overflow) — list member
 * của ChatGPT có khi scroll bằng window, có khi bằng div con virtualized.
 */
function collectScrollContainers(): Array<HTMLElement | Window> {
  const containers: Array<HTMLElement | Window> = [window];
  document.querySelectorAll<HTMLElement>("div, main, section").forEach((el) => {
    const s = window.getComputedStyle(el);
    if (
      (s.overflowY === "auto" || s.overflowY === "scroll") &&
      el.scrollHeight > el.clientHeight + 100
    ) {
      containers.push(el);
    }
  });
  return containers;
}

/**
 * Scroll qua list của TRANG hiện tại, kiểm tra row khớp email sau mỗi nấc.
 * Trả row ngay khi thấy; null nếu scroll hết (chiều cao ổn định) mà không thấy.
 * Xử lý virtualized list — row chỉ render khi nằm trong/đến gần viewport.
 *
 * Export để các action khác trên list virtualized (vd revoke tab "Lời mời")
 * tái dùng — chúng không cần lọc/phân trang như members tab nhưng vẫn phải
 * scroll để render row ngoài viewport.
 */
export async function scrollScanForRow(email: string): Promise<HTMLElement | null> {
  const containers = collectScrollContainers();

  // Về đầu list trước khi quét.
  for (const c of containers) {
    if (c === window) window.scrollTo({ top: 0, behavior: "auto" });
    else (c as HTMLElement).scrollTop = 0;
  }
  await sleep(250);

  let stable = 0;
  let lastH = -1;
  for (let i = 0; i < 200; i++) {
    const hit = findMemberRow(email);
    if (hit) return hit;

    for (const c of containers) {
      if (c === window) {
        window.scrollBy({ top: window.innerHeight * 0.8, behavior: "auto" });
      } else {
        const el = c as HTMLElement;
        el.scrollTop += el.clientHeight * 0.8;
      }
    }
    await sleep(250 + Math.floor(Math.random() * 150));

    const innerMax = containers
      .filter((c): c is HTMLElement => c !== window)
      .reduce((mx, el) => Math.max(mx, el.scrollHeight), 0);
    const h = Math.max(document.body.scrollHeight, innerMax);
    if (h === lastH) {
      stable += 1;
      if (stable >= 3) break; // chiều cao không đổi 3 nấc → đã chạm đáy
    } else {
      stable = 0;
      lastH = h;
    }
  }
  return findMemberRow(email);
}

/**
 * Định vị row của member một cách BỀN VỮNG:
 *   1. Thử ô lọc (fast path) — list ngắn hoặc filter hoạt động tốt.
 *   2. Không thấy → (mặc định) clear lọc, về trang 1, rồi lật từng trang +
 *      scroll-scan (đúng cách SYNC duyệt hết member). Xử lý list dài / phân
 *      trang / virtualized mà ô lọc bỏ sót.
 *
 * `opts.pageThrough`: bật/tắt bước (2). REMOVE truyền `false` — ô lọc là nguồn
 * sự thật: search không ra email thì coi như không có ở tab Người dùng, DỪNG
 * ngay, không lật trang (yêu cầu user 2026-06-21). Các action khác
 * (change-role / change-license / sync-member) vẫn lật trang như cũ.
 *
 * `opts.preferFilter`: BẮT BUỘC dùng ô tìm kiếm làm nguồn sự thật (bỏ qua nhánh
 * "1 trang → scroll-scan"). Dùng cho ĐỒNG BỘ kiểm-tra-đã-tham-gia: tab "Người
 * dùng" của ChatGPT là list VIRTUALIZED (150+ member, không có thanh phân trang →
 * findPaginationState()=null) nên scroll-scan CHỈ thấy vài row đầu (gần đỉnh) →
 * bỏ sót member ở giữa/cuối → báo "chưa tham gia" oan (user report 2026-07-15:
 * "check 6 email nhưng chỉ đúng 1"). Ô "Lọc theo tên" của ChatGPT lọc server-side
 * theo cả email → luôn hiện đúng row nếu member có, bất kể virtualized. Chỉ
 * scroll-scan khi KHÔNG có ô lọc.
 *
 * Trả row, hoặc null nếu không tìm thấy.
 */
export async function locateMemberRow(
  email: string,
  opts: { pageThrough?: boolean; preferFilter?: boolean } = {},
): Promise<HTMLElement | null> {
  const { pageThrough = true, preferFilter = false } = opts;

  // preferFilter: ô tìm kiếm là nguồn sự thật (list lớn virtualized). Có ô lọc →
  // dùng nó; không có mới đành scroll-scan.
  if (preferFilter) {
    if (findMemberFilterInput()) return filterAndFindRow(email);
    console.warn(
      "[autogpt-locate] preferFilter nhưng KHÔNG có ô lọc → scroll-scan (best effort)",
    );
    return scrollScanForRow(email);
  }

  // 1 TRANG (không có thanh phân trang) → KHỎI lọc, quét thẳng vị trí (user
  // 2026-07-13). List 1 trang thì scroll-scan phủ hết & tránh lỗi ô lọc (row sau
  // lọc re-render menu thiếu, filter bỏ sót…). Nhiều trang mới cần lọc để rút gọn.
  if (findPaginationState() === null) {
    console.log(
      "[autogpt-locate] tab Người dùng chỉ 1 trang → quét vị trí trực tiếp (bỏ lọc)",
    );
    return scrollScanForRow(email);
  }

  // Fast path: ô lọc.
  const viaFilter = await filterAndFindRow(email);
  if (viaFilter) return viaFilter;

  if (!pageThrough) {
    console.warn(
      `[autogpt-locate] ô lọc không ra ${email} → DỪNG (không lật trang theo yêu cầu)`,
    );
    return null;
  }

  // Fallback: duyệt toàn bộ list như SYNC. Clear lọc để list về đầy đủ trước.
  console.warn(
    `[autogpt-locate] ô lọc không ra ${email} → lật từng trang + scroll-scan`,
  );
  await clearMemberFilter();
  await sleep(300);
  await goToFirstPage();

  for (let page = 0; page < MAX_PAGINATION_PAGES; page++) {
    const hit = await scrollScanForRow(email);
    if (hit) {
      console.log(`[autogpt-locate] ✓ thấy ${email} ở trang ${page + 1}`);
      return hit;
    }
    console.log(`[autogpt-locate] trang ${page + 1}: chưa thấy ${email}`);

    const state = findPaginationState();
    const nextBtn = state?.nextButton ?? null;
    if (
      !nextBtn ||
      isDisabled(nextBtn) ||
      (state != null && state.current >= state.total)
    ) {
      break; // hết trang
    }
    await humanClick(nextBtn);
    await sleep(800); // chờ trang sau render
  }

  return null;
}
