/* =====================================================================================
 * Measurements: length, area and region statistics, computed in the units they mean.
 *
 * WHY MEASUREMENT TOOLS ARE PERMITTED ON THIS SURFACE AND EDITING IS NOT
 * ------------------------------------------------------------------------
 * `MOS-UI-204` and `MOS-UI-010` enumerate what may not be built: brush, eraser, scissors,
 * region-grow, threshold primitive, label-map interpolation, segmentation undo stack,
 * contour drawing, scribble, mask editing. Every one of those PRODUCES OR MUTATES A LABEL
 * MAP, which is what makes them annotation authoring.
 *
 * A caliper and an ROI produce a NUMBER. They cannot be the producer of an `AnnotationSet`,
 * and chapter 19 §19.4.1's own table uses exactly their presence to classify RadiAnt as a
 * *viewer* rather than an annotation tool: "It has measurement and ROI tools -- length,
 * angle, elliptical ROI with HU statistics -- and it does not have a volumetric
 * segmentation editor." So this module is on the permitted side of that line, and the line
 * is drawn where the spec drew it rather than where it would be convenient.
 *
 * THE ARITHMETIC IS THE POINT, AND IT IS GOVERNED
 * -------------------------------------------------
 * `MOS-IMG-039`/`MOS-IMG-041` make a measurement computed anywhere but the source array
 * "a defect, not an approximation". So every function here takes the FRAME -- the stored
 * `Int16Array` plus its `slope`, `intercept` and `pixelSpacing` -- and never a canvas, a
 * screen coordinate or a windowed grey level. A mean HU read off the display would change
 * when the reader changed the window, which is a measurement that depends on how you were
 * looking at it.
 *
 * MILLIMETRES COME FROM THE FRAME, NOT FROM A CONSTANT
 * ------------------------------------------------------
 * `(0028,0030) PixelSpacing` is `[row spacing, column spacing]` and the two are frequently
 * unequal. Worse, a RECONSTRUCTED plane has entirely different spacing from the acquired
 * one: `mpr.js` returns `[sliceSpacing, inPlaneSpacing]` for a coronal frame, so a caliper
 * that assumed square pixels would be right on axial and wrong by a factor of three on
 * coronal of a 3 mm study -- and would look identical. Every function takes its spacing
 * from the frame it was given.
 *
 * WHAT IS NOT HERE
 * -----------------
 * No volume. A volume measurement spans slices, and summing an ROI across a stack asserts
 * the operator drew the same structure on each one -- an assertion no caliper makes.
 * `lung_segmentation` already reports volume from a segmentation, which is where a volume
 * has evidence behind it. A per-slice tool that produced one would be competing with a
 * measured number using an assumed one.
 *
 * Spec: MOS-IMG-039, MOS-IMG-041, MOS-UI-010, MOS-UI-204, MOS-CORE-004 (units are
 * vocabulary), MOS-SVC-020 (a score is a calibrated thing; none of these produce one).
 * ===================================================================================== */

import { notMeasuredAt } from './units.js';

/**
 * Hounsfield value of one pixel, from the stored array.
 *
 * The same `slope * stored + intercept` the shader applies, computed on the CPU copy. Not
 * exported as the general path: callers measuring a region should use `regionStatistics`,
 * which does this once per pixel without the bounds check per call.
 */
function huAt(frame, x, y) {
  return frame.slope * frame.pixels[y * frame.columns + x] + frame.intercept;
}

/**
 * Whether the STORED value at (x, y) is padding rather than measured signal.
 *
 * (0028,0120) PixelPaddingValue marks pixels that carry no measurement -- on CT, the area
 * outside the reconstruction circle, typically written as -2000. PS3.3 C.7.5.1.1.2: when
 * (0028,0121) PixelPaddingRangeLimit is present the two bound an inclusive RANGE, and when
 * it is absent the single value is the whole definition.
 *
 * THE TEST IS ON THE STORED VALUE, NOT THE RESCALED ONE. The attribute is defined in
 * stored units, and rescaling first then comparing against a stored threshold would be
 * comparing two different scales -- right on a slope of 1 and wrong everywhere else, which
 * is the kind of bug that survives every test written against CT.
 */

