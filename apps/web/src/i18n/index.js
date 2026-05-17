import { jsx as _jsx } from "react/jsx-runtime";
import { createContext, useCallback, useContext, useMemo, useState, } from "react";
import vi from "./locales/vi.json";
import zhCN from "./locales/zh-CN.json";
const STORAGE_KEY = "autogpt.lang";
const DICTS = {
    vi: vi,
    "zh-CN": zhCN,
};
function detectInitialLang() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "vi" || saved === "zh-CN")
        return saved;
    const nav = (navigator.language || "vi").toLowerCase();
    if (nav.startsWith("zh"))
        return "zh-CN";
    return "vi";
}
const I18nContext = createContext(null);
export function I18nProvider({ children }) {
    const [lang, setLangState] = useState(() => detectInitialLang());
    const setLang = useCallback((next) => {
        localStorage.setItem(STORAGE_KEY, next);
        setLangState(next);
    }, []);
    const t = useCallback((key, params) => {
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
    }, [lang]);
    const value = useMemo(() => ({ lang, setLang, t }), [
        lang,
        setLang,
        t,
    ]);
    return _jsx(I18nContext.Provider, { value: value, children: children });
}
export function useI18n() {
    const ctx = useContext(I18nContext);
    if (!ctx)
        throw new Error("useI18n must be used inside I18nProvider");
    return ctx;
}
export function useT() {
    return useI18n().t;
}
