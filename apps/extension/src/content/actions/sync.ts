import type {
  ChatGPTRole,
  ExecuteActionResponse,
  ScrapedMember,
} from "../../shared/messages";
import { querySelectorFirst, sleep } from "../human";
import { SELECTORS } from "../selectors";

function parseRole(raw: string | null | undefined): ChatGPTRole | null {
  if (!raw) return null;
  const t = raw.trim().toLowerCase();
  if (t.includes("owner")) return "owner";
  if (t.includes("admin")) return "admin";
  if (t.includes("member")) return "member";
  return null;
}

function scrapeAllRows(): ScrapedMember[] {
  const members: ScrapedMember[] = [];
  const seen = new Set<string>();

  for (const sel of SELECTORS.memberRow) {
    const rows = document.querySelectorAll<HTMLElement>(sel);
    if (rows.length === 0) continue;
    for (const row of Array.from(rows)) {
      const emailEl = querySelectorFirst<HTMLElement>(
        SELECTORS.memberRowEmail,
        row,
      );
      const nameEl = querySelectorFirst<HTMLElement>(
        SELECTORS.memberRowName,
        row,
      );
      const roleEl = querySelectorFirst<HTMLElement>(
        SELECTORS.memberRowRole,
        row,
      );

      const email = (emailEl?.textContent ?? "").trim().toLowerCase();
      if (!email || !email.includes("@") || seen.has(email)) continue;
      seen.add(email);
      members.push({
        email,
        name: nameEl?.textContent?.trim() ?? null,
        chatgpt_role: parseRole(roleEl?.textContent),
        status: "active",
      });
    }
    if (members.length > 0) return members;
  }
  return members;
}

/** Scroll tới đáy, lặp lại tới khi số row không tăng nữa (xử lý virtualized list). */
async function scrollUntilAllLoaded(maxIterations = 200): Promise<number> {
  let lastCount = 0;
  let stableTicks = 0;

  // Tìm scrollable container — đôi khi list không scroll bằng window mà bằng inner div
  const scrollContainers: Array<HTMLElement | Window> = [window];
  document.querySelectorAll<HTMLElement>("div, main, section").forEach((el) => {
    const style = window.getComputedStyle(el);
    if (
      (style.overflowY === "auto" || style.overflowY === "scroll") &&
      el.scrollHeight > el.clientHeight + 100
    ) {
      scrollContainers.push(el);
    }
  });

  for (let i = 0; i < maxIterations; i++) {
    for (const c of scrollContainers) {
      if (c === window) {
        window.scrollTo({ top: document.body.scrollHeight, behavior: "auto" });
      } else {
        (c as HTMLElement).scrollTop = (c as HTMLElement).scrollHeight;
      }
    }
    await sleep(300 + Math.floor(Math.random() * 200));

    const currentCount = scrapeAllRows().length;
    if (currentCount === lastCount) {
      stableTicks += 1;
      if (stableTicks >= 3) break; // 3 lần liên tiếp không tăng → đã hết
    } else {
      stableTicks = 0;
      lastCount = currentCount;
    }
  }
  return lastCount;
}

export async function executeSync(): Promise<ExecuteActionResponse> {
  if (!location.pathname.includes("/admin")) {
    return {
      ok: false,
      error_code: "PAGE_NOT_ADMIN",
      error_message: `Trang hiện tại không phải admin (${location.pathname}). Mở chatgpt.com/admin/people trước.`,
    };
  }

  const totalAfterScroll = await scrollUntilAllLoaded();
  // Scroll lên đầu trước khi scrape final (để DOM ổn định, virtualized list rerender)
  window.scrollTo({ top: 0, behavior: "auto" });
  await sleep(500);

  // Sau khi scroll, virtualized list có thể destroy row khỏi DOM khi scroll qua.
  // Chiến lược: scrape NGAY trong vòng scroll thay vì sau khi scroll xong.
  // Đơn giản hơn: gọi scrapeAllRows() từng đoạn, build map theo email để dedup.
  const collected = new Map<string, ScrapedMember>();

  for (let pass = 0; pass < 50; pass++) {
    const visible = scrapeAllRows();
    for (const m of visible) collected.set(m.email, m);

    const before = collected.size;
    window.scrollBy({ top: window.innerHeight * 0.8, behavior: "auto" });
    await sleep(250 + Math.floor(Math.random() * 200));

    const after = scrapeAllRows();
    for (const m of after) collected.set(m.email, m);

    if (collected.size === before && pass > 3) {
      // 1 pass không thêm member nào → đã tới đáy
      const atBottom =
        window.innerHeight + window.scrollY >= document.body.scrollHeight - 50;
      if (atBottom) break;
    }
  }

  const members = Array.from(collected.values());

  if (members.length === 0) {
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message: `Không tìm được row member nào (sau ${totalAfterScroll} scroll). Kiểm tra selectors.memberRow hoặc trang không phải /admin/people.`,
    };
  }

  return { ok: true, data: { members, scrolled_count: totalAfterScroll } };
}
