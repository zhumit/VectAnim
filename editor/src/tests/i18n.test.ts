import { describe, expect, it } from 'vitest';
import { keysOf, missingKeys, t, getLocale, setLocale } from '../i18n';

describe('i18n', () => {
  it('English is the default locale', () => {
    expect(getLocale()).toBe('en');
  });

  it('every English key has a Chinese translation', () => {
    expect(missingKeys('zh')).toEqual([]);
  });

  it('every Chinese key exists in English', () => {
    const english = new Set(keysOf('en'));
    expect(keysOf('zh').filter((key) => !english.has(key))).toEqual([]);
  });

  it('interpolates placeholders and switches locale', () => {
    expect(t('notify.copied', { count: 3 })).toBe('Copied 3 shapes');
    setLocale('zh');
    expect(t('notify.copied', { count: 3 })).toBe('已复制 3 个图形');
    setLocale('en');
  });

  it('returns the key itself when a translation is missing', () => {
    expect(t('this.key.does.not.exist')).toBe('this.key.does.not.exist');
  });
});
