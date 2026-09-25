/* =====================================================================================
 * Cross-panel synchronisation: scroll one panel, the others follow -- or say why not.
 *
 * WHAT AUTHORITY THIS HAS, STATED BECAUSE THE FIRST VERSION GOT IT WRONG
 * -----------------------------------------------------------------------
 * The first version of this file cited `MOS-UI-200` as requiring it. That was wrong, for
 * the same reason `mpr.js` was wrong about `MOS-UI-211`: `MOS-UI-200` sits in chapter 19
 * §19.4.1 and belongs to the ANNOTATION surface, and `MOS-UI-213` binds all of §19.4.4 --
 * `MOS-UI-207` through `MOS-UI-215` -- to "OHIF configuration or a module contributed from
 * the extension package". This viewer declares itself `clinical_viewer`, so none of that
 * subsection reaches it. `MOS-UI-009`, which forbade the surface outright when this
 * was written, is WITHDRAWN at specification 0.3.0; `MOS-UI-009a` permits the viewer
 * and states what it is held to instead.
 *
 * So linked scrolling here is a CHOSEN engineering target, not a discharged requirement.
 * It is worth building because the physician who will read on this surface works this way
 * (§19.4.1 records that), and because the alternative -- four panels that scroll
 * independently -- is four viewers side by side rather than one reading surface. It is
 * recorded in `docs/adr/BUILD_VS_ADOPT.md`'s conflicts table, not claimed as compliance.
 *
 * THE TWO WAYS TO LINK, AND THE ONE THIS FILE REFUSES TO INVENT
 * --------------------------------------------------------------
 *   BY POSITION  match the patient coordinate. Slice 40 of a 2 mm study and slice 80 of a
 *                1 mm study are the same anatomy, and both panels show it. Requires that
 *                the coordinates be COMPARABLE and that they be measured along the SAME
 *                AXIS -- two separate conditions, both checked below.
 *   BY OFFSET    the reader scrolls both panels to the same anatomy and says "here". From
 *                then on the panels move together by the captured difference. This is
 *                RadiAnt's manual synchronisation, and its authority is the reader's
 *                assertion rather than any header.
 *
 * There is a third thing this file DOES NOT DO, and the first version did: map the two
 * stacks proportionally -- slice 40 of 80 pairs with slice 74 of 148. That asserts the two
 * series cover the same anatomical extent, which nothing checked and which is false for a
 * chest CT beside a chest-and-abdomen CT. It produces a number, both panels scroll, and
 * unrelated anatomy sits side by side looking locked. When neither position nor a reader's
 * offset is available the honest answer is that the panels DO NOT LINK, and the badge says
 * which condition failed. RadiAnt does the same: its auto mode simply declines.
 *
 * CONDITION 1 -- COMPARABLE COORDINATES: FrameOfReferenceUID
 * PS3.3 C.7.4.1 makes (0020,0052) the assertion that images share ONE patient coordinate
 * system, which is exactly what makes their (0020,0032) values comparable. A null on either
 * side is a mismatch, not a wildcard: a series that declines to assert a coordinate system
 * has not asserted this one.
 *
 * CONDITION 2 -- THE SAME AXIS: parallel slice normals
 * `volume.js` stores each slice's depth as the projection of ImagePositionPatient on THAT
 * SERIES' OWN normal. Two series whose normals differ have depths measured along different
 * axes, and comparing those scalars is arithmetic on unrelated rulers. The first version of
 * this file checked only that both panels displayed `PLANES.AXIAL` -- which in `mpr.js`
 * means "the acquired plane as stored", NOT patient-axial -- so an oblique or a sagittal
 * acquisition passed the gate and was matched against an axial one. Now the dihedral angle
 * between the two normals is measured and must be within `MAX_DIHEDRAL_DEGREES`.
 *
 * The 5 degree threshold is RadiAnt's, whose manual gives its auto-synchronisation criteria
 * as series "acquired in the same plane (or in similar planes, with the dihedral angle up to
 * 5 degrees), within the same study". It is a tolerance and not an equality test for a
 * practical reason: a reconstruction and its source series routinely differ by a fraction of
 * a degree, and an exact comparison on the orientation cosines refuses to link them.
 *
 * Spec: MOS-UI-009a (MOS-UI-009 withdrawn at specification 0.3.0), MOS-IMG-039.
 * NOT MOS-UI-200 -- see above.
 * ===================================================================================== */

