import { sleep } from "../../human";

/**
 * Navigate SPA + verify pathname thực sự thay đổi.
 * Trả false nếu sau 6s vẫn chưa nav được → caller skip page đó.
 */
export async function navigateSpaVerified(
  pathname: string,
  search = "",
  timeoutMs = 6000,
): Promise<boolean> {
  const targetPath = pathname;
  const targetSearch = search;

  if (
    location.pathname === targetPath &&
    (location.search === targetSearch ||
      (targetSearch === "" && location.search === ""))
  ) {
    return true;
  }

  // Ưu tiên click link <a> trong sidebar nếu có (Next.js router handle đúng)
  const link = document.querySelector<HTMLAnchorElement>(
    `a[href="${targetPath}${targetSearch}"], a[href="${targetPath}"]`,
  );
  if (link) {
    link.click();
  } else {
    history.pushState({}, "", `${targetPath}${targetSearch}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(250);
    if (location.pathname === targetPath) {
      // Chờ thêm 1.2s cho React render xong
      await sleep(1200);
      return true;
    }
  }
  console.warn(
    `[autogpt-harvest] nav failed to ${targetPath}${targetSearch} (still ${location.pathname}${location.search})`,
  );
  return false;
}
