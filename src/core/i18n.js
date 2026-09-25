/* =====================================================================================
 * i18n.js -- the viewer's own translation, in about a hundred lines and no dependency.
 *
 * WHY NOT AN i18n LIBRARY. `docs/adr/BUILD_VS_ADOPT.md` forbids a runtime dependency in
 * this surface, and what a library would add here is interpolation, plurals and lazy
 * namespaces over a few hundred strings. The cost of not having them is a `count`
 * argument and a `{n}` placeholder; the cost of having them is a bundler.
 *
 * WHAT IS NEVER TRANSLATED, and this is the whole safety argument of the file:
 *
 *   - a MEASURED VALUE or its UNIT. `66.2 mm` is a fact about `(0028,0030)`. A locale
 *     that renders it `66,2` has changed a clinical number's appearance on the reader's
 *     behalf, and `MOS-UI-037` requires the displayed value to carry the unit the header
 *     states. `Intl.NumberFormat` is therefore NOT used on measurements anywhere.
 *   - a PATIENT IDENTIFIER, an accession, a UID, a SeriesDescription. These are the
 *     archive's own bytes; translating them would make the viewer disagree with the PACS
 *     about what a study is called.
 *   - the MOS-SAFE-001 statement, which is quoted verbatim in the footer because the
 *     requirement names the words. A translation may sit BESIDE it, never instead of it.
 *
 * So `t()` is for CHROME: labels, headings, buttons, help. Nothing it returns is ever a
 * number that came off an image.
 *
 * Spec: MOS-UI-037, MOS-SAFE-001, MOS-CORE-004.
 * ===================================================================================== */

/** Where a reader's choice is kept. Per-browser, never sent anywhere. */
const STORE_KEY = 'medos.viewer.lang';

/**
 * The languages this build ships.
 *
 * A LANGUAGE IS LISTED WHEN ITS FILE EXISTS, not when someone hopes to add it. A picker
 * offering a language that falls back to English for every string is worse than a shorter
 * list: the reader chooses it, sees no change, and concludes the setting is broken.
 */
export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'it', label: 'Italiano' },
  { code: 'nl', label: 'Nederlands' },
  { code: 'pt', label: 'Português (Brasil)' },
  { code: 'tr', label: 'Türkçe' },
  { code: 'ru', label: 'Русский' },
  { code: 'ar', label: 'العربية', dir: 'rtl' },
  { code: 'ja', label: '日本語' },
  { code: 'zh', label: '中文' },
  { code: 'vi', label: 'Tiếng Việt' },
];

const FALLBACK = 'en';

/** code -> { key: string }, filled by `loadLanguage`. */
const tables = new Map();
let active = FALLBACK;
const listeners = new Set();

function stored() {
  try {
    return localStorage.getItem(STORE_KEY);
  } catch {
    // Private windows and blocked site data throw on access rather than returning null.
    return null;
  }
}

/**
 * The language to start in: the reader's stored choice, else the browser's, else English.
 *
 * `navigator.language` is consulted but not obeyed blindly -- `ru-RU` means the `ru`
 * table, and a language this build does not ship means English rather than a half-empty
 * screen.
 */
export function initialLanguage() {
  const saved = stored();
  if (saved && LANGUAGES.some((l) => l.code === saved)) return saved;
  const nav = String(navigator.language || '').slice(0, 2).toLowerCase();
  return LANGUAGES.some((l) => l.code === nav) ? nav : FALLBACK;
}

export function currentLanguage() {
  return active;
}

/**
 * Translate a chrome string.
 *
 * ALWAYS TAKES THE ENGLISH TEXT AS ITS SECOND ARGUMENT. A `t('prefs.title')` that returns
 * `prefs.title` when a table is missing puts a key on screen; passing the English means
 * the worst case is an untranslated interface rather than a broken one, and it keeps the
 * source readable -- you can see what the string says without opening a JSON file.
 */
export function t(key, english) {
  const table = tables.get(active);
  const hit = table && table[key];
  return typeof hit === 'string' && hit ? hit : english;
}

/** Fetch a table once. A language whose file will not load stays on English. */
async function loadLanguage(code) {
  if (code === FALLBACK || tables.has(code)) return true;
  try {
    const res = await fetch(`./i18n/${code}.json`);
    if (!res.ok) return false;
    tables.set(code, await res.json());
    return true;
  } catch {
    return false;
  }
}

/**
 * Change language and tell everyone who draws chrome.
 *
 * RE-RENDER RATHER THAN RELOAD. A reload would throw away the open study, the panel
 * layout and every measurement taken this session -- none of which is saved -- so
 * changing a label would cost the reader their work.
 */
export async function setLanguage(code) {
  const ok = await loadLanguage(code);
  active = ok ? code : FALLBACK;
  try {
    localStorage.setItem(STORE_KEY, active);
  } catch {
    // A reader in a private window simply gets this session's choice, not a stored one.
  }
  document.documentElement.lang = active;
  // DIRECTION IS PART OF THE LANGUAGE, not a separate setting. Arabic in a left-to-right
  // document is not "Arabic with a quirk" -- the study list's columns, the rails and every
  // row of numbers read in the wrong order. `dir` is set here so no caller has to know.
  const meta = LANGUAGES.find((l) => l.code === active);
  document.documentElement.dir = (meta && meta.dir) || 'ltr';
  for (const fn of listeners) fn(active);
  return active;
}

/** Called when the language changes, so a panel can redraw its own chrome. */
export function onLanguageChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Load the starting language before the first paint of anything translated. */
export async function startI18n() {
  return setLanguage(initialLanguage());
}