import {
  PLANES, planeDepth, planeOrdinate, planeNormal, planeStepMm,
} from './mpr.js';
import { patientToPixel, pixelToPatient } from './reference.js';

/** How two panels are linked. Reported to the caller, never assumed. */
export const LINK = Object.freeze({
  POSITION: 'position',
  CLAMPED: 'clamped',
  OFFSET: 'offset',
  NONE: 'none',
  SELF: 'self',
});

/**
 * Maximum angle between two series' slice normals for position linking, in degrees.
 *
 * RadiAnt's documented auto-synchronisation tolerance. Exported so a caller can report it
 * rather than restate it, and so the number has one home.
 */
export const MAX_DIHEDRAL_DEGREES = 5;

/** Angle between two slice normals, in degrees, treating antiparallel as parallel. */
export function dihedralDegrees(a, b) {
  if (!a || !b || a.length !== 3 || b.length !== 3) return NaN;
  const norm = (v) => Math.hypot(v[0], v[1], v[2]);
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return NaN;
  const dot = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (na * nb);
  // |dot|: a series scanned foot-to-head and one scanned head-to-foot lie in the same
  // plane and must link; only the sign of the normal differs.
  return (Math.acos(Math.min(1, Math.max(0, Math.abs(dot)))) * 180) / Math.PI;
}

/**
 * Whether two stacks may be linked by patient-space position ON A GIVEN PLANE, and if not,
 * why not.
 *
 * `plane` HAS NO DEFAULT, deliberately. The obvious default is `PLANES.AXIAL`, and it is
 * the one answer that is right for the acquired plane and wrong for every reconstruction --
 * so a caller that forgot to say which plane it meant would get a confident, plausible
 * answer to a question it did not ask. That is the whole defect this parameter was added to
 * fix. Without it, `planeNormal` returns null and the pair is refused with a reason that
 * says so, which is the failure worth having.
 *
 * @returns {{ok:boolean, reason:string, dihedral:number, sign:number}}
 */
export function positionLinkable(source, target, plane) {
  const sameFrame = Boolean(source?.frameOfReferenceUID)
    && source.frameOfReferenceUID === target?.frameOfReferenceUID;
  if (!sameFrame) {
    return {
      ok: false,
      dihedral: NaN,
      sign: 1,
      reason: 'different frame of reference — the two series do not assert a shared '
        + 'patient coordinate system, so their positions are not comparable',
    };
  }

  // ON THE PLANE BEING LINKED, NOT ON THE ACQUISITION. This used to read
  // `source.frames[0].normal` against `target.frames[0].normal` -- the axis the SLICES
  // advance along -- while `followIndex` then compared ordinates measured along the axis
  // the DISPLAYED PLANE advances along. For an axial those are the same vector and the
  // gate was sound; for a reconstruction they are not, and a pair that differs only by an
  // in-plane rotation passes a gate reading 0.000 degrees and is then compared along two
  // axes up to 90 degrees apart. See `planeNormal` for the measured case.
  const ns = planeNormal(source, plane);
  const nt = planeNormal(target, plane);
  if (!ns || !nt) {
    return {
      ok: false,
      dihedral: NaN,
      sign: 1,
      reason: `the ${plane} plane has no patient-space geometry on one of the two series, `
        + 'so there is no axis to compare positions along',
    };
  }
  const dihedral = dihedralDegrees(ns, nt);
  if (!(dihedral <= MAX_DIHEDRAL_DEGREES)) {
    return {
      ok: false,
      dihedral,
      sign: 1,
      reason: `${plane} planes differ by ${Number.isFinite(dihedral) ? dihedral.toFixed(1) : '?'}° `
        + `(limit ${MAX_DIHEDRAL_DEGREES}°) — the two series measure depth along different axes`,
    };
  }

  // AND THE SIGN, WHICH IS THE OTHER HALF OF THE SAME BUG. `dihedralDegrees` takes |cos| so
  // that an antiparallel pair reads 0 degrees -- correct, because the two planes ARE
  // parallel -- but every ordinate downstream is a SIGNED projection, and along opposite
  // normals the same patient point projects to opposite numbers. A feet-first series
  // against a head-first one is exactly this: the scalars match while the anatomy is
  // mirrored. Carrying the sign lets the comparison be corrected rather than refused, which
  // matters because HFS-against-FFS is an ordinary pair and refusing it would be a real
  // loss of function.
  const dot = ns[0] * nt[0] + ns[1] * nt[1] + ns[2] * nt[2];
  return { ok: true, dihedral, sign: dot < 0 ? -1 : 1, reason: '' };
}

