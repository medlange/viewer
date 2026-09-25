// SPDX-License-Identifier: Apache-2.0
/* =====================================================================================
 * One acquisition sampled onto another's grid, so two modalities can be read as one
 * picture. PET on CT is the case this exists for.
 *
 * WHY THIS RESAMPLES WHEN `seg.js` REFUSES TO
 * --------------------------------------------
 * `decodeSegmentation` raises `segmentation_geometry_mismatch` rather than resample, and
 * its reason is written there: "Resampling one onto the other would move boundaries
 * without saying so." That is right about a SEGMENTATION. A mask is an assertion someone
 * authored -- a boundary drawn at a place -- and moving it is altering the assertion.
 *
 * A PET is not an assertion. It is a measured field, and PET and CT are NEVER acquired on
 * one grid: this project's own synthetic pair is 128x128 at 2.8 mm against 320x448 at
 * 0.7 mm, which is a real scanner's shape. Refusing to resample would not be caution, it
 * would be refusing the modality pair. So this module resamples, and pays the same debt
 * `seg.js` pays by refusing: it SAYS what it did, and what the result may not be used for.
 *
 * WHAT THE RESULT MAY NOT BE USED FOR
 * ------------------------------------
 * Measurement. Every value here is interpolated between voxels that were measured, and an
 * ROI over interpolated values reports a number no scanner produced -- the same defect
 * `measure.js` avoids by dropping (0028,0120) padding from a mean. The caller is given
 * `interpolated: true` and the surface states it; nothing in this file computes a
 * statistic and nothing should.
 *
 * WHAT IT REFUSES
 * ---------------
 * A different frame of reference, in either direction. Two series that do not assert a
 * shared patient coordinate system have positions that are not comparable, which is
 * exactly what `positionLinkable` refuses for scroll linking -- and drawing one over the
 * other would be a stronger claim than linking them, made with less.
 * ===================================================================================== */

import { DicomRefusal } from '../dicom/parse.js';
import { patientToPixel, pixelToPatient } from './reference.js';

/**
 * Sample `source` at every pixel of `target`.
 *
 * @param {object} source  a stack -- the acquisition being laid over
 * @param {object} target  a frame -- the one on screen, acquired or reconstructed
 * @returns {{values:Float32Array, rows:number, columns:number, inside:number,
 *            total:number, unit:string|null, min:number, max:number,
 *            interpolated:true}}
 */