/**
 * Straight-line distance between two pixel coordinates, in millimetres.
 *
 * @param {object} frame  as produced by `mpr.reslice` or `volume.buildStack`
 * @param {{x:number,y:number}} a
 * @param {{x:number,y:number}} b
 * @returns {{mm:number, dxMm:number, dyMm:number}}
 */
export function length(frame, a, b) {
  const [rowMm, colMm] = frame.pixelSpacing;
  // x indexes COLUMNS and y indexes ROWS, so x scales by column spacing and y by row
  // spacing. Reversing these is the single easiest way to produce a caliper that is
  // plausible on square pixels and wrong on every anisotropic study.
  const dxMm = (b.x - a.x) * colMm;
  const dyMm = (b.y - a.y) * rowMm;
  // THE PIXEL DISTANCE TOO, because on a frame with no stated (0028,0030) it is the only
  // one of the two that was actually measured. `volume.js` substitutes a spacing of [1, 1]
  // there, which makes `mm` a pixel count wearing a unit; the renderers show this instead.
  const px = Math.hypot(b.x - a.x, b.y - a.y);
  return { mm: Math.hypot(dxMm, dyMm), dxMm, dyMm, px };
}

/**
 * Angle at `vertex` between two rays, in degrees, measured in PATIENT space.
 *
 * Computed on the millimetre vectors rather than the pixel ones. On an anisotropic frame
 * the two differ: a 45-degree angle in pixels is not 45 degrees in the patient when the
 * spacing is 1 mm by 3 mm, and the pixel answer is the one that looks right on screen.
 */
export function angle(frame, a, vertex, b) {
  const [rowMm, colMm] = frame.pixelSpacing;
  const u = [(a.x - vertex.x) * colMm, (a.y - vertex.y) * rowMm];
  const v = [(b.x - vertex.x) * colMm, (b.y - vertex.y) * rowMm];
  const nu = Math.hypot(u[0], u[1]);
  const nv = Math.hypot(v[0], v[1]);
  if (!nu || !nv) return NaN;
  const cos = Math.min(1, Math.max(-1, (u[0] * v[0] + u[1] * v[1]) / (nu * nv)));
  return (Math.acos(cos) * 180) / Math.PI;
}

/** Whether (x,y) lies inside the ellipse inscribed in the given pixel bounding box. */
function insideEllipse(x, y, box) {
  const cx = (box.x0 + box.x1) / 2;
  const cy = (box.y0 + box.y1) / 2;
  const rx = Math.abs(box.x1 - box.x0) / 2;
  const ry = Math.abs(box.y1 - box.y0) / 2;
  if (!rx || !ry) return false;
  const nx = (x - cx) / rx;
  const ny = (y - cy) / ry;
  return nx * nx + ny * ny <= 1;
}

/**
 * Whether a pixel centre lies inside a closed polygon. Even-odd (crossing) rule.
 *
 * THE RAY IS CAST IN +x FROM THE PIXEL CENTRE and crossings are counted. A vertex
 * exactly on the ray is the classic degenerate case, and the `(yi > y) !== (yj > y)`
 * form handles it by treating each edge as half-open in y: an edge contributes only if
 * the ray passes its lower endpoint and not its upper one, so a vertex shared by two
 * edges is counted once rather than twice or zero times. Written this way deliberately;
 * the naive `yi <= y && y < yj` form double-counts horizontal-adjacent vertices and
 * produces single-pixel holes along a traced outline, which look like noise in the mean.
 *
 * SELF-INTERSECTION IS NOT AN ERROR. A reader tracing freehand crosses their own line
 * constantly. Under even-odd the doubly-enclosed lobe falls OUT, which is the
 * conventional reading of a crossed outline and is stable -- as opposed to refusing,
 * which would throw away a measurement over a wobble the reader did not notice making.
 *
 * @param {number} x
 * @param {number} y
 * @param {Array<{x:number,y:number}>} pts
 */
function insidePolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x;
    const yi = pts[i].y;
    const xj = pts[j].x;
    const yj = pts[j].y;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Statistics over a FREEHAND closed region, in the units of the stored array.
 *
 * WHAT THIS IS PERMITTED TO BE, because the question is not rhetorical here.
 * `MOS-UI-010a` (specification 0.3.0) permits reader-drawn geometry whose ONLY output is
 * scalar, and `MOS-CORE-045` still forbids building an annotation authoring tool. The
 * line is the OUTPUT, and this function is on the permitted side of it by construction:
 * it returns counts and moments and it cannot return anything else. The vertices are
 * kept on the RECORD so the shape can be redrawn and re-measured when the reader drags
 * it, and `MOS-UI-010a` clause 1 requires exactly that they never leave as a contour --
 * which is why there is no `toMask`, no `toContour` and no SEG writer anywhere near it.
 *
 * @param {object} frame
 * @param {Array<{x:number,y:number}>} points  pixel coordinates, implicitly closed
 * @returns {{count:number, mean:number, sd:number, min:number, max:number,
 *            areaMm2:number, shape:string, excluded:number, areaPx:number}}
 */
export function polygonStatistics(frame, points) {
  const pts = Array.isArray(points) ? points.filter((p) => p && Number.isFinite(p.x)
    && Number.isFinite(p.y)) : [];
  // THREE VERTICES IS A TRIANGLE; two is a line and encloses nothing. A click that did
  // not become a drag must measure nothing rather than one pixel with an sd of 0.
  if (pts.length < 3) {
    return {
      shape: 'polygon', count: 0, excluded: 0, areaPx: 0, mean: NaN, sd: NaN,
      min: NaN, max: NaN, areaMm2: 0,
    };
  }

  const [rowMm, colMm] = frame.pixelSpacing;
  // The bounding box is the ITERATION domain only; the polygon decides membership.
  const x0 = Math.max(0, Math.min(frame.columns - 1,
    Math.floor(Math.min(...pts.map((p) => p.x)))));
  const x1 = Math.max(0, Math.min(frame.columns - 1,
    Math.ceil(Math.max(...pts.map((p) => p.x)))));
  const y0 = Math.max(0, Math.min(frame.rows - 1,
    Math.floor(Math.min(...pts.map((p) => p.y)))));
  const y1 = Math.max(0, Math.min(frame.rows - 1,
    Math.ceil(Math.max(...pts.map((p) => p.y)))));

  let count = 0;
  let mean = 0;
  let m2 = 0;
  let min = Infinity;
  let max = -Infinity;
  let excluded = 0;
  const notMeasured = notMeasuredAt(frame);

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!insidePolygon(x, y, pts)) continue;
      // Padding is not tissue. Same rule, same reason, as `regionStatistics`.
      if (notMeasured(y * frame.columns + x)) { excluded += 1; continue; }
      const hu = frame.slope * frame.pixels[y * frame.columns + x] + frame.intercept;
      count += 1;
      const delta = hu - mean;
      mean += delta / count;
      m2 += delta * (hu - mean);
      if (hu < min) min = hu;
      if (hu > max) max = hu;
    }
  }

  return {
    shape: 'polygon',
    count,
    excluded,
    areaPx: count,
    mean: count ? mean : NaN,
    sd: count ? Math.sqrt(m2 / count) : NaN,
    min: count ? min : NaN,
    max: count ? max : NaN,
    // The pixels ENCLOSED times the area of one -- not the shoelace area of the outline.
    // They differ by the boundary pixels, and this is the one that matches the mean
    // sitting beside it. Same argument as `regionStatistics`.
    areaMm2: count * rowMm * colMm,
  };
}