/**
 * The index of the slice nearest a given patient-space depth.
 *
 * Binary search: `volume.js` sorts frames by depth, so the array is monotonic. Returns the
 * distance too, because two series sharing a frame of reference need not OVERLAP -- a head
 * CT and a chest CT can both be valid and share nothing -- and a caller that ignores the
 * distance will clamp to slice 0 and call it synchronised.
 */
export function nearestByPosition(stack, depth) {
  const f = stack.frames;
  let lo = 0;
  let hi = f.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (f[mid].depth < depth) lo = mid + 1; else hi = mid;
  }
  let best = lo;
  if (lo > 0 && Math.abs(f[lo - 1].depth - depth) < Math.abs(f[lo].depth - depth)) best = lo - 1;
  return { index: best, distanceMm: Math.abs(f[best].depth - depth) };
}

/**
 * Half the distance to the nearest neighbouring slice of `index`, in millimetres.
 *
 * WHAT THIS NUMBER IS FOR. A nearest-slice search always returns an index, including for a
 * depth that lies outside the target series entirely -- it returns the end slice and a
 * large distance. `nearestByPosition` says so in its own docstring ("a caller that ignores
 * the distance will clamp to slice 0 and call it synchronised") and `followIndex` was that
 * caller: it reported `LINK.POSITION` for every result, and `linkBadge` renders that as a
 * green chip reading `position-linked`, kind `exact`.
 *
 * MEASURED, against the demo corpus's two studies -- 64 slices from z=0 and 40 from z=7,
 * both at 2 mm: source slice 63 sits at z=126, the companion ends at z=85, and the viewer
 * badged the pair `position-linked / exact` with the two panels 41 mm apart. The distance
 * existed and was correct; it reached the reader only as a `title` attribute, which is to
 * say on hover, over a green chip that had already told them it was exact.
 *
 * So the test is: is the residual within the slice's own cell? A depth inside the sampled
 * extent cannot be farther than half a pitch from some slice; one outside it can be
 * arbitrarily far. Derived from the target's OWN neighbouring ordinates rather than from a
 * threshold, because a 0.5 mm series and a 5 mm series do not agree on what "near" is, and
 * because an unevenly spaced acquired series has no single pitch to compare against.
 *
 * Returns 0 for a target of one slice: such a series corresponds at its own position and
 * nowhere else, which is the honest reading rather than a special case.
 */
function halfCellMm(stack, plane, index) {
  const n = planeDepth(stack, plane);
  if (n < 2) return 0;
  const here = planeOrdinate(stack, plane, index);
  if (here === null) return 0;
  const gaps = [];
  if (index > 0) {
    const before = planeOrdinate(stack, plane, index - 1);
    if (before !== null) gaps.push(Math.abs(here - before));
  }
  if (index < n - 1) {
    const after = planeOrdinate(stack, plane, index + 1);
    if (after !== null) gaps.push(Math.abs(after - here));
  }
  if (!gaps.length) return 0;
  // The LARGER of the two neighbouring gaps: an interior index of an uneven series may sit
  // up to half the wider gap from the depth that chose it, and flagging that as out of
  // range would refuse a correspondence that genuinely holds.
  return Math.max(...gaps) / 2;
}

