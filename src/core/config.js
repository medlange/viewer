// SPDX-License-Identifier: Apache-2.0
/* =====================================================================================
 * viewer.config — the presentation configuration, loaded at runtime, no build step.
 *
 * WHAT THIS FILE IS, NEXT TO THE OTHER TWO CONFIGURATION LAYERS. The viewer has three,
 * and keeping their jobs separate is what makes each of them small:
 *
 *   viewer-config.js   THE INTEGRATION SEAM (a JS global the host replaces). Names what
 *                      this deployment talks TO: apiRoot, capabilities, dicomWebRoot,
 *                      tenant, credentials-by-proxy. It is code, so it stays JS.
 *   presets.json /     DATA the reader works through: window/level tables, hanging
 *   protocols.json     protocols. Reader-facing, so it is JSON shipped in the tree.
 *   viewer.config.json THE PRESENTATION LAYER: what the deployment looks and behaves
 *                      like — branding (name, logo glyph), theme (CSS custom property
 *                      overrides), which registered panels are mounted, and whether
 *                      ?study=<uid> deep links are honoured. Host-facing, so a host
 *                      mounts its own copy over the shipped default, exactly the way
 *                      viewer-config.js is mounted (the read-only tree cannot gain a
 *                      mountpoint the deployment forgot to ship).
 *
 * THE SCHEMA IS CLOSED. Unknown members are ignored with a console warning, not an
 * error the reader has to see: a config that names a key this build does not read is a
 * deployment that expected a newer viewer, and the honest failure mode is "the key does
 * nothing" plus a line in the console, not a refusal to start.
 *
 * IT MUST NOT IMPORT THE SHELL. This is a core module; `viewer/tests/test_architecture.py`
 * fails any `src/core/*` module that reaches into app.js. Everything the shell needs is
 * exported as data and small functions.
 * ===================================================================================== */

/** The schema's defaults, also the answer when the file is absent or unreadable. */
export const DEFAULT_VIEWER_CONFIG = Object.freeze({
  version: 1,
  branding: Object.freeze({ productName: null, logoGlyph: null, logo: null }),
  theme: Object.freeze({}),
  panels: Object.freeze({ disabled: Object.freeze([]) }),
  routing: Object.freeze({ deepLinkStudy: true }),
});

const CSS_VAR_NAME = /^--[A-Za-z0-9-]+$/;
const CSS_VAR_VALUE = /^[^;{}]{1,128}$/;

let held = DEFAULT_VIEWER_CONFIG;

/**
 * Fetch and normalise `./viewer.config.json`. ANY failure — absent file (an older
 * deployment tree), malformed JSON, a non-object body — answers the defaults, because
 * every key is optional by design and a viewer that starts unstyled beats a viewer
 * that does not start. The file ships in the tree, so absence is a deployment defect
 * and gets a console line rather than a reader-facing notice.
 */
export async function loadViewerConfig(fetchImpl) {
  const doFetch = fetchImpl || ((...args) => fetch(...args));
  try {
    const res = await doFetch('./viewer.config.json');
    if (!res.ok) throw new Error(String(res.status));
    held = normalise(await res.json());
  } catch (err) {
    console.warn(`viewer.config.json did not load (${err.message}); shipped defaults apply.`);
    held = DEFAULT_VIEWER_CONFIG;
  }
  return held;
}

/** The closed-schema normalisation. Unknown members warn and are dropped; wrong types
 *  coerce to the default rather than throwing — the same "start unstyled, say so in the
 *  console" posture as a missing file. */
