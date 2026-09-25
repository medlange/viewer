// SPDX-License-Identifier: Apache-2.0
/* =====================================================================================
 * One rendering of a DICOM date, for every surface that shows one.
 *
 * WHY THIS FILE EXISTS. The study date was written twice: `studyDate` in `app.js`, used by
 * the worklist, the header banner and the study rail, and `isoDate` in
 * `src/ui/study-panel.js`. Measured on one reading screen with one study open:
 *
 *     header banner      02-Jun-2016 16:19
 *     study rail         02-Jun-2016 16:19
 *     study panel        2016-06-02
 *
 * Neither form is ambiguous on its own -- that is the point of a named month, and ISO 8601
 * is unambiguous by definition -- but a reader comparing two rails of the same screen has
 * to translate one into the other before they can see that both name the same study, and a
 * date that has to be translated is a date that can be misread.
 *
 * THE NAMED MONTH WINS, and not by taste: three of the four places already used it, the
 * worklist among them, so it is the form a reader arrives with. `02-06-2016` would be the
 * form that cannot be trusted across locales; this one has no such reading.
 *
 * NOT IMPORTED FROM THE SHELL. `tests/unit/test_viewer_architecture.py` fails any
 * `src/ui/*.js` that reaches back into `app.js`, for the reason that file states: a UI
 * module which imports the shell cannot be reasoned about without reading the shell. So
 * the shared thing moves DOWN here rather than the panel reaching up.
 *
 * NOT TRANSLATED. The month abbreviations stay English in every language, like the rest of
 * what this viewer prints off a header: `src/core/i18n.js` keeps translation to chrome,
 * and a date read off (0008,0020) is the archive's own value rather than a label. A
 * locale that rendered it differently would make this surface disagree with the PACS about
 * when a study was made.
 *
 * Spec: MOS-UI-037, MOS-CORE-004.
 * ===================================================================================== */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * `(0008,0020)` and optionally `(0008,0030)` as one string a reader can trust.
 *
 * Anything that is not eight digits comes back untouched: an archive that sends a
 * malformed date has said something, and replacing it with a guess would hide that.
 *
 * @param {string} da  DICOM DA, `YYYYMMDD`
 * @param {string} tm  DICOM TM, `HHMMSS.FFFFFF`; only the hour and minute are shown
 * @returns {string}   `02-Jun-2016 16:19`, or `02-Jun-2016`, or the input unchanged
 */
export function studyDate(da, tm = '') {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(da || '').trim());
  if (!m) return String(da || '');
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return String(da);
  const day = `${m[3]}-${month}-${m[1]}`;
  const t = /^(\d{2})(\d{2})/.exec(String(tm || '').trim());
  return t ? `${day} ${t[1]}:${t[2]}` : day;
}