/**
 * Classify a nearest-slice result: a correspondence, or a clamp to the end of the series.
 *
 * The index is returned either way -- a panel parked at the boundary is how a reader SEES
 * that the other series stops here, and leaving it wherever it was is worse. What changes
 * is the claim made about it.
 */
function positionResult(target, targetPlane, index, distanceMm) {
  const reach = halfCellMm(target, targetPlane, index);
  if (distanceMm > reach + CELL_EPS) {
    return {
      index,
      mode: LINK.CLAMPED,
      distanceMm,
      reason: 'the other series does not reach this position',
    };
  }
  return { index, mode: LINK.POSITION, distanceMm, reason: '' };
}

/** Float slack on the cell test; a residual of exactly half a pitch is inside its cell. */
const CELL_EPS = 1e-6;

/**
 * Which index of `plane` sits at patient-space ordinate `want`, and how far it missed.
 *
 * THE INVERSE OF `planeOrdinate`, and it was written twice inline inside `followIndex`
 * where only `followIndex` could reach it -- the same shape as `referencesOnto` having
 * been declared inside `draw`. A crosshair needs exactly this and would otherwise have
 * grown a third copy.
 *
 * Both branches are the ones that were there, unchanged in arithmetic.
 *
 * @returns {{index:number, distanceMm:number}|null}
 */
export function indexAtOrdinate(stack, plane, want) {
  if (want === null || !Number.isFinite(want)) return null;

  // THE ACQUIRED PLANE KEEPS ITS BINARY SEARCH. `volume.js` sorts frames by depth, and a
  // series whose spacing is uneven or which overlaps another is handled exactly by
  // searching rather than by inverting an affine map it does not obey.
  if (plane === PLANES.AXIAL) return nearestByPosition(stack, want);

  // A RECONSTRUCTED PLANE IS AFFINE IN ITS INDEX by construction -- `reslice` refuses a
  // stack whose spacing is uneven -- so two ordinates give the step WITH ITS SIGN. A
  // subtraction of positions would not: a coronal's rows run one way and its normal may
  // run the other, and assuming the step is positive puts the panel at the far end of the
  // volume from the one the reader is looking at.
  const base = planeOrdinate(stack, plane, 0);
  const next = planeOrdinate(stack, plane, 1);
  if (base === null || next === null || next === base) return null;
  const step = next - base;
  const depth = planeDepth(stack, plane);
  const index = Math.max(0, Math.min(depth - 1, Math.round((want - base) / step)));
  const landed = planeOrdinate(stack, plane, index);
  if (landed === null) return null;
  return { index, distanceMm: Math.abs(landed - want) };
}

/**
 * Where `target` should sit, given that `source` is showing `sourceIndex`.
 *
 * `anchor`, when present, is the reader's own assertion: `{source, target}`, the two
 * indices that were on screen together when they pressed Align. It wins over nothing --
 * position is still preferred when available -- but it is what makes a link possible at all
 * when position is not.
 *
 * POSITION LINKING NEEDS THE SAME PLANE ON BOTH PANELS, and nothing more than that. This
 * used to say "a panel showing a RECONSTRUCTED plane never position-links: its index is a
 * row or a column of the resliced volume, not a slice, so there is no patient-space depth
 * to match." That was true when a reconstruction was a bare index. `reconstructedGeometry`
 * has supplied a position and a normal per index since the reference lines were built, and
 * the oblique branch does the same -- so a coronal's index has a patient-space ordinate
 * exactly as an axial's does, and `planeOrdinate` is the one place that says what it is.
 *
 * What genuinely has no answer is a link ACROSS plane kinds: an axial advances along one
 * axis and a coronal along another, so neither is a slice of the other. That pair falls to
 * the reader's offset or to nothing, and the reason now says which of the two situations
 * applies rather than giving the same sentence to both.
 *
 * @returns {{index:(number|null), mode:string, distanceMm:(number|null), reason:string}}
 *   `index` is null when the panel must not move.
 */