/**
 * Statistics over a region, in Hounsfield units, from the stored array.
 *
 * @param {object} frame
 * @param {{x0:number,y0:number,x1:number,y1:number}} box  pixel bounding box, any corner order
 * @param {'ellipse'|'rectangle'} shape
 * @returns {{count:number, mean:number, sd:number, min:number, max:number,
 *            areaMm2:number, shape:string}}
 *
 * SD IS THE POPULATION SD, not the sample one. The region is not a sample drawn from a
 * larger population of pixels -- it IS the pixels the reader enclosed, all of them -- so
 * the `n-1` correction has nothing to correct for. Stated because the two differ visibly
 * on the small ROIs a reader actually draws, and a viewer that quietly used `n-1` would
 * disagree with one that did not for no reason either could explain.
 *
 * A SINGLE PASS, in float64. The naive two-pass mean-then-variance is fine here too, but
 * Welford's is one pass over what can be a 200x200 region on every pointer move, and
 * accumulating squares of HU values -- which reach 3000 -- in float32 is the saturation
 * failure this project has already paid for once in the training metric.
 */
export function regionStatistics(frame, box, shape = 'ellipse') {
  const x0 = Math.max(0, Math.min(frame.columns - 1, Math.floor(Math.min(box.x0, box.x1))));
  const x1 = Math.max(0, Math.min(frame.columns - 1, Math.ceil(Math.max(box.x0, box.x1))));
  const y0 = Math.max(0, Math.min(frame.rows - 1, Math.floor(Math.min(box.y0, box.y1))));
  const y1 = Math.max(0, Math.min(frame.rows - 1, Math.ceil(Math.max(box.y0, box.y1))));

  const [rowMm, colMm] = frame.pixelSpacing;
  let count = 0;
  let mean = 0;
  let m2 = 0;
  let min = Infinity;
  let max = -Infinity;

  let excluded = 0;
  // Hoisted: the declaration is a property of the frame, not of the pixel, and asking per
  // pixel would rebuild the same closure once per sample inside the hot loop.
  const notMeasured = notMeasuredAt(frame);

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (shape === 'ellipse' && !insideEllipse(x, y, box)) continue;
      // PADDING IS NOT TISSUE AND MUST NOT ENTER THE MEAN. A CT pads outside the
      // reconstruction circle with a value like -2000, so an ROI that overlaps the edge
      // has its mean dragged toward a number no scanner measured. The count of what was
      // left out travels with the result: an ROI the reader drew over 500 pixels that
      // reports 380 needs to say why, or the area beside the mean stops matching the
      // shape on screen.
      if (notMeasured(y * frame.columns + x)) { excluded += 1; continue; }
      const hu = huAt(frame, x, y);
      count += 1;
      const delta = hu - mean;
      mean += delta / count;
      m2 += delta * (hu - mean);
      if (hu < min) min = hu;
      if (hu > max) max = hu;
    }
  }

  return {
    shape,
    count,
    /** Pixels inside the shape that were padding, and so contributed to nothing above. */
    excluded,
    /** The area as a PIXEL count, which is what was measured when no spacing was stated. */
    areaPx: count,
    mean: count ? mean : NaN,
    // Population SD: see the docstring.
    sd: count ? Math.sqrt(m2 / count) : NaN,
    min: count ? min : NaN,
    max: count ? max : NaN,
    // Area is the number of pixels ENCLOSED times the physical area of one, not the area
    // of the ellipse from its radii. They differ at small sizes by the pixels the boundary
    // cuts, and the enclosed count is the one that matches the statistics above -- an area
    // computed a different way from the mean it sits beside invites the reader to divide
    // one by the other and get a density that is wrong in the third digit.
    areaMm2: count * rowMm * colMm,
  };
}

/**
 * A measurement, with everything needed to say what it is a measurement OF.
 *
 * A number without its slice is not reproducible: the same ROI on the next slice is a
 * different number, and a panel listing "mean -412 HU" with no location cannot be checked
 * by anyone. `MOS-EVID-*`'s provenance discipline applied one level down.
 */
/**
 * A measurement's identity.
 *
 * THERE WAS NONE. A record carried no id and no label, the panel deleted by ARRAY POSITION
 * (`data-drop="${i}"`), and three nodules on one slice gave three rows all reading
 * "length axial 33". Nothing downstream could refer to a particular measurement, which is
 * why nothing downstream could select, edit or jump to one.
 *
 * `crypto.randomUUID` where it exists -- this page is served over http://127.0.0.1, which
 * is a secure context, so it does. The counter is not a fallback for correctness but for
 * the case where it is served from somewhere that is not: ids only have to be unique
 * within one session, because nothing persists them yet.
 */
