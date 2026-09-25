// SPDX-License-Identifier: Apache-2.0
/* =====================================================================================
 * Measurements that survive a reload.
 *
 * NOTHING PERSISTED. The measurements table says "this session, not saved" and meant it:
 * every number the reader took was retyped into their report by hand, and an accidental
 * refresh erased the lot without a word. That is not a small inconvenience on a surface
 * where taking a measurement is the point.
 *
 * WHY `localStorage` AND NOT THE ARCHIVE. Writing a DICOM SR back is the right end state
 * and it is weeks of work: an SR is a structured document with a template, a coding scheme
 * and a provenance chain, and a half-made one is worse than none because it looks
 * authoritative. This is the days-sized version, and it is deliberately NOT presented as
 * saving: the heading still says the session's measurements are not saved to the archive,
 * because they are not.
 *
 * SCOPED BY STUDY, which is the whole reason this file exists rather than one line in
 * `app.js`. A single flat list keyed by nothing is how one patient's calipers ended up
 * listed under another patient's study; a store that cannot be asked for one study's
 * measurements would reintroduce that the first time it was read back.
 *
 * WHAT IT REFUSES TO DO. It does not restore a measurement onto a study whose UID it does
 * not match, it does not survive a version change in the record shape, and it drops
 * anything it cannot parse rather than handing a half-built record to a surface that will
 * draw it. Storage is per-origin and shared with anyone at the keyboard, so nothing here
 * is a safe place for anything the archive would not already show them.
 * ===================================================================================== */

/** Namespaced so a key cannot collide with anything else this origin stores. */
const PREFIX = 'medos.viewer.measurements.';

/**
 * The shape version.
 *
 * A stored record is a frozen copy of a shape this codebase changes -- `id` was added to
 * it this week, `label` is not written yet. Restoring an old record into a newer surface
 * is how a field that is now load-bearing arrives undefined, so the version is checked and
 * a mismatch is dropped. Losing a session's measurements on an upgrade is a cost; drawing
 * a caliper whose `pixelSpacing` is missing is a defect.
 */
const VERSION = 1;

/**
 * Whether storage can be used at all.
 *
 * `localStorage` THROWS rather than returning null in a private window, under a blocked
 * third-party-data setting, and when the quota is full. Every call here is wrapped,
 * because a viewer that will not open because it could not remember something is worse
 * than one that does not remember.
 */
function usable() {
  try {
    const probe = `${PREFIX}probe`;
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/** Remember this study's measurements. Returns whether it worked. */
export function remember(studyUID, measurements) {
  if (!studyUID || !usable()) return false;
  try {
    if (!measurements || !measurements.length) {
      localStorage.removeItem(PREFIX + studyUID);
      return true;
    }
    localStorage.setItem(PREFIX + studyUID, JSON.stringify({
      version: VERSION,
      studyUID,
      measurements,
    }));
    return true;
  } catch {
    // A full quota is the common one, and it is not worth a dialogue: the measurements are
    // still on screen and still in the session. What is lost is only the reload.
    return false;
  }
}

/**
 * This study's remembered measurements, or an empty list.
 *
 * THE STUDY UID IS CHECKED AGAINST THE RECORD as well as against the key. A key can be
 * edited by anyone with the console open, and a measurement restored onto the wrong study
 * is the exact failure this project has already had once -- one patient's caliper listed
 * under another's. The key is how it is found; the field is what proves it belongs.
 */
export function recall(studyUID) {
  if (!studyUID || !usable()) return [];
  try {
    const raw = localStorage.getItem(PREFIX + studyUID);
    if (!raw) return [];
    const held = JSON.parse(raw);
    if (!held || held.version !== VERSION || held.studyUID !== studyUID) return [];
    if (!Array.isArray(held.measurements)) return [];
    // Every record must still name the things the surface will read off it. A record that
    // does not is dropped rather than drawn, because the alternative is a caliper with no
    // spacing reporting millimetres it never had.
    return held.measurements.filter((m) => (
      m && typeof m === 'object'
      && typeof m.id === 'string'
      && typeof m.kind === 'string'
      && Array.isArray(m.pixelSpacing)
      && (Array.isArray(m.points) || (m.box && typeof m.box === 'object'))
    ));
  } catch {
    return [];
  }
}

/** Forget one study's measurements. */
export function forget(studyUID) {
  if (!studyUID || !usable()) return;
  try { localStorage.removeItem(PREFIX + studyUID); } catch { /* nothing to do */ }
}