export function followIndex(source, sourceIndex, sourcePlane, target, targetPlane, anchor = null) {
  if (source === target) return { index: sourceIndex, mode: LINK.SELF, distanceMm: 0, reason: '' };

  const byOffset = () => (anchor
    ? {
      index: anchor.target + (sourceIndex - anchor.source),
      mode: LINK.OFFSET, distanceMm: null, reason: '',
    }
    : null);

  // THE SAME PLANE ON BOTH PANELS is what makes a slice correspondence exist at all. Two
  // coronals advance along one axis and two axials along another; an axial and a coronal
  // advance along different ones, and there is no slice of either that IS a slice of the
  // other. That pair is not unlinkable because the data is poor -- it is unlinkable because
  // the question has no answer, and `reference.js` already draws the one that does.
  if (sourcePlane === targetPlane) {
    const check = positionLinkable(source, target, sourcePlane);
    if (check.ok) {
      // The acquired plane keeps its binary search: `volume.js` sorts frames by depth, and
      // a series whose spacing is uneven or which overlaps another is handled exactly by
      // searching rather than by inverting an affine map it does not obey.
      // `check.sign` is -1 when the two series measure this axis in opposite directions,
      // in which case the same patient plane has the opposite ordinate on the target.
      //
      // NOT `check.sign * planeOrdinate(...)`: `-1 * null` is 0, not null, and the search
      // below would then be given an ordinate that does not exist as though it were the
      // origin.
      const sourceOrdinate = sourcePlane === PLANES.AXIAL
        ? source.frames[Math.max(0, Math.min(source.depth - 1, sourceIndex))].depth
        : planeOrdinate(source, sourcePlane, sourceIndex);
      const want = sourceOrdinate === null ? null : check.sign * sourceOrdinate;
      const hit = indexAtOrdinate(target, targetPlane, want);
      if (hit) return positionResult(target, targetPlane, hit.index, hit.distanceMm);
    }
    // `check.reason` IS EMPTY WHEN THE CHECK PASSED, and this fall-through is reached in
    // both cases: the geometry was refused, or it was accepted and the ordinates then did
    // not give an invertible map. Returning `check.reason` for both handed the reader an
    // empty string on the second, which `describeLink` renders as its placeholder -- "not
    // linked: no comparable geometry" -- a sentence that contradicts the check that had
    // just succeeded and sends them looking for a frame-of-reference problem they do not
    // have.
    return byOffset() || {
      index: null,
      mode: LINK.NONE,
      distanceMm: null,
      reason: check.reason || `the ${targetPlane} of the other series has no usable step `
        + 'between its planes, so there is no map from one index to the other',
    };
  }

  return byOffset() || {
    index: null,
    mode: LINK.NONE,
    distanceMm: null,
    // No article before the plane name: "a axial slice" is what a template gets you, and a
    // sentence a reader is shown is a sentence that has to read.
    reason: `${sourcePlane} and ${targetPlane} slices advance along different axes, `
      + 'so neither one of them is a slice of the other — the reference line shows where '
      + 'they cross. Align the panels by hand and press Align to link them by the offset you '
      + 'chose instead.',
  };
}

/**
 * A one-line, reader-facing description of what the link is actually doing.
 *
 * Written here rather than in the surface because the wording is a claim about correctness
 * and `MOS-CORE-004`'s vocabulary rules bind UI strings. "Linked" alone would promise the
 * strong form in every case.
 */
export function describeLink(mode, info = {}) {
  if (mode === LINK.POSITION) {
    const d = info.distanceMm;
    const off = d > 0.01 ? ` (nearest slice ${d.toFixed(1)} mm away)` : '';
    return `linked by patient position${off}`;
  }
  if (mode === LINK.CLAMPED) {
    const d = info.distanceMm;
    return 'not a slice correspondence: the other series does not reach this position — '
      + `its nearest slice is ${Number.isFinite(d) ? d.toFixed(1) : '?'} mm away, and that `
      + 'panel is parked at the end of what it covers';
  }
  if (mode === LINK.OFFSET) {
    return 'linked by an offset you set — the platform did not verify this correspondence';
  }
  if (mode === LINK.NONE) return `not linked: ${info.reason || 'no comparable geometry'}`;
  return '';
}