export function resampleOnto(source, target) {
  if (!source || !source.frames || !source.frames.length) {
    throw new DicomRefusal('fusion_no_source', 'there is no second series to lay over.');
  }
  if (!target || !target.rows || !target.columns) {
    throw new DicomRefusal('fusion_no_target', 'this panel is showing no frame to lay over.');
  }

  const sourceFrame = source.frames[0];
  const a = String(sourceFrame.frameOfReferenceUID || source.frameOfReferenceUID || '');
  const b = String(target.frameOfReferenceUID || '');
  if (!a || !b || a !== b) {
    throw new DicomRefusal(
      'fusion_frame_of_reference',
      'the two series do not assert a shared patient coordinate system, so one cannot be '
      + 'positioned on the other. Scroll linking refuses the same pair for the same '
      + 'reason, and drawing one THROUGH the other is a larger claim than linking them.',
    );
  }

  // THE NORMAL COMES FROM THE STACK, not from a frame, because a frame is not required to
  // carry one and the depth of every frame in the stack was computed against the stack's.
  const normal = source.normal || sourceFrame.normal;
  if (!normal || normal.length !== 3) {
    throw new DicomRefusal(
      'fusion_no_geometry',
      'the series being laid over states no slice direction, so a patient point cannot be '
      + 'placed in it.',
    );
  }

  const probe = pixelToPatient(target, 0, 0);
  if (!probe) {
    throw new DicomRefusal(
      'fusion_no_geometry',
      'the frame on screen states no patient position or no pixel spacing, so there is '
      + 'nothing to sample the other series AT.',
    );
  }

  const { rows, columns } = target;
  const values = new Float32Array(rows * columns);
  const frames = source.frames;           // sorted by depth, `volume.js`
  const depths = frames.map((f) => f.depth);

  // The two direction vectors of the TARGET frame, so the inner loop is two adds rather
  // than a `pixelToPatient` call per pixel: 320x448 is 143360 of them per draw.
  const ex = target.orientation.slice(0, 3);
  const ey = target.orientation.slice(3, 6);
  const [rowMm, colMm] = target.pixelSpacing;
  const origin = target.position;

  let inside = 0;
  let min = Infinity;
  let max = -Infinity;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const px = origin[0] + c * colMm * ex[0] + r * rowMm * ey[0];
      const py = origin[1] + c * colMm * ex[1] + r * rowMm * ey[1];
      const pz = origin[2] + c * colMm * ex[2] + r * rowMm * ey[2];

      const depth = px * normal[0] + py * normal[1] + pz * normal[2];
      const at = bracket(depths, depth);
      if (!at) continue;

      const lower = sampleFrame(frames[at.lo], [px, py, pz]);
      if (lower === null) continue;
      let v = lower;
      if (at.hi !== at.lo) {
        const upper = sampleFrame(frames[at.hi], [px, py, pz]);
        if (upper === null) continue;
        v = lower + (upper - lower) * at.t;
      }

      values[r * columns + c] = v;
      inside++;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }

  return {
    values,
    rows,
    columns,
    inside,
    total: rows * columns,
    unit: source.valueUnit ?? null,
    min: inside ? min : 0,
    max: inside ? max : 0,
    interpolated: true,
  };
}

/**
 * The two slices a depth falls between, and how far along it is.
 *
 * OUTSIDE THE VOLUME IS NOT CLAMPED TO ITS FACE. A patient point beyond the last slice
 * has no measurement in this series, and returning the nearest one would paint the end
 * slice's uptake across everything past it -- an extrapolation that looks like data.
 */
function bracket(depths, depth) {
  const n = depths.length;
  if (!n) return null;
  const first = depths[0];
  const last = depths[n - 1];
  const ascending = last >= first;
  const lo = ascending ? first : last;
  const hi = ascending ? last : first;
  if (depth < lo || depth > hi) return null;
  if (n === 1) return { lo: 0, hi: 0, t: 0 };

  // Binary search over a list `volume.js` has already sorted by depth.
  let a = 0;
  let b = n - 1;
  while (b - a > 1) {
    const mid = (a + b) >> 1;
    const between = ascending ? depths[mid] <= depth : depths[mid] >= depth;
    if (between) a = mid; else b = mid;
  }
  const span = depths[b] - depths[a];
  return { lo: a, hi: b, t: span === 0 ? 0 : (depth - depths[a]) / span };
}

/**
 * One frame's value at a patient point, bilinear in plane.
 *
 * NULL OUTSIDE THE FRAME rather than an edge value, for `bracket`'s reason: a point beside
 * the acquisition has no measurement, and the nearest one is a guess drawn as a fact.
 */
function sampleFrame(frame, mm) {
  const at = patientToPixel(frame, mm);
  if (!at) return null;
  const { col, row } = at;
  const { columns, rows, pixels, slope, intercept } = frame;
  if (col < 0 || row < 0 || col > columns - 1 || row > rows - 1) return null;

  const c0 = Math.floor(col);
  const r0 = Math.floor(row);
  const c1 = Math.min(columns - 1, c0 + 1);
  const r1 = Math.min(rows - 1, r0 + 1);
  const fc = col - c0;
  const fr = row - r0;

  const v = (rr, cc) => pixels[rr * columns + cc] * slope + intercept;
  const top = v(r0, c0) * (1 - fc) + v(r0, c1) * fc;
  const bottom = v(r1, c0) * (1 - fc) + v(r1, c1) * fc;
  return top * (1 - fr) + bottom * fr;
}
