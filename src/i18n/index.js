// Tiny i18n layer. Dictionaries bundled in the PWA -> offline language switch.
import ru from './ru.json';
import en from './en.json';
import de from './de.json';
import pl from './pl.json';

export const DICTS = { ru, en, de, pl };
export const LANGS = [
  { code: 'ru', label: 'Русский' },
  { code: 'en', label: 'English' },
  { code: 'de', label: 'Deutsch' },
  { code: 'pl', label: 'Polski' },
];

let current = 'en';

export function resolveInitialLang(saved) {
  if (saved && DICTS[saved]) return saved;
  const dev = (navigator.language || 'en').slice(0, 2).toLowerCase();
  return DICTS[dev] ? dev : 'en';
}

export function setLang(code) {
  if (DICTS[code]) current = code;
}

export function getLang() {
  return current;
}

// t('key', {n: 3}) -> string with {placeholders} filled.
export function t(key, params) {
  const dict = DICTS[current] || DICTS.en;
  let s = dict[key] != null ? dict[key] : (DICTS.en[key] != null ? DICTS.en[key] : key);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.replaceAll(`{${k}}`, String(v));
    }
  }
  return s;
}