/**
 * Short label for the per-panel badge.
 *
 * THE BADGE IS THE CLAIM, and the tooltip is not. `describeLink` has always carried the
 * distance, and `app.js` puts it in `title` -- which is to say a reader sees it only if
 * they hover a chip that has already told them the link is exact. So `LINK.CLAMPED` gets
 * its own text and the amber `weak` treatment, beside the offset link, because both are
 * movements the platform made without establishing a correspondence.
 */
/**
 * WHY THERE IS NO CROSSHAIR, as a code rather than as the sentence that says it.
 *
 * A caller needs to tell these two apart for a reason the sentences cannot carry: the
 * first is the SAME FACT the `not linked` badge states, and stating it twice puts a second
 * sentence across the scale bar; the second is a fact nothing else on the panel reports.
 *
 * Matching on the sentence would work until somebody improves the wording, and then the
 * duplicate would quietly come back -- which is the kind of failure a code exists to make
 * impossible. `LINK.NONE` is NOT the test: it covers four situations, and two of them --
 * slices along different axes, no usable step between planes -- happen between series that
 * DO share a coordinate system.
 */
export const ABSENT = Object.freeze({
  FRAME_OF_REFERENCE: 'frame-of-reference',
  NO_PIXEL_SPACING: 'no-pixel-spacing',
});

export function linkBadge(mode) {
  if (mode === LINK.POSITION) return { text: 'position-linked', kind: 'exact' };
  if (mode === LINK.CLAMPED) return { text: 'past the other series', kind: 'weak' };
  if (mode === LINK.OFFSET) return { text: 'offset-linked', kind: 'weak' };
  if (mode === LINK.NONE) return { text: 'not linked', kind: 'none' };
  return null;
}


/* =====================================================================================
 * The cursor: one point in the patient, which every panel can answer about.
 *
 * WHY A POINT AND NOT AN INDEX. `followIndex` maps a SLICE NUMBER to a slice number, and a
 * slice number names a PLANE, not a place -- which is why it can only answer when both
 * panels show the same plane, and why an axial beside a coronal has been told since it was
 * written that "neither one of them is a slice of the other". A point has no such problem:
 * every plane through the volume has a position along its own normal, so every panel can
 * be asked where the point is and answer without consulting any other panel.
 *
 * THE FRAME OF REFERENCE IS THE LICENCE TO COMPARE. (0020,0052) is what PS3.3 C.7.4.1
 * makes it: the assertion that two series' coordinates are in one system. A null is a
 * mismatch and not a wildcard, which is what `comparable` and `positionLinkable` already
 * hold, and the cursor carries the UID it was set in so a panel can refuse rather than
 * compute.
 * ===================================================================================== */

/**
 * The cursor implied by a pixel of a frame.
 *
 * @returns {{forUID:string, mm:number[]}|null}
 */
export function cursorAt(stack, frame, col, row) {
  const mm = pixelToPatient(frame, col, row);
  if (!mm || !stack || !stack.frameOfReferenceUID) return null;
  return Object.freeze({ forUID: stack.frameOfReferenceUID, mm });
}

/**
 * Slide the cursor along one plane's normal to where `index` sits, leaving the other two
 * axes alone.
 *
 * THIS IS THE WHOLE DESIGN IN ONE FUNCTION. A slice index names a plane, not a point: when
 * the reader wheels an axial, the coronal beside it must change row and must NOT slide
 * sideways. Rebuilding the cursor from the new slice's ORIGIN would do exactly that -- an
 * origin is a corner of the image, not where the reader is looking -- so the cursor is
 * displaced by the ordinate DIFFERENCE, which is exact and accumulates nothing.
 */
