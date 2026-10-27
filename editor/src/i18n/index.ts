/**
 * Minimal i18n runtime for the editor.
 *
 * - Flat key dictionaries (`area.name`), one file per area so that areas stay
 *   independently editable.
 * - English is the default and the fallback locale; Chinese ships as a second
 *   locale and can be switched at runtime.
 * - `t()` interpolates `{placeholder}` tokens.
 */

import { dict as coreEn } from './locales/en/core';
import { dict as canvasEn } from './locales/en/canvas';
import { dict as engineEn } from './locales/en/engine';
import { dict as coreZh } from './locales/zh/core';
import { dict as canvasZh } from './locales/zh/canvas';
import { dict as engineZh } from './locales/zh/engine';

export type Locale = 'en' | 'zh';

export const LOCALES: ReadonlyArray<{ id: Locale; label: string }> = [
  { id: 'en', label: 'English' },
  { id: 'zh', label: '中文（简体）' },
];

const STORAGE_KEY = 'vectanim.locale';
export const DEFAULT_LOCALE: Locale = 'en';

const DICTIONARIES: Record<Locale, Record<string, string>> = {
  en: { ...coreEn, ...canvasEn, ...engineEn },
  zh: { ...coreZh, ...canvasZh, ...engineZh },
};

type Listener = (locale: Locale) => void;

const listeners = new Set<Listener>();
let current: Locale = detectLocale();

function detectLocale(): Locale {
  try {
    const fromQuery = new URLSearchParams(window.location.search).get('lang');
    if (fromQuery === 'en' || fromQuery === 'zh') return fromQuery;
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'en' || stored === 'zh') return stored;
  } catch {
    /* storage may be unavailable (private mode) */
  }
  return DEFAULT_LOCALE;
}

export function getLocale(): Locale {
  return current;
}

export function setLocale(locale: Locale): void {
  if (locale === current) return;
  current = locale;
  try {
    window.localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    /* ignore quota errors */
  }
  for (const listener of listeners) listener(locale);
}

export function onLocaleChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Translate a key. Unknown keys fall back to English, then to the key itself. */
export function t(key: string, vars?: Record<string, string | number>): string {
  const template = DICTIONARIES[current][key] ?? DICTIONARIES.en[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    vars[name] === undefined ? match : String(vars[name]));
}

/** All keys of the active locale — used by tests to catch missing translations. */
export function keysOf(locale: Locale = current): string[] {
  return Object.keys(DICTIONARIES[locale]).sort();
}

/** Keys that exist in English but not in the given locale. */
export function missingKeys(locale: Locale): string[] {
  const reference = DICTIONARIES.en;
  const target = DICTIONARIES[locale];
  return Object.keys(reference).filter((key) => !(key in target)).sort();
}
