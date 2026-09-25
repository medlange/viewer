/* =====================================================================================
 * Reference lines: where one panel's slice cuts another panel's plane.
 *
 * WHAT THIS IS FOR
 * -----------------
 * Two panels showing the same anatomy from different angles are two pictures until the
 * reader can see how they relate. A reference line is that relation drawn: the axial slice
 * on screen in one panel appears as a line across the coronal in another, at the height it
 * actually cuts. Scrolling one moves the line in the other, which is how a reader confirms
 * that the nodule they are looking at in two planes is one nodule.
 *
 * `MOS-UI-211` states the clinical version of the argument for the annotation surface: "a
 * segmentation authored on axial slices alone with no cross-plane check produces a mask
 * that is correct slice by slice and wrong in the craniocaudal direction, and the reader
 * cannot see it." A reference line is the cheapest cross-plane check there is.
 *
 * THE GUARD IS THE SAME ONE `sync.js` MAKES, AND FOR THE SAME REASON
 * -------------------------------------------------------------------
 * The line is computed from patient coordinates. Two series carrying DIFFERENT
 * (0020,0052) Frame of Reference UIDs make no assertion that their coordinates share an
 * origin (PS3.3 C.7.4.1), so a line computed across that boundary is arithmetic on two
 * unrelated systems -- it produces a plausible line, in the wrong place, with nothing about
 * it looking wrong. A missing UID is treated the same as a mismatch.
 *
 * This is the whole reason the function returns null rather than a best effort: a reference
 * line is a claim about where something is, and there is no honest approximate version of
 * that claim.
 *
 * Spec: MOS-IMG-039, MOS-IMG-041, MOS-UI-211 (its argument, not its authority -- see the
 * header of mpr.js), MOS-UI-200.
 * ===================================================================================== */

