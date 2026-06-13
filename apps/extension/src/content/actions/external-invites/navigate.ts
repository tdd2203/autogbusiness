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

export async function navigateTo(
  pathname: string,
  predicate: () => boolean,
  timeoutMs = 10_000,
): Promise<boolean> {
  if (location.pathname !== pathname) {
    const link = findNavLinkByPath(pathname);
    if (link) {
      console.log(
        `[autogpt-external-invites] click <a href="${link.getAttribute("href")}"> ${location.pathname} → ${pathname}`,
      );
      link.click();
    } else {
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
