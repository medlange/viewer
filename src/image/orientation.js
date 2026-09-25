/* =====================================================================================
 * Which way the patient is, said in letters at the edges of the picture.
 *
 * WHAT THIS IS FOR
 * -----------------
 * A CT slice is very nearly symmetric. Left lung and right lung, left kidney and right
 * kidney, are the same shape in the same place, and nothing in the greyscale says which is
 * which. The letter at the edge of the viewport is the only thing on screen that does.
 *
 * This viewer had no orientation markers at all. RadiAnt and OHIF both draw them, and the
 * reason is not decoration: a reader who cannot check laterality against the image has to
 * take it from the report, the requisition, or habit -- and a left-right error made that
 * way is invisible in every subsequent step. It is the one class of viewer defect that
 * reliably reaches the patient.
 *
 * WHY THIS IS NOT DRAWN UNTIL THE HEADER SAYS
 * --------------------------------------------
 * (0020,0037) ImageOrientationPatient is what makes a letter knowable. Without it the image
 * has no stated relationship to the patient, and a viewer that assumes the usual one --
 * head-first supine, rows running anterior to posterior -- would print `R` on the left edge
 * of a prone or feet-first study with total confidence.
 *
 * So an absent orientation produces null, and the surface renders that absence rather than
 * omitting it, the idiom `MOS-UI-037` fixes for the provenance panel. "Not recorded" sends
 * a reader to the header. A missing letter sends them nowhere, because nothing is missing
 * from a picture that never had it.
 *
 * Spec: MOS-IMG-039, MOS-IMG-041, MOS-UI-037 (absent is rendered, not omitted),
 * MOS-UI-029 (one decision point -- every edge of every plane asks this one function).
 * ===================================================================================== */

/**
 * The letter pairs of the patient coordinate system, by axis and sign.
 *
 * PS3.3 C.7.6.2.1.1: +x is to the patient's LEFT, +y is POSTERIOR, +z is toward the HEAD.
 * That definition is the whole of this table, and it is the reason the negative of each
 * axis is its anatomical opposite rather than an arbitrary second name.
 */
const AXES = [
  { '-1': 'R', 1: 'L' },   // x
  { '-1': 'A', 1: 'P' },   // y
  { '-1': 'F', 1: 'H' },   // z
];

/** The letter an axis shows when a direction runs along it, by the sign of the component. */
function letterOf(axis, component) {
  return AXES[axis][Math.sign(component)];
}

/**
 * Below this, a second letter is noise rather than information.
 *
 * A direction 10 degrees off the patient's left-right axis is `L`, and calling it `LP`
 * would suggest an obliquity the reader cannot see and does not need to correct for. A
 * direction 40 degrees off is genuinely both, and `L` alone would be a simplification the
 * picture contradicts.
 *
 * sin(15 degrees). The threshold is an ANGLE and not a tuned constant: a component of this
 * size is a plane tilted 15 degrees out of an anatomical one, which is about where a
 * reader starts to see it.
 */
const SECOND_LETTER_ABOVE = Math.sin((15 * Math.PI) / 180);

/** Shorter than this and the vector states no direction at all. */
const EPS = 1e-6;

/**
 * The anatomical direction a unit vector points, as one to three letters.
 *
 * Ordered by magnitude, so `AL` says "mostly anterior, somewhat left" and `LA` says the
 * reverse -- which is the convention every viewer that draws these uses, and the reason the
 * order is not alphabetical.
 *
 * @param {number[]} v  a direction in patient coordinates
 * @returns {string}    '' when the vector states no direction
 */
export function directionLetters(v) {
  if (!v || v.length !== 3) return '';

  const ranked = v
    .map((component, axis) => ({ axis, component, size: Math.abs(component) }))
    .filter((c) => c.size > EPS)
    .sort((a, b) => b.size - a.size);

  if (!ranked.length) return '';

  // The dominant axis is ALWAYS named, however slight its lead. A vector with no component
  // above the threshold still points somewhere, and the nearest anatomical direction is a
  // better answer than silence.
  let out = letterOf(ranked[0].axis, ranked[0].component);
  for (const c of ranked.slice(1)) {
    if (c.size < SECOND_LETTER_ABOVE) break;
    out += letterOf(c.axis, c.component);
  }
  return out;
}

/**
 * What each edge of the viewport points at, or null when the header does not say.
 *
 * (0020,0037) states two direction cosines: the first runs along increasing COLUMN index
 * and the second along increasing ROW index. So the first is the direction of the image's
 * right edge and the second is the direction of its bottom edge, and the opposite edges are
 * their negatives. Reversing that pair is the single easiest way to produce markers that
 * are self-consistent, plausible, and rotated ninety degrees from the truth.
 *
 * @param {{orientation?:number[]}} frame  as produced by `reslice` or `buildStack`
 * @returns {{left:string, right:string, top:string, bottom:string}|null}
 */
export function edgeLetters(frame) {
  const o = frame && frame.orientation;
  if (!o || o.length !== 6) return null;

  const alongColumns = [o[0], o[1], o[2]];
  const alongRows = [o[3], o[4], o[5]];
  const back = (v) => [-v[0], -v[1], -v[2]];

  const right = directionLetters(alongColumns);
  const bottom = directionLetters(alongRows);
  if (!right || !bottom) return null;

  return {
    right,
    left: directionLetters(back(alongColumns)),
    bottom,
    top: directionLetters(back(alongRows)),
  };
}

/**
 * The same letters, moved to the edges they are actually on after a flip or a rotation.
 *
 * THIS IS THE REASON MARKERS CAME BEFORE FLIP AND ROTATE
 * ------------------------------------------------------
 * A flip that leaves the letters where they were produces a picture that says `R` on the
 * patient's left, with the confidence of a marker that was correct a moment ago. That is
 * strictly worse than the viewer having no markers at all, which is what it had: an absent
 * marker sends a reader to the header, and a wrong one does not send them anywhere.
 *
 * The permutation is read off the SAME matrix the shader and the hit-testing use, so there
 * is no second composition rule to disagree with the first. For a screen direction `d`,
 * the image direction that landed there is `M-transpose . d` -- the inverse, which for
 * these orthogonal matrices is the transpose exactly.
 *
 * In image-normalised coordinates +y is UP, which is the image's top row; +x is right.
 *
 * @param {{left:string, right:string, top:string, bottom:string}|null} letters
 * @param {number[]} m  row-major [a, b, c, d], as `transform.js` builds it
 */
export function screenEdges(letters, m) {
  if (!letters) return null;
  if (!m || m.length !== 4) return letters;

  // Which IMAGE edge each SCREEN edge shows. The transpose applied to the screen's own
  // unit directions; a result of (0, 1) means the image's top is there, (-1, 0) its left.
  const fromImage = (sx, sy) => {
    const x = m[0] * sx + m[2] * sy;
    const y = m[1] * sx + m[3] * sy;
    if (y > 0.5) return letters.top;
    if (y < -0.5) return letters.bottom;
    if (x > 0.5) return letters.right;
    return letters.left;
  };

  return {
    top: fromImage(0, 1),
    bottom: fromImage(0, -1),
    right: fromImage(1, 0),
    left: fromImage(-1, 0),
  };
}
