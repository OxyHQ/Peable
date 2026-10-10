/**
 * Supported UI languages for FAIRWallet.
 *
 * `translated: true` means a full translation table exists in `./index.ts`.
 * Languages with `translated: false` can still be selected by the user — the
 * picker just stores the preference and `t()` falls back to English until the
 * translation tables catch up.
 */

export interface LanguageOption {
  /** ISO 639-1 code, e.g. `"en"`, `"es"`, `"fr"` */
  readonly code: string;
  /** Language name written in its own script (e.g. `"Español"`) */
  readonly nativeName: string;
  /** English label for the language (e.g. `"Spanish"`) */
  readonly englishName: string;
  /** Flag emoji representing the language's canonical region */
  readonly flag: string;
  /** `true` when a full translation table exists for this code */
  readonly translated: boolean;
}

export const SUPPORTED_LANGUAGES: readonly LanguageOption[] = [
  {
    code: 'en',
    nativeName: 'English',
    englishName: 'English',
    flag: '\uD83C\uDDEC\uD83C\uDDE7',
    translated: true,
  },
  {
    code: 'es',
    nativeName: 'Español',
    englishName: 'Spanish',
    flag: '\uD83C\uDDEA\uD83C\uDDF8',
    translated: true,
  },
  {
    code: 'fr',
    nativeName: 'Français',
    englishName: 'French',
    flag: '\uD83C\uDDEB\uD83C\uDDF7',
    translated: false,
  },
  {
    code: 'de',
    nativeName: 'Deutsch',
    englishName: 'German',
    flag: '\uD83C\uDDE9\uD83C\uDDEA',
    translated: false,
  },
  {
    code: 'it',
    nativeName: 'Italiano',
    englishName: 'Italian',
    flag: '\uD83C\uDDEE\uD83C\uDDF9',
    translated: false,
  },
  {
    code: 'pt',
    nativeName: 'Português',
    englishName: 'Portuguese',
    flag: '\uD83C\uDDF5\uD83C\uDDF9',
    translated: false,
  },
  {
    code: 'nl',
    nativeName: 'Nederlands',
    englishName: 'Dutch',
    flag: '\uD83C\uDDF3\uD83C\uDDF1',
    translated: false,
  },
  {
    code: 'pl',
    nativeName: 'Polski',
    englishName: 'Polish',
    flag: '\uD83C\uDDF5\uD83C\uDDF1',
    translated: false,
  },
  {
    code: 'ru',
    nativeName: 'Русский',
    englishName: 'Russian',
    flag: '\uD83C\uDDF7\uD83C\uDDFA',
    translated: false,
  },
  {
    code: 'uk',
    nativeName: 'Українська',
    englishName: 'Ukrainian',
    flag: '\uD83C\uDDFA\uD83C\uDDE6',
    translated: false,
  },
  {
    code: 'tr',
    nativeName: 'Türkçe',
    englishName: 'Turkish',
    flag: '\uD83C\uDDF9\uD83C\uDDF7',
    translated: false,
  },
  {
    code: 'ar',
    nativeName: 'العربية',
    englishName: 'Arabic',
    flag: '\uD83C\uDDF8\uD83C\uDDE6',
    translated: false,
  },
  {
    code: 'zh',
    nativeName: '中文',
    englishName: 'Chinese',
    flag: '\uD83C\uDDE8\uD83C\uDDF3',
    translated: false,
  },
  {
    code: 'ja',
    nativeName: '日本語',
    englishName: 'Japanese',
    flag: '\uD83C\uDDEF\uD83C\uDDF5',
    translated: false,
  },
  {
    code: 'ko',
    nativeName: '한국어',
    englishName: 'Korean',
    flag: '\uD83C\uDDF0\uD83C\uDDF7',
    translated: false,
  },
  {
    code: 'hi',
    nativeName: 'हिन्दी',
    englishName: 'Hindi',
    flag: '\uD83C\uDDEE\uD83C\uDDF3',
    translated: false,
  },
  {
    code: 'id',
    nativeName: 'Bahasa Indonesia',
    englishName: 'Indonesian',
    flag: '\uD83C\uDDEE\uD83C\uDDE9',
    translated: false,
  },
  {
    code: 'vi',
    nativeName: 'Tiếng Việt',
    englishName: 'Vietnamese',
    flag: '\uD83C\uDDFB\uD83C\uDDF3',
    translated: false,
  },
  {
    code: 'sv',
    nativeName: 'Svenska',
    englishName: 'Swedish',
    flag: '\uD83C\uDDF8\uD83C\uDDEA',
    translated: false,
  },
  {
    code: 'fi',
    nativeName: 'Suomi',
    englishName: 'Finnish',
    flag: '\uD83C\uDDEB\uD83C\uDDEE',
    translated: false,
  },
] as const;

/**
 * Find a language option by code.
 * Returns `undefined` if the code is not in the supported list.
 */
export function findLanguageOption(code: string): LanguageOption | undefined {
  return SUPPORTED_LANGUAGES.find((lang) => lang.code === code);
}

/**
 * Return `true` if the given code appears in the supported languages list.
 */
export function isSupportedLanguage(code: string): boolean {
  return SUPPORTED_LANGUAGES.some((lang) => lang.code === code);
}