/** Below this, a dot product is float noise rather than a direction. */
const EPS = 1e-9;

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function minus(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

/**
 * Whether two frames' coordinates may be compared at all.
 *
 * Exported because the shell needs to explain the absence of a line, and "these two series
 * do not share a frame of reference" is a different sentence from "this slice does not
 * cross that plane" -- which is the distinction a reader needs to act on.
 */
export function comparable(source, target) {
  if (!source || !target) return false;
  if (!source.frameOfReferenceUID || !target.frameOfReferenceUID) return false;
  if (source.frameOfReferenceUID !== target.frameOfReferenceUID) return false;
  return source.orientation?.length === 6 && source.position?.length === 3
    && target.orientation?.length === 6 && target.position?.length === 3;
}

/**
 * Where `source`'s slice plane crosses `target`'s image plane, in target pixel coordinates.
 *
 * THE DERIVATION, because a reader of this file should not have to trust it.
 *
 * A pixel (c, r) of the target sits at the patient position
 *
 *     P(c, r) = Pt + c · colMm · ex + r · rowMm · ey
 *
 * where `ex` and `ey` are the target's direction cosines -- ex along increasing COLUMN
 * index, ey along increasing ROW index, which is the order (0020,0037) states them in. That
 * point lies on the source's slice plane exactly when its displacement from the source
 * origin has no component along the source normal:
 *
 *     (P(c, r) - Ps) · n = 0
 *
 * Expanding gives a straight line in image coordinates, `a·c + b·r + k = 0`, with
 *
 *     a = colMm · (ex · n)      b = rowMm · (ey · n)      k = (Pt - Ps) · n
 *
 * When a and b are both zero the planes are parallel: either the slice misses the target
 * entirely, or the two are coplanar and the "intersection" is the whole image. Neither is
 * a line, and drawing something in either case would be inventing one.
 *
 * @returns {{from:{x:number,y:number}, to:{x:number,y:number}}|null}
 */
export function referenceLine(source, target) {
  if (!comparable(source, target)) return null;

  const ex = target.orientation.slice(0, 3);
  const ey = target.orientation.slice(3, 6);
  const [rowMm, colMm] = target.pixelSpacing;
  const n = source.normal;

  const a = colMm * dot(ex, n);
  const b = rowMm * dot(ey, n);
  const k = dot(minus(target.position, source.position), n);

  if (Math.abs(a) < EPS && Math.abs(b) < EPS) return null;

  const maxC = target.columns - 1;
  const maxR = target.rows - 1;
  const hits = [];

  // Where the line meets each edge of the image rectangle. Two of the four are inside it
  // for any line that crosses the image at all; a line that only touches a corner yields
  // duplicates, which the distance check below discards.
  if (Math.abs(b) > EPS) {
    for (const c of [0, maxC]) {
      const r = -(a * c + k) / b;
      if (r >= 0 && r <= maxR) hits.push({ x: c, y: r });
    }
  }
  if (Math.abs(a) > EPS) {
    for (const r of [0, maxR]) {
      const c = -(b * r + k) / a;
      if (c >= 0 && c <= maxC) hits.push({ x: c, y: r });
    }
  }

  if (hits.length < 2) return null;

  // The two furthest apart, so a corner-clipped line is not reported as a zero-length one.
  let best = null;
  for (let i = 0; i < hits.length; i++) {
    for (let j = i + 1; j < hits.length; j++) {
      const dx = hits[i].x - hits[j].x;
      const dy = hits[i].y - hits[j].y;
      const d2 = dx * dx + dy * dy;
      if (!best || d2 > best.d2) best = { d2, from: hits[i], to: hits[j] };
    }
  }
  return best && best.d2 > 1 ? { from: best.from, to: best.to } : null;
}


/* =====================================================================================
 * Patient space, both directions.
 *
 * HERE AND NOT IN A NEW MODULE. This file already writes the derivation out in its own
 * header -- `P(c, r) = Pt + c · colMm · ex + r · rowMm · ey` -- and already owns
 * `dot`, `minus` and `comparable`. A separate `space.js` would be a second home for six
 * dot products, against the rule this suite states for the screen-to-image transform:
 * exactly one implementation.
 *
 * They are exact inverses because the direction cosines are orthonormal. (0020,0037)
 * arrives that way, and `oblique.js` Gram-Schmidts its basis for the same reason.
 * ===================================================================================== */

/**
 * Where pixel (col, row) of this frame sits in the patient, in millimetres.
 *
 * A FRAME THAT NEVER STATED ITS SPACING HAS NO PATIENT POSITION TO GIVE. `volume.js`
 * stands [1, 1] in so the geometry stays finite, and records that it did -- its own
 * comment says the flag exists because the scale bar was printing fabricated millimetres.
 * A point built on that substitution is a pixel count wearing a millimetre, and
 * `measure.js`'s `spacingStated` already refuses to let such a number pass as measured.
 * This is the same refusal one level down, and it has to be here rather than at the call
 * site: a caller that forgot would get a confident coordinate.
 *
 * @returns {number[]|null} [x, y, z] in millimetres, or null when the frame cannot say
 */
export function pixelToPatient(frame, col, row) {
  if (!frame || frame.orientation?.length !== 6 || frame.position?.length !== 3) return null;
  if (frame.hasPixelSpacing === false) return null;
  const ex = frame.orientation.slice(0, 3);
  const ey = frame.orientation.slice(3, 6);
  // (0028,0030) is stated ROW spacing first. Reversing these is right on square pixels and
  // wrong on every anisotropic frame, which is the same trap `angle()` documents.
  const [rowMm, colMm] = frame.pixelSpacing;
  return [0, 1, 2].map((k) => frame.position[k] + col * colMm * ex[k] + row * rowMm * ey[k]);
}

/**
 * Where a patient point lands on this frame -- AND HOW FAR OFF IT IS.
 *
 * `offMm` is the honest third component, and the reason this returns an object rather than
 * a pair. A point that is not on this plane still has a (col, row) -- the projection is
 * defined everywhere -- and drawing a crosshair there without saying how far away the
 * point is would be the same fabrication `referenceLine` refuses when it declines to draw
 * a line for two parallel planes.
 *
 * @returns {{col:number,row:number,offMm:number}|null}
 */
export function patientToPixel(frame, mm) {
  if (!frame || frame.orientation?.length !== 6 || frame.position?.length !== 3) return null;
  if (frame.hasPixelSpacing === false) return null;
  if (!mm || mm.length !== 3) return null;
  const ex = frame.orientation.slice(0, 3);
  const ey = frame.orientation.slice(3, 6);
  const [rowMm, colMm] = frame.pixelSpacing;
  const d = minus(mm, frame.position);
  return {
    col: dot(d, ex) / colMm,
    row: dot(d, ey) / rowMm,
    offMm: frame.normal ? dot(d, frame.normal) : 0,
  };
}