export function slideCursor(cursor, stack, plane, index, frame = null) {
  const n = planeNormal(stack, plane);
  const want = plane === PLANES.AXIAL && stack.frames[index]
    ? stack.frames[index].depth
    : planeOrdinate(stack, plane, index);
  if (!n || want === null) return cursor;

  const forUID = stack.frameOfReferenceUID;
  const base = (cursor && cursor.forUID === forUID)
    ? cursor.mm
    // The centre of the picture is the only in-plane point a panel can nominate without
    // inventing an interest the reader has not expressed.
    : (frame ? pixelToPatient(frame, (frame.columns - 1) / 2, (frame.rows - 1) / 2) : null);
  if (!base) return cursor;

  const d = want - (base[0] * n[0] + base[1] * n[1] + base[2] * n[2]);
  return Object.freeze({
    forUID,
    mm: [base[0] + d * n[0], base[1] + d * n[1], base[2] + d * n[2]],
  });
}

/**
 * Where this panel should sit, given the cursor. Position linking, without a source panel.
 *
 * @returns {{index:(number|null), mode:string, distanceMm:(number|null), reason:string}}
 */
export function indexForCursor(stack, plane, cursor) {
  if (!cursor) {
    return {
      index: null, mode: LINK.NONE, distanceMm: null,
      reason: 'no position has been set in this study yet',
    };
  }
  if (!stack.frameOfReferenceUID || stack.frameOfReferenceUID !== cursor.forUID) {
    return {
      index: null, mode: LINK.NONE, distanceMm: null,
      reason: 'different frame of reference \u2014 the two series do not assert a shared '
        + 'patient coordinate system, so their positions are not comparable',
    };
  }
  const n = planeNormal(stack, plane);
  if (!n) {
    return {
      index: null, mode: LINK.NONE, distanceMm: null,
      reason: `the ${plane} plane has no patient-space geometry on this series, so there `
        + 'is no axis to measure a position along',
    };
  }
  const want = cursor.mm[0] * n[0] + cursor.mm[1] * n[1] + cursor.mm[2] * n[2];
  const hit = indexAtOrdinate(stack, plane, want);
  if (!hit) {
    return {
      index: null, mode: LINK.NONE, distanceMm: null,
      reason: `the ${plane} of this series has no usable step between its planes`,
    };
  }
  return positionResult(stack, plane, hit.index, hit.distanceMm);
}

/**
 * Where the cursor falls on this panel's picture, and whether it is actually on it.
 *
 * THREE STATES, NOT TWO. A point that is not on this plane still projects onto it -- the
 * projection is defined everywhere -- so a crosshair drawn from the projection alone would
 * be identical whether the reader is looking at the point or forty millimetres behind it.
 * `offMm` is the difference, and `onPlane` is that difference judged against the plane's
 * OWN step rather than a literal, so a 5 mm axial and a 0.7 mm coronal are each judged by
 * what they can resolve.
 *
 * Absence is REPORTED rather than returned as null, because a crosshair that is simply
 * missing looks the same as a viewer that has not drawn one yet.
 *
 * @returns {{x:number,y:number,offMm:number,onPlane:boolean}
 *           |{absent:string, because:string}|null}
 */
export function crosshairOn(stack, frame, plane, cursor) {
  if (!cursor || !frame) return null;
  if (!frame.frameOfReferenceUID || frame.frameOfReferenceUID !== cursor.forUID) {
    return {
      absent: 'no shared coordinate system with the panel you are reading',
      because: ABSENT.FRAME_OF_REFERENCE,
    };
  }
  const at = patientToPixel(frame, cursor.mm);
  if (!at) {
    return {
      absent: 'this series never stated its pixel spacing, so it cannot say where a '
        + 'patient position falls on it',
      because: ABSENT.NO_PIXEL_SPACING,
    };
  }
  const step = planeStepMm(stack, plane);
  const reach = Number.isFinite(step) && step > 0 ? step / 2 : 0.5;
  return { x: at.col, y: at.row, offMm: at.offMm, onPlane: Math.abs(at.offMm) <= reach };
}
