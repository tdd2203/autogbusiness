import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import vi from "./locales/vi.json";
import zhCN from "./locales/zh-CN.json";

export type Lang = "vi" | "zh-CN";

const STORAGE_KEY = "autogpt.lang";
type Dict = Record<string, string>;
const DICTS: Record<Lang, Dict> = { vi: vi as Dict, "zh-CN": zhCN as Dict };

function autoDetect(): Lang {
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
  const [lang, setLangState] = useState<Lang>(() => autoDetect());

  useEffect(() => {
    chrome.storage.local.get(STORAGE_KEY).then((obj) => {
      const saved = obj[STORAGE_KEY];
      if (saved === "vi" || saved === "zh-CN") {
        setLangState(saved);
      }
    });
  }, []);

  const setLang = useCallback((next: Lang) => {
    chrome.storage.local.set({ [STORAGE_KEY]: next });
    setLangState(next);
  }, []);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>): string => {
      const dict = DICTS[lang];
      let value = dict[key] ?? DICTS.vi[key];
      if (value === undefined) return key;
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