let measurementSeq = 0;
// NOT EXPORTED. It is how `describeMeasurement` and `remeasure` mint an id, and a
// second minter outside this module would be a second source of identity for the
// same kind of thing -- which the dead-export gate said, by refusing an export that
// nothing outside calls.
function measurementId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  measurementSeq += 1;
  return `m${measurementSeq}`;
}

export function describeMeasurement(kind, frame, location, value) {
  return Object.freeze({
    id: measurementId(),
    kind,
    plane: location.plane,
    // The ADDRESS above, the NAME here. A reader reads the name; `followIndex`,
    // `reslice` and the annotation layer's match key all need the address, and one
    // field cannot be both without something being wrong for somebody.
    planeName: location.planeName ?? null,
    sliceIndex: location.index,
    // WHICH SERIES, because a plane and a slice number are not an address. Two series
    // in a 2x2 both have an axial slice 33, and the annotation layer matched on those
    // two fields alone -- so a caliper taken on one was drawn over the other, on
    // anatomy it was never taken from.
    seriesUID: location.seriesUID ?? null,
    // AND WHICH STUDY, for the reason above carried one level up. A series UID says which
    // pictures; it does not say which VISIT, and the surface can now hold a current study
    // beside its prior. This is the field the session store files the record under, so its
    // absence is not cosmetic: measured on the running viewer with a prior open, a caliper
    // drawn on the prior's panel was written into the CURRENT study's record, because the
    // store fell back to the one study the shell had a variable for. The panel's own
    // address knew the answer; the record simply was not asked to carry it.
    studyUID: location.studyUID ?? null,
    sopInstanceUID: frame.sopInstanceUID || null,
    pixelSpacing: [...frame.pixelSpacing],
    value,
    // THE UNIT TRAVELS WITH THE MEASUREMENT, not with whatever panel happens to render it.
    // A row in the measurements table outlives the frame it was taken on -- the reader
    // scrolls, the panel stays -- so a panel that looked up the unit from the CURRENT
    // frame would relabel an old measurement whenever the active series changed.
    valueUnit: frame.valueUnit ?? null,
    // AND WHETHER THE PIXELS WERE A PROJECTION. An ROI on a MIP averages per-ray maxima,
    // which is a real number describing no tissue. Recording it here rather than looking it
    // up at render time means a row cannot be relabelled by the reader switching the slab
    // off after taking it.
    projection: frame.projection ?? null,
    // AND WHAT THE PLANE RESOLVED. An oblique is drawn on a finer grid than it resolves, so
    // a caliper down its coarse axis over-reports. Recorded here rather than looked up at
    // render time, because the row outlives the frame it was taken on.
    resolutionMm: frame.resolutionMm ? [...frame.resolutionMm] : null,
    // AND WHETHER THE MILLIMETRES WERE MEASURED OR ASSUMED. `pixelSpacing` above is [1, 1]
    // on a frame that never stated one, so every mm below is a pixel count wearing a unit.
    spacingStated: frame.hasPixelSpacing !== false,
    // RESEARCH USE ONLY travels with the number, because a measurement copied out of this
    // surface into a report loses the footer that said so (MOS-SAFE-001, MOS-UI-008).
    clinicalUse: 'research_only',
  });
}


