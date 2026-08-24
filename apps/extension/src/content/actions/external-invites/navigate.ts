import { sleep } from "../../human";

/**
 * Navigate SPA tới pathname, đợi predicate trả truthy (page mới render xong).
 *
 * Ưu tiên click `<a href="{pathname}">` trong sidebar — Next.js router sẽ bắt
 * sự kiện click và navigate đúng cách (history.pushState alone nhiều khi không
 * trigger re-render). Fallback pushState + popstate nếu không tìm thấy anchor.
 */
function findNavLinkByPath(pathname: string): HTMLAnchorElement | null {
  const all = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"));
  // Khớp href tuyệt đối hoặc tương đối kết thúc bằng pathname (chấp nhận cả /xyz/ trailing)
  for (const a of all) {
    const href = a.getAttribute("href") ?? "";
    if (
      href === pathname ||
      href === pathname + "/" ||
      a.pathname === pathname ||
      a.pathname === pathname + "/"
    ) {
      return a;
    }
  }
  return null;
}

/**
 * `spaFirst`: THỬ `pushState` TRƯỚC, chỉ click `<a>` khi trang không chịu render.
 *
 * Dùng cho những chỗ điều hướng xảy ra khi content script đang giữ kênh với
 * background VÀ đã có việc không thể làm lại (đã trừ tiền mua suất). Click `<a>`
 * có thể là điều hướng THẬT (nếu ChatGPT dựng link thường chứ không phải link
 * client-side) — trang khi đó bị đẩy vào back/forward cache, kênh đứt, kết quả
 * không về được background: đúng chuỗi đã làm mất 340.000đ ngày 31/7/2026
 * (xem `background/content-ready.ts`). `pushState` thì KHÔNG bao giờ rời trang.
 *
 * Đánh đổi: nếu React không nghe `popstate` thì mất thêm `spaFirstMs` chờ vô ích
 * rồi mới click `<a>` như cũ — chậm hơn, nhưng không mất gì.
 */
export async function navigateTo(
  pathname: string,
  predicate: () => boolean,
  timeoutMs = 10_000,
  opts: { spaFirst?: boolean; spaFirstMs?: number } = {},
): Promise<boolean> {
  const { spaFirst = false, spaFirstMs = 3_000 } = opts;
  const needNav = location.pathname !== pathname;

  // spaFirst: đổi URL bằng pushState (KHÔNG rời trang) rồi chờ React render.
  // Được thì xong — không có cửa nào cho bfcache.
  let spaTried = false;
  if (needNav && spaFirst) {
    console.log(
      `[autogpt-external-invites] spaFirst: pushState ${location.pathname} → ${pathname} (không rời trang)`,
    );
    history.pushState({}, "", pathname);
    window.dispatchEvent(new PopStateEvent("popstate"));
    spaTried = true;
    const spaDeadline = Date.now() + Math.min(spaFirstMs, timeoutMs);
    while (Date.now() < spaDeadline) {
      if (predicate()) return true;
      await sleep(300);
    }
    console.log(
      `[autogpt-external-invites] spaFirst chưa render sau ${spaFirstMs}ms → dùng link như cũ`,
    );
  }

  // Đường cũ: click <a> sidebar (Next router bắt được thì client-nav, không thì
  // điều hướng thật). Chạy khi CHƯA thử spaFirst, hoặc thử rồi mà trang không render.
  if ((needNav && !spaTried) || (spaTried && !predicate())) {
    const link = findNavLinkByPath(pathname);
    if (link) {
      console.log(
        `[autogpt-external-invites] click <a href="${link.getAttribute("href")}"> ${location.pathname} → ${pathname}`,
      );
      link.click();
    } else if (!spaTried) {
      console.log(
        `[autogpt-external-invites] không tìm thấy sidebar link, pushState fallback ${location.pathname} → ${pathname}`,
      );
      history.pushState({}, "", pathname);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(500);
  }
  if (location.pathname !== pathname) {
    console.warn(
      `[autogpt-external-invites] nav timeout: vẫn ở ${location.pathname}, target ${pathname}`,
    );
  }
  return predicate();
}
