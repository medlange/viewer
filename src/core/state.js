/* =====================================================================================
 * The viewer's state, and the one place that says it changed.
 *
 * THE DEFECT THIS REMOVES
 * ------------------------
 * `app.js` calls `draw()` from twelve places, and every new feature adds a thirteenth. That
 * is not a style problem: it is why the HU readout went missing for three commits without
 * anybody noticing. `readout()` was deleted by a refactor and its CALL SITE survived, and
 * nothing connected the two, because there was nothing to connect them TO. A panel that
 * re-renders because somebody remembered to call it is a panel that eventually does not.
 *
 * So state changes here and subscribers are told. A panel subscribes to the slice it cares
 * about and never calls another panel's render function.
 *
 * WHY NOT A FRAMEWORK, OR EVEN A PROXY
 * --------------------------------------
 * The whole argument for building this viewer is that it stays small enough to specify
 * (`docs/adr/BUILD_VS_ADOPT.md`), and the moment reactivity is implicit -- a Proxy, a
 * signal graph, a dirty-checking loop -- "what redraws when" stops being readable and
 * becomes a thing you debug. `set()` is explicit and the change set is explicit, so the
 * answer to "why did this repaint" is in the call.
 *
 * NOTIFICATION IS SYNCHRONOUS AND ORDERED
 * -----------------------------------------
 * A subscriber sees the new state, and sees it before the next `set()` can run. The
 * alternative -- batching into a microtask -- is faster and would let two `set()` calls
 * inside one pointer handler produce one repaint, but it also means a subscriber can
 * observe a state that no single `set()` produced. On a surface where a repaint is a
 * SEGMENTATION OVERLAY ON A SLICE, an intermediate state is a wrong picture, and a wrong
 * picture here is the failure mode this whole viewer keeps refusing.
 *
 * Spec: MOS-UI-009a (MOS-UI-009 withdrawn at specification 0.3.0), MOS-IMG-039.
 * ===================================================================================== */

/**
 * @typedef {Object} ViewerState
 * @property {Array} panels        viewport panels, each with its stack, index and plane
 * @property {number} active       which panel the keyboard and the series list act on
 * @property {string|null} studyUID
 * @property {Array} series        the study's series rows, as QIDO returned them
 * @property {Object} link         {scroll, window, zoomPan} -- what follows what
 * @property {Object|null} principal  GET /users/me, or null when not signed in
 * @property {Array} measurements  SR-derived rows
 * @property {string|null} notice
 */

const listeners = new Set();

let state = Object.freeze({
  panels: [],
  active: 0,
  studyUID: null,
  series: [],
  link: { scroll: true, window: false, zoomPan: false },
  principal: null,
  measurements: [],
  /**
   * Which measurement the reader has hold of, by id, or null.
   *
   * IN THE STORE AND NOT IN THE SHELL. The first attempt kept it in a module variable in
   * `app.js` while the measurements panel wrote a state key of the same name -- two
   * sources of truth for one fact, which is how a row can look selected while the shape
   * does not, and neither is wrong about itself.
   */
  selectedMeasurement: null,
  /**
   * Measurement ids the reader has hidden FROM THE IMAGE, by id.
   *
   * A PROPERTY OF THE VIEW, NOT OF THE MEASUREMENT, which is why it is a state key and
   * not a field on the record. The records are frozen and carry provenance; whether the
   * reader currently wants to see one is not a fact about how it was taken, and putting
   * it there would mean a hidden measurement exported as though it were different from
   * a shown one. It is not: a hidden measurement is still in the CSV, because it was
   * still taken.
   */
  hiddenMeasurements: [],
  /**
   * Where the reader is looking, in the patient: `{ forUID, mm: [x, y, z] }` or null.
   *
   * A POINT, NOT A SLICE NUMBER. A slice index names a PLANE, which is why `followIndex`
   * can only answer when two panels show the same one, and why an axial beside a coronal
   * has always been told that neither is a slice of the other. Every plane through the
   * volume has a position along its own normal, so every panel can be asked where a POINT
   * is and answer without consulting any other panel.
   */
  cursor: null,
  srMeasurements: [],
  notice: null,
});

export function get() {
  return state;
}

/**
 * Apply a patch and tell everyone what changed.
 *
 * `changed` is the KEY SET, not a deep diff. A subscriber that cares about panel geometry
 * watches `panels`; computing a structural diff of a 148-slice stack on every wheel tick to
 * tell it something it can check itself would be the expensive kind of clever.
 */
export function set(patch, origin = 'unknown') {
  const changed = Object.keys(patch).filter((k) => patch[k] !== state[k]);
  if (!changed.length) return state;
  state = Object.freeze({ ...state, ...patch });
  for (const listener of [...listeners]) {
    try {
      listener(state, changed, origin);
    } catch (err) {
      // ONE BROKEN SUBSCRIBER MUST NOT STOP THE OTHERS. A panel that throws while
      // rendering would otherwise prevent every panel after it in the set from seeing the
      // change -- including the viewport. A reader would be left looking at the previous
      // slice with no indication anything failed, which is worse than a missing panel.
      // eslint-disable-next-line no-console
      console.error('[medos-viewer] subscriber failed', { origin, changed, err });
    }
  }
  return state;
}

/** Subscribe. Returns the unsubscribe. */
export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Subscribe to changes touching any of `keys`, the common case. */
export function subscribeTo(keys, listener) {
  const wanted = new Set([].concat(keys));
  return subscribe((next, changed, origin) => {
    if (changed.some((k) => wanted.has(k))) listener(next, changed, origin);
  });
}

/** The active panel, or null. Read often enough to be worth naming once. */
export function activePanel() {
  return state.panels[state.active] || null;
}

/** Test-only. */
export function _reset() {
  listeners.clear();
  state = Object.freeze({
    panels: [], active: 0, studyUID: null, series: [],
    link: { scroll: true, window: false, zoomPan: false },
    principal: null, measurements: [], srMeasurements: [], notice: null,
    selectedMeasurement: null, cursor: null,
  });
}
