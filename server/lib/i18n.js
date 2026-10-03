'use strict';
// Message catalogues for everything a person reads (warnings banner, planner columns, the
// place widget, the messages inside tool results). One JSON file per language TREK ships,
// same codes as TREK (shared/src/i18n/languages.ts). English is canonical; a test fails
// when any key is missing in any language. Tool descriptions for assistants stay English.

// TREK language code → BCP-47 locale for Intl (mirror of TREK's SUPPORTED_LANGUAGES).
const LOCALES = {
  de: 'de-DE', en: 'en-US', es: 'es-ES', et: 'et-EE', fr: 'fr-FR', hu: 'hu-HU', nl: 'nl-NL', br: 'pt-BR',
  cs: 'cs-CZ', sk: 'sk-SK', pl: 'pl-PL', ru: 'ru-RU', zh: 'zh-CN', 'zh-TW': 'zh-TW', it: 'it-IT', tr: 'tr-TR',
  ar: 'ar-SA', az: 'az-AZ', id: 'id-ID', ja: 'ja-JP', ko: 'ko-KR', th: 'th-TH', uk: 'uk-UA', gr: 'el-GR',
  sv: 'sv-SE', vi: 'vi-VN', ca: 'ca-ES',
};
const CODES = Object.keys(LOCALES);

// Static requires, so the files are part of the packed plugin and nothing is read at runtime.
const MESSAGES = {
  ar: require('../i18n/ar.json'), az: require('../i18n/az.json'), br: require('../i18n/br.json'), ca: require('../i18n/ca.json'),
  cs: require('../i18n/cs.json'), de: require('../i18n/de.json'), en: require('../i18n/en.json'), es: require('../i18n/es.json'),
  et: require('../i18n/et.json'), fr: require('../i18n/fr.json'), gr: require('../i18n/gr.json'), hu: require('../i18n/hu.json'),
  id: require('../i18n/id.json'), it: require('../i18n/it.json'), ja: require('../i18n/ja.json'), ko: require('../i18n/ko.json'),
  nl: require('../i18n/nl.json'), pl: require('../i18n/pl.json'), ru: require('../i18n/ru.json'), sk: require('../i18n/sk.json'),
  sv: require('../i18n/sv.json'), th: require('../i18n/th.json'), tr: require('../i18n/tr.json'), uk: require('../i18n/uk.json'),
  vi: require('../i18n/vi.json'), zh: require('../i18n/zh.json'), 'zh-TW': require('../i18n/zh-TW.json'),
};

/**
 * A TREK language code from anything a host or browser may send ("fr", "fr-FR",
 * "pt-BR", "zh-Hant", "el"); English when nothing matches.
 */
function lang(l) {
  if (!l) return 'en';
  const s = String(l);
  if (MESSAGES[s]) return s;
  const low = s.toLowerCase();
  if (low === 'pt-br' || low === 'pt') return 'br';
  if (low.startsWith('zh')) return /tw|hant|hk|mo/.test(low) ? 'zh-TW' : 'zh';
  if (low.startsWith('el')) return 'gr';
  const base = low.split(/[-_]/)[0];
  return MESSAGES[base] ? base : 'en';
}

/** Render message `key` in language `l` with `{param}` placeholders filled. */
function t(l, key, params = {}) {
  const tpl = MESSAGES[lang(l)][key] ?? MESSAGES.en[key] ?? key;
  return String(tpl).replace(/\{(\w+)\}/g, (_, k) => (params[k] == null ? '' : String(params[k])));
}

function has(l, key) {
  return key in MESSAGES[lang(l)];
}

function dayName(l, wd) {
  return (MESSAGES[lang(l)].weekday || MESSAGES.en.weekday)[wd];
}

/** The keys starting with one of `prefixes`, in language `l` (English for any gap): the widget's strings. */
function bundle(l, prefixes) {
  const out = {};
  const src = { ...MESSAGES.en, ...MESSAGES[lang(l)] };
  for (const [k, v] of Object.entries(src)) if (prefixes.some((p) => k.startsWith(p))) out[k] = v;
  return out;
}

const locale = (l) => LOCALES[lang(l)];

/** 44.6 EUR in French → "44,60 €"; an unknown currency code falls back to "44.60 XYZ". */
function money(amount, currency, l) {
  if (amount == null || !Number.isFinite(+amount)) return null;
  try {
    return new Intl.NumberFormat(locale(l), { style: 'currency', currency: currency || 'EUR' }).format(+amount);
  } catch {
    return `${(+amount).toFixed(2)} ${currency || ''}`.trim();
  }
}

/** A plain number with the language's decimal separator ("2,1" in French). */
function num(n, l, digits = 2) {
  if (n == null || !Number.isFinite(+n)) return null;
  return new Intl.NumberFormat(locale(l), { maximumFractionDigits: digits }).format(+n);
}

module.exports = { MESSAGES, CODES, LOCALES, t, has, dayName, lang, bundle, locale, money, num };
