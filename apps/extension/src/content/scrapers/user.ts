/**
 * Scrape ChatGPT user info (email + name) đang đăng nhập trên browser.
 * KHÔNG click vào profile dropdown (anti-detection). Chỉ đọc từ DOM hoặc Next.js globals.
 */

import { querySelectorFirst } from "../human";
import { SELECTORS } from "../selectors";

export type ChatGPTUserInfo = {
  email: string | null;
  name: string | null;
};

const EMAIL_RE = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,6}/i;

function scrapeFromDom(): ChatGPTUserInfo {
  const emailEl = querySelectorFirst<HTMLElement>(SELECTORS.userEmailInDom);
  const nameEl = querySelectorFirst<HTMLElement>(SELECTORS.userNameInDom);
  let email = emailEl?.textContent?.trim().toLowerCase() ?? null;
  let name = nameEl?.textContent?.trim() ?? null;

  // Fallback: lùng các button profile trigger, đọc aria-label
  if (!email) {
    const trigger = querySelectorFirst<HTMLElement>(SELECTORS.userProfileTrigger);
    if (trigger) {
      const text = `${trigger.getAttribute("aria-label") ?? ""} ${trigger.textContent ?? ""}`;
      const m = text.match(EMAIL_RE);
      if (m) email = m[0].toLowerCase();
    }
  }

  // Fallback: meta tag <meta name="user-email">
  if (!email) {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="user-email"]');
    email = meta?.content?.toLowerCase() ?? null;
  }

  return { email, name };
}

function scrapeFromNextData(): ChatGPTUserInfo {
  // ChatGPT là Next.js — user info có thể nằm trong __NEXT_DATA__
  try {
    const next = document.getElementById("__NEXT_DATA__");
    if (!next?.textContent) return { email: null, name: null };
    const data = JSON.parse(next.textContent);
    const candidate =
      data?.props?.pageProps?.user ??
      data?.props?.pageProps?.session?.user ??
      data?.props?.user ??
      null;
    if (!candidate) return { email: null, name: null };
    return {
      email: typeof candidate.email === "string" ? candidate.email.toLowerCase() : null,
      name: typeof candidate.name === "string" ? candidate.name : null,
    };
  } catch {
    return { email: null, name: null };
  }
}

export function getChatGPTUserInfo(): ChatGPTUserInfo {
  const fromNext = scrapeFromNextData();
  if (fromNext.email || fromNext.name) return fromNext;
  return scrapeFromDom();
}