function normalise(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('body is not an object');
  }
  const warn = (where) => console.warn(`viewer.config.json: ignoring unknown ${where}`);
  for (const key of Object.keys(raw)) {
    if (!['version', 'branding', 'theme', 'panels', 'routing'].includes(key)) warn(`key "${key}"`);
  }

  const branding = { ...DEFAULT_VIEWER_CONFIG.branding, ...(raw.branding || {}) };
  for (const key of Object.keys(raw.branding || {})) {
    if (!['productName', 'logoGlyph', 'logo'].includes(key)) warn(`branding.${key}`);
    if (branding[key] != null && typeof branding[key] !== 'string') branding[key] = null;
  }

  const theme = {};
  for (const [name, value] of Object.entries(raw.theme || {})) {
    if (!CSS_VAR_NAME.test(name)) { warn(`theme key "${name}" (not a --variable)`); continue; }
    if (typeof value !== 'string' || !CSS_VAR_VALUE.test(value)) {
      warn(`theme value for ${name} (not a safe CSS value)`);
      continue;
    }
    theme[name] = value;
  }

  const disabledRaw = raw.panels && raw.panels.disabled;
  const disabled = Array.isArray(disabledRaw)
    ? [...new Set(disabledRaw.filter((x) => typeof x === 'string' && x))] : [];
  for (const key of Object.keys(raw.panels || {})) {
    if (key !== 'disabled') warn(`panels.${key}`);
  }

  const routing = { ...DEFAULT_VIEWER_CONFIG.routing, ...(raw.routing || {}) };
  for (const key of Object.keys(raw.routing || {})) {
    if (key !== 'deepLinkStudy') warn(`routing.${key}`);
  }
  routing.deepLinkStudy = routing.deepLinkStudy !== false;

  return Object.freeze({
    version: 1,
    branding: Object.freeze(branding),
    theme: Object.freeze(theme),
    panels: Object.freeze({ disabled: Object.freeze(disabled) }),
    routing: Object.freeze(routing),
  });
}

/** The loaded config (the defaults until `loadViewerConfig` resolves). */
export function viewerConfig() {
  return held;
}

/** Panel ids this deployment has turned off. The shell skips mounting them and removes
 *  their shipped markup section, so a disabled panel costs no layout and no tab stops. */
export function disabledPanels() {
  return new Set(held.panels.disabled);
}

/** Whether `?study=<uid>` is honoured at boot. Defaults TRUE — a deep link is how an
 *  external worklist hands a reader straight into a case, and turning that off is the
 *  deployment's choice to make, not the default to undo. */
export function deepLinkStudyEnabled() {
  return held.routing.deepLinkStudy === true;
}

/**
 * Apply branding and theme to the document. Called once at boot, after the integration
 * seam's own branding ran.
 *
 * PRECEDENCE, STATED ONCE: `viewer-config.js` (the JS seam) wins for `productName`,
 * because that file is the host's explicit statement about THIS surface and it predates
 * viewer.config. The JSON fills the gap when the seam named nothing. The logo glyph is
 * viewer.config's own: the seam never carried one.
 */
export function applyViewerConfig(doc, viewerConfigJs) {
  const branding = held.branding;
  const name = (viewerConfigJs && viewerConfigJs.productName) || branding.productName;
  if (name) {
    doc.title = String(name);
    const h1 = doc.getElementById('product-name');
    if (h1) h1.textContent = String(name);
  }
  const mark = doc.getElementById('brand-mark');
  if (mark && branding.logo) {
    // THE BRAND MARK IS AN IMAGE when the deployment names one -- the Medlange ribbon,
    // not a glyph a font happens to have. On error the glyph below stays, so a wrong
    // path degrades to the text mark instead of a broken-image icon.
    const img = doc.createElement('img');
    img.src = branding.logo;
    img.alt = '';
    img.className = 'brand-mark-img';
    img.onerror = () => { img.remove(); if (branding.logoGlyph) mark.textContent = branding.logoGlyph; };
    mark.textContent = '';
    mark.appendChild(img);
  } else if (mark && branding.logoGlyph) mark.textContent = branding.logoGlyph;

  const root = doc.documentElement;
  for (const [varName, value] of Object.entries(held.theme)) {
    root.style.setProperty(varName, value);
  }
}
