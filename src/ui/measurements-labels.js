/* =====================================================================================
 * The measurements panel's WORDS, and nothing else.
 *
 * WHY THIS FILE EXISTS INSTEAD OF AN IMPORT IN THE PANEL
 * ------------------------------------------------------
 * `test_translation_never_reaches_a_measured_value_or_the_safety_statement` forbids
 * `measurements-panel.js` from importing the translator at all, and the reason it gives is
 * the right one: that panel renders `66.2 mm`, and a file that can reach both a measured
 * value and `t()` puts the value one edit away from being translated. `MOS-UI-037`
 * requires the displayed value to carry the unit its header states; a locale that renders
 * it `66,2` has restyled a clinical number on the reader's behalf.
 *
 * But the panel was ALSO the one surface outside the translation system entirely -- it
 * imported `t` zero times while twelve tables translated the chrome around it. For a
 * screen-reader user in a non-English locale that is worse than a missing tooltip: every
 * control in the panel spoke English while every label beside it did not.
 *
 * Both hold at once by splitting the two things that must not meet. This file sees the
 * translator and CANNOT see a measurement: it imports nothing from `image/`, takes no
 * arguments that could carry a number, and returns fixed strings. The panel sees
 * measurements and CANNOT see the translator: it imports this file, which hands it words.
 *
 * `labels()` IS CALLED AT RENDER TIME, NEVER AT IMPORT. A module-level call would run
 * before `startI18n` has loaded a table and the panel would hold English for the rest of
 * the session whatever language was chosen afterwards.
 *
 * `kindWord` IS THE ONE FUNCTION THAT TAKES AN ARGUMENT, and what it takes is a KIND --
 * `length`, `angle`, `roi`, `note` -- not a value. It reuses `tool.length` and
 * `tool.angle`, which every table already carries, rather than adding a second spelling of
 * the same word; a kind with no entry falls back to the raw word, which is what the reader
 * sees elsewhere too.
 *
 * Spec: MOS-SAFE-069, MOS-UI-037, MOS-UI-004.
 * ===================================================================================== */

import { t, onLanguageChange } from '../core/i18n.js';

/** Every word the panel puts on screen, in the reader's language. */
export function labels() {
  return {
    yours: t('meas.yours', 'Yours'),
    notSaved: t('meas.notSaved', 'this session, not saved'),
    fromModel: t('meas.fromModel', 'From the model'),
    none: t('meas.none', 'no measurements yet'),
    emptyNote: t('meas.emptyNote', '(empty)'),

    groupAria: t('meas.groupAria', 'Group the measurements'),
    groupNone: t('meas.groupNone', 'No grouping'),
    groupKind: t('meas.groupKind', 'By kind'),
    groupSlice: t('meas.groupSlice', 'By slice'),

    showThis: t('meas.showThis', 'Show this measurement'),
    hideThis: t('meas.hideThis', 'Hide this measurement'),
    showOnImage: t('meas.showOnImage', 'Show on the image'),
    hideOnImage: t('meas.hideOnImage', 'Hide on the image'),
    remove: t('meas.remove', 'Remove this measurement'),

    editNote: t('meas.editNote', 'Double-click to edit this note'),
    notePlaceholder: t('meas.notePlaceholder', 'Note'),
    noteAria: t('meas.noteAria', 'Text for this note'),
    nameHint: t('meas.nameHint', 'Double-click to name this measurement'),
    nameAria: t('meas.nameAria', 'Name this measurement'),
  };
}

/** `Remove this length measurement` -- the kind named, so several rows are distinguishable. */
export function removeAria(kind) {
  return t('meas.removeAria', 'Remove this {kind} measurement')
    .replace('{kind}', t(`tool.${kind}`, String(kind)));
}

/** The panel repaints on a language change; the hook carries no strings, so it may cross. */
export { onLanguageChange };
