import type { Lang } from "../i18n";

/** Map ngôn ngữ sidebar dashboard → locale ChatGPT (document.documentElement.lang). */
export function dashboardLangToChatGPTLocale(lang: Lang): "vi" | "zh" {
  return lang === "zh-CN" ? "zh" : "vi";
}
