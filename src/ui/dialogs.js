/* =====================================================================================
 * dialogs.js -- the modal shell, and the two modals the chrome opens: About, Preferences.
 *
 * WHY ONE FILE AND NOT THREE. The shell is thirty lines and both dialogs are content
 * functions over it. Splitting them would mean three modules that cannot be understood
 * apart, and the thing that actually matters -- that a modal traps focus, closes on
 * Escape, and gives focus back to whatever opened it -- would be stated once and relied
 * on twice from files that do not contain it.
 *
 * WHAT ABOUT MAY AND MAY NOT SAY. `MOS-UI-009a` permits this viewer under four
 * guarantees. About NAMES them, as the conditions this build is held to. It does NOT
 * claim they are verified: a dialog asserting its own conformance is exactly the failure
 * the requirement was written against, and the gates in
 * `viewer/tests/test_architecture.py` are where conformance is actually argued.
 *
 * Spec: MOS-UI-009a, MOS-SAFE-001, MOS-CORE-001.
 * ===================================================================================== */

import { get, set } from '../core/state.js';
import { LANGUAGES, currentLanguage, setLanguage, t } from '../core/i18n.js';

/** The element focus returns to when the modal closes. */
let opener = null;

function closeDialog() {
  const host = document.getElementById('dialogs');
  if (!host) return;
  host.innerHTML = '';
  host.hidden = true;
  // FOCUS GOES BACK WHERE IT CAME FROM. A modal that closes into nowhere leaves a
  // keyboard reader at the top of the document, which on this page means the study list.
  if (opener && document.contains(opener)) opener.focus();
  opener = null;
}

/**
 * Open a modal with a title and a body, and keep the keyboard inside it.
 *
 * The focus trap is a cycle over the panel's own tabbables rather than `inert` on the
 * rest of the page: `inert` is not in every browser this deployment may meet, and a
 * viewer that becomes unusable on an older one has failed for a worse reason than a
 * missing dialog.
 */
export function openDialog({ title, body, onOpen }) {
  const host = document.getElementById('dialogs');
  if (!host) return;
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  host.hidden = false;
  host.innerHTML = `
    <div class="dlg-back" data-close="1"></div>
    <div class="dlg" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
      <div class="dlg-head">
        <h2 id="dlg-title">${title}</h2>
        <button type="button" class="dlg-x" aria-label="Close">×</button>
      </div>
      <div class="dlg-body">${body}</div>
    </div>`;

  host.querySelector('.dlg-x').onclick = closeDialog;
  host.querySelector('.dlg-back').onclick = closeDialog;
  host.onkeydown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeDialog(); return; }
    if (e.key !== 'Tab') return;
    const f = [...host.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )].filter((n) => !n.disabled && n.offsetParent !== null);
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  if (onOpen) onOpen(host);
  const focusable = host.querySelector('select, input, button:not(.dlg-x)') || host.querySelector('.dlg-x');
  if (focusable) focusable.focus();
}

/* -------------------------------------------------------------------- About ---------- */

/**
 * What this build is, read from the build file rather than written here.
 *
 * NOT A LITERAL IN THIS FILE. Register entry 82 records what a version written into a
 * source file costs: it is correct until the next build and silently false afterwards.
 * `build.json` sits beside `presets.json` and is the one place the answer lives.
 *
 * AND THAT INCLUDES THE FALLBACKS. The first version of this function wrote the docblock
 * above and then rendered `build.viewer_version || '0.4.0'` and a literal transfer-syntax
 * UID -- so an unstamped build, or one whose `build.json` 404s, showed two honest em-dashes
 * beside two confident wrong answers, in the one dialog whose whole job is to say what this
 * build IS. `row()` renders `—` for a missing value; five em-dashes is the truth about an
 * unstamped build and a version that survives the next release is not.
 */
