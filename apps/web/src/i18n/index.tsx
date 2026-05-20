import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { formatDateForLang, localeTag } from "../lib/locale-format";
import vi from "./locales/vi.json";
import zhCN from "./locales/zh-CN.json";

export type Lang = "vi" | "zh-CN";

const STORAGE_KEY = "autogpt.lang";

type Dict = Record<string, string>;

const DICTS: Record<Lang, Dict> = {
  vi: vi as Dict,
  "zh-CN": zhCN as Dict,
};

function detectInitialLang(): Lang {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === "vi" || saved === "zh-CN") return saved;
  const nav = (navigator.language || "vi").toLowerCase();
  if (nav.startsWith("zh")) return "zh-CN";
  return "vi";
}

type I18nContextValue = {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    const initial = detectInitialLang();
    document.documentElement.lang = initial === "zh-CN" ? "zh-CN" : "vi";
    return initial;
  });

  const setLang = useCallback((next: Lang) => {
    // Chỉ lưu UI dashboard. Thông báo đổi ChatGPT thủ công do Layout.tsx (toast).
    localStorage.setItem(STORAGE_KEY, next);
    document.documentElement.lang = next === "zh-CN" ? "zh-CN" : "vi";
    setLangState(next);
  }, []);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>): string => {
      const dict = DICTS[lang];
      let value = dict[key];
      if (value === undefined) {
        // Fallback sang vi nếu zh-CN miss key
        value = DICTS.vi[key];
      }
      if (value === undefined) {
        if (import.meta.env.DEV) {
          console.warn(`[i18n] missing key: ${key}`);
        }
        return key;
      }
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          value = value.replaceAll(`{${k}}`, String(v));
        }
      }
      return value;
    },
    [lang],
  );

  const value = useMemo<I18nContextValue>(() => ({ lang, setLang, t }), [
    lang,
    setLang,
    t,
  ]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside I18nProvider");
  return ctx;
}

export function useT(): I18nContextValue["t"] {
  return useI18n().t;
}

/** Định dạng ngày theo ngôn ngữ dashboard (vi-VN / zh-CN). */
export function useFormatDate() {
  const { lang } = useI18n();
  return (value: string | Date, options?: Intl.DateTimeFormatOptions) =>
    formatDateForLang(lang, value, options);
}

/** Dịch mã enum (status, task type, …) — key dạng `prefix.VALUE`. */
export function useTranslateEnum(prefix: string) {
  const { t } = useI18n();
  return (value: string) => {
    const key = `${prefix}.${value}`;
    const out = t(key);
    return out === key ? value : out;
  };
}

export { localeTag, formatDateForLang };
