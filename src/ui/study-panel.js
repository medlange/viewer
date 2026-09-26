/* =====================================================================================
 * study-panel.js -- what study is open, in the rail, beside the findings.
 *
 * THIS PANEL HAS NO MARKUP IN index.html AND THAT IS THE POINT. It declares `slot:
 * 'right'`, `title` and `order`, and the shell builds its section. Adding a panel to this
 * viewer is a registration and an import; it is not an edit to the shell's HTML. The two
 * older panels still carry hand-written sections because their empty states need to be on
 * screen before the first subscription fires, and a section in the markup always wins.
 *
 * WHAT IT SHOWS, AND WHY THOSE FIELDS. A reader with four panels open and two studies
 * loaded this session needs to answer "whose pixels am I looking at" without going back
 * to the study list. The identity is read from the SERIES rows the shell already fetched
 * -- `dicomweb.js` asks for the study-level attributes at series level precisely so the
 * banner is right on a deep link -- so this panel adds no request of its own.
 *
 * NOTHING HERE IS TRANSLATED EXCEPT THE FIELD LABELS. A patient's name, an accession and
 * a UID are the archive's own bytes; rendering them through a locale would make the viewer
 * disagree with the PACS about what a study is called. See src/core/i18n.js.
 *
 * Spec: MOS-UI-009a, MOS-CORE-004.
 * ===================================================================================== */

import { KINDS, register } from '../core/registry.js';
import { get, subscribeTo } from '../core/state.js';
import { t, onLanguageChange } from '../core/i18n.js';
// THE SAME RENDERING THE REST OF THE SURFACE USES. This panel had `isoDate` of
// its own, so one study read `2016-06-02` here and `02-Jun-2016` in the banner
// and the rail beside it.
import { studyDate } from '../dicom/dates.js';

/** DICOM strings arrive as `{ Value: [...] }` or absent. One reader for all of them. */
function dv(row, tag, fallback = '') {
  const v = row && row[tag] && row[tag].Value;
  if (!v || !v.length) return fallback;
  const first = v[0];
  // PersonName is an object with alphabetic/ideographic/phonetic components.
  if (first && typeof first === 'object') return String(first.Alphabetic ?? fallback);
  return String(first);
}

function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}


function render(root) {
  const { series, panels, active } = get();

  if (!series || !series.length) {
    root.innerHTML = `<p class="muted">${escape(t('study.none', 'No study open.'))}</p>`;
    return;
  }

  // ANY SERIES ROW ANSWERS THE STUDY-LEVEL QUESTION, because every row carries the study
  // attributes. The FIRST is used rather than the active panel's, so the identity does not
  // flicker as the reader moves between panels of the same study.
  const s = series[0];

  // WHICH SERIES IS IN FRONT is a different question, and it does follow the active panel.
  const shown = panels && panels[active] ? panels[active].seriesUID : null;
  const here = shown ? series.find((r) => dv(r, '0020000E') === shown) : null;

  const row = (label, value) => (value
    ? `<div class="sp-row"><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`
    : '');

  root.innerHTML = `
    <dl class="sp">
      ${row(t('study.patient', 'Patient'), dv(s, '00100010'))}
      ${row(t('study.id', 'Patient ID'), dv(s, '00100020'))}
      ${row(t('study.date', 'Study date'), studyDate(dv(s, '00080020'), dv(s, '00080030')))}
      ${row(t('study.description', 'Description'), dv(s, '00081030'))}
      ${row(t('study.accession', 'Accession'), dv(s, '00080050'))}
      ${row(t('study.series', 'Series in study'), String(series.length))}
      ${here ? row(t('study.showing', 'Showing'),
    `${dv(here, '0008103E', '(no description)')} · ${dv(here, '00080060')}`) : ''}
    </dl>`;
}

export default register({
  id: 'medos.study',
  kind: KINDS.PANEL,
  title: 'Study',
  order: 10,
  slot: 'right',

  /**
   * A panel receives an element and subscribes. It does not import the shell, and the
   * shell does not render it -- `viewer/tests/test_architecture.py` fails either.
   */
  mount(root) {
    render(root);
    const stop = subscribeTo(['series', 'panels', 'active'], () => render(root));
    // A LANGUAGE CHANGE IS NOT A STATE CHANGE, so the store will not wake this panel for
    // one. Its labels are translated, so it has to listen for that separately.
    const stopLang = onLanguageChange(() => render(root));
    return () => { stop(); stopLang(); };
  },
});