/**
 * Re-measure a record whose geometry the reader has moved.
 *
 * WHY THE WHOLE RECORD IS REBUILT rather than the value patched in. Every field
 * `describeMeasurement` freezes is a statement about the frame the measurement was taken
 * on -- the spacing used, whether that spacing was stated, whether the pixels were a
 * projection, what the plane resolved, which instance it came from. A caliper that is
 * DRAGGED is still a measurement of the frame in front of the reader, and that frame is
 * necessarily the one it was taken on, because a measurement is only drawn on its own
 * slice and its own series. Patching `value` alone would leave a record whose number came
 * from one moment and whose provenance came from another, which is the exact defect this
 * codebase has found in four other places.
 *
 * THE ID SURVIVES, because it is the one field that is not about the frame: it is what the
 * panel row, the selection and the annotation element all use to mean THIS measurement,
 * and a new one would make an edit look like a delete and an insert.
 *
 * @param {object} m       the record, with `points` or `box` already moved
 * @param {object} frame   the frame it is drawn on
 * @returns {object|null}  a new frozen record, or null if the kind has no arithmetic here
 */
export function remeasure(m, frame) {
  if (!m || !frame) return null;
  // `planeName` travels through the rebuild. A measurement dragged by a handle is the
  // same measurement on the same plane, and a name that vanished on the first edit
  // would put the row back to printing the address.
  const location = {
    plane: m.plane, index: m.sliceIndex, seriesUID: m.seriesUID,
    // THE STUDY SURVIVES A DRAG. Without it, moving a handle rebuilds the record with
    // `studyUID: null` and the store then files the edited measurement under whichever
    // study the shell arrived at -- so dragging a caliper on a prior would move it into
    // the current study's record, which is the original defect wearing an edit as a
    // disguise.
    studyUID: m.studyUID ?? null,
    planeName: m.planeName ?? null,
  };

  if (m.kind === 'length' && m.points && m.points.length >= 2) {
    const value = length(frame, m.points[0], m.points[1]);
    return Object.freeze({
      ...describeMeasurement('length', frame, location, value),
      id: m.id, kind: 'length', points: m.points.map((p) => ({ ...p })), label: m.label ?? null,
    });
  }

  if (m.kind === 'angle' && m.points && m.points.length >= 3) {
    const value = angle(frame, m.points[0], m.points[1], m.points[2]);
    return Object.freeze({
      ...describeMeasurement('angle', frame, location, value),
      id: m.id, kind: 'angle', points: m.points.map((p) => ({ ...p })), label: m.label ?? null,
    });
  }

  // A NOTE HAS NOTHING TO RE-MEASURE, and still has to be REBUILT. Dragging it moves
  // the anchor to a new pixel, so the provenance -- which slice, which SOP instance,
  // what spacing -- is different afterwards even though no number changed. Returning
  // the record unchanged would leave a note claiming the slice it was first placed on.
  if (m.kind === 'note') {
    const points = (m.points || []).map((p) => ({ ...p }));
    return Object.freeze({
      ...describeMeasurement('note', frame, location, null),
      id: m.id, kind: 'note', points, text: m.text ?? '', label: m.label ?? null,
    });
  }

  // A FREEHAND REGION IS RE-MEASURED FROM ITS VERTICES, which is why they are kept.
  // Dragging one moves a vertex, not a bounding box, so there is nothing to derive it
  // from -- and a polygon that fell back to its bounding box on the first edit would
  // report the area of a rectangle it never drew.
  if (m.kind === 'roi' && m.shape === 'polygon' && Array.isArray(m.points)) {
    const points = m.points.map((p) => ({ ...p }));
    const value = polygonStatistics(frame, points);
    return Object.freeze({
      ...describeMeasurement('roi', frame, location, value),
      id: m.id, kind: 'roi', shape: 'polygon', points, label: m.label ?? null,
    });
  }

  if (m.kind === 'roi' && m.box) {
    const box = { ...m.box };
    // RESOLVED ONCE, then both USED AND RECORDED. The shape was read here to compute and
    // then left out of the record returned, so a rectangle dragged by a corner measured as
    // a rectangle that one time and came back without a shape: drawn as an ellipse from
    // then on, and measured as one on the next drag. The reader saw a rectangle turn into
    // an ellipse and its numbers change, having asked for neither.
    const shape = m.shape || 'ellipse';
    const value = regionStatistics(frame, box, shape);
    return Object.freeze({
      ...describeMeasurement('roi', frame, location, value),
      id: m.id, kind: 'roi', shape, box, label: m.label ?? null,
    });
  }

  return null;
}