export async function openAbout() {
  let build = {};
  try {
    build = await (await fetch('./build.json')).json();
  } catch {
    build = {};
  }
  const row = (k, v) => `<div class="ab-row"><dt>${k}</dt><dd>${v ?? '—'}</dd></div>`;

  openDialog({
    // THE HOST'S NAME IF IT GAVE ONE, and this software's own if not. The string
    // carries a placeholder rather than a product, so a translator translates
    // the sentence and not somebody's trademark.
    title: t('about.title', 'About {product}')
      .replace('{product}', (typeof window !== 'undefined'
        && window.VIEWER_CONFIG && window.VIEWER_CONFIG.productName) || 'this viewer'),
    body: `
      <p class="dlg-lede">${t('about.lede',
    'A clinician surface for reading images. It fetches pixels over DICOMweb from the '
    + 'origin it is configured against and renders them in the browser.')}</p>
      <p class="dlg-ruo">${t('about.ruo',
    'RESEARCH USE ONLY — NOT FOR DIAGNOSTIC USE, NOT FOR CLINICAL DECISION MAKING.')}</p>
      <dl class="ab">
        ${row(t('about.viewer', 'Viewer'), build.viewer_version)}
        ${row(t('about.platform', 'Platform'), build.platform_version)}
        ${row(t('about.commit', 'Code commit'), build.git_commit)}
        ${row(t('about.syntax', 'Transfer syntax'), build.transfer_syntax)}
        ${row(t('about.deps', 'Runtime dependencies'), t('about.none', 'none — no framework, no CDN, no build step'))}
      </dl>
      <h3>${t('about.guarantees', 'The guarantees this build is held to')}</h3>
      <!--
        NAMED, NOT CLAIMED. These are the four conditions of MOS-UI-009a. Whether this
        build meets them is argued by the gates, not asserted by a dialog about itself.
      -->
      <ol class="ab-g">
        <li>${t('about.g1', 'One route to the pixels — every image request goes through the Gateway.')}</li>
        <li>${t('about.g2', 'No second archive — nothing here stores what the PACS holds.')}</li>
        <li>${t('about.g3', 'No authoring — this surface produces no geometry and no mask.')}</li>
        <li>${t('about.g4', 'Every request labelled — requests carry the surface that made them.')}</li>
      </ol>
      <p class="muted tiny">${t('about.verified',
    'These are conditions, not verdicts. Conformance is argued in the repository’s '
    + 'gates, not in this dialog.')}</p>`,
  });
}

/* -------------------------------------------------------- Preferences ---------------- */

/**
 * The reader's own settings. Language, and the link flags that were keyboard-only.
 *
 * WHAT IS NOT HERE: anything that changes what a measurement MEANS. Units are a fact
 * about `(0028,0030)` and not a preference; a reader who could choose millimetres for a
 * series with no pixel spacing would be choosing a number's units after the fact.
 */
export function openPreferences() {
  const langOptions = LANGUAGES.map((l) => (
    `<option value="${l.code}"${l.code === currentLanguage() ? ' selected' : ''}>${l.label}</option>`
  )).join('');

  const flag = (id, label, on) => `
    <label class="pf-row">
      <input type="checkbox" id="${id}"${on ? ' checked' : ''}>
      <span>${label}</span>
    </label>`;

  const st = get();
  openDialog({
    title: t('prefs.title', 'Preferences'),
    body: `
      <section class="pf">
        <h3>${t('prefs.language', 'Language')}</h3>
        <label class="sr-only" for="pf-lang">${t('prefs.language', 'Language')}</label>
        <select id="pf-lang">${langOptions}</select>
        <p class="muted tiny">${t('prefs.langNote',
    'Applies immediately. Clinical values — measurements, units, patient identifiers '
    + '— are never translated.')}</p>
      </section>
      <section class="pf">
        <h3>${t('prefs.linking', 'Panel linking')}</h3>
        ${flag('pf-link-scroll', t('prefs.linkScroll', 'Link scrolling across panels'), !!st.linkScroll)}
        ${flag('pf-link-wl', t('prefs.linkWindow', 'Link window / level'), !!st.linkWindow)}
        ${flag('pf-link-zoom', t('prefs.linkZoom', 'Link zoom and pan'), !!st.linkZoom)}
      </section>
      <section class="pf">
        <h3>${t('prefs.storage', 'Stored on this computer')}</h3>
        <p class="muted tiny">${t('prefs.storageNote',
    'Preferences are kept in this browser only. They are never sent to the server and '
    + 'never leave this machine.')}</p>
      </section>`,
    onOpen: (host) => {
      // AWAITED, because `setLanguage` fetches the table. Reopening before it resolves
      // redraws the dialog in the language the reader just left, which looks exactly like
      // a setting that does not work.
      host.querySelector('#pf-lang').onchange = async (e) => {
        await setLanguage(e.target.value);
        closeDialog();
        openPreferences();
      };
      const bind = (id, key) => {
        const box = host.querySelector(`#${id}`);
        if (box) box.onchange = () => set({ [key]: box.checked }, 'preferences');
      };
      bind('pf-link-scroll', 'linkScroll');
      bind('pf-link-wl', 'linkWindow');
      bind('pf-link-zoom', 'linkZoom');
    },
  });
}

export { closeDialog };
