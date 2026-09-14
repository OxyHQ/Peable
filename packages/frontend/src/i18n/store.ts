/**
 * Zustand store that mirrors the active UI language.
 *
 * The module-level state in `./index.ts` is the source of truth for `t()`
 * calls (plain function, not a hook). This store exists so that React can
 * re-render when the language changes — components subscribe to
 * `useLanguageStore((s) => s.language)` and the root layout uses the value
 * as a `key` prop to remount the tree after a language switch.
 *
 * `setLanguage` is called from exactly one place at runtime: `_layout.tsx`'s
 * `OxyProvider` `language.onChange`, which Oxy invokes whenever the resolved
 * account/device locale changes. There is no local bootstrap anymore — Oxy
 * itself is the source of the initial value too.
 */

import { create } from "zustand";
import { setLanguage as setI18nLanguage, getLanguage } from "./index";

interface LanguageState {
  /** Current language code (e.g. `"en"`, `"es"`). */
  language: string;
  /**
   * Change the active language. Persists the new value and notifies
   * subscribers so the UI re-renders with fresh `t()` results.
   */
  setLanguage: (lang: string) => Promise<void>;
}

export const useLanguageStore = create<LanguageState>((set) => ({
  language: "en",
  setLanguage: async (lang: string) => {
    await setI18nLanguage(lang);
    set({ language: getLanguage() });
  },
}));
