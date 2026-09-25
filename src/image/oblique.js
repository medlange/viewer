/* =====================================================================================
 * Oblique planes: a cut at an angle to the lattice, and the two numbers that differ there.
 *
 * WHAT MAKES AN OBLIQUE DIFFERENT FROM THE THREE NAMED PLANES
 * -----------------------------------------------------------
 * Axial, coronal and sagittal select voxels ALONG the lattice. One step across the picture
 * is one voxel, so the distance between adjacent samples and the distance the picture can
 * resolve are the same number, and there has never been anything for a frame to declare.
 *
 * An oblique cuts ACROSS it, and the two come apart. Take this project's phantom -- 0.70 mm
 * pixels, 2.0 mm slices -- and cut at 45 degrees about the patient's left-right axis. The
 * row axis of the new plane runs `(ey - n)/sqrt(2)`, so it crosses a ROW boundary every
 * 0.70/0.7071 = 0.990 mm and a SLICE boundary every 2.0/0.7071 = 2.828 mm. Samples 0.990 mm
 * apart, detail no finer than 2.828 mm. The picture is drawn on the finer grid because that
 * is where the data changes; it resolves the coarser one.
 *
 * Nothing on screen can show that. A reader measuring the phantom's nodule down the rows of
 * such a plane gets 7.9 mm and across the columns gets 7.0 mm, on a solid that is symmetric
 * in the plane -- the 0.9 mm is the 2.83 mm row resolution over-reporting the extent. So the
 * frame carries `resolutionMm` beside `pixelSpacing`, and every surface that renders a
 * number off the plane says which is which.
 *
 * WHY ONE AXIS OF THE PLANE MUST STAY ON THE LATTICE
 * ---------------------------------------------------
 * The rule above is per-axis: the pitch along a direction is the closest spacing of the
 * voxel-layer families it crosses. That is sound for ONE oblique direction. Applied to two
 * at once it is not, because two-dimensional sample density is the product and not the
 * smaller factor -- a plane rotated in its own plane gets the same pitch on both axes, index
 * offsets that are always even, and half the volume unreachable while the picture looks
 * crisp. Worse, the two pitches come out equal, so `zoomForOneToOne` offers a 1:1 on the one
 * plane where half the data does not exist.
 *
 * So the vocabulary below can only NAME a plane with one lattice axis, and the restriction
 * is enforced by the grammar rather than by a guard. There is no `oblique_needs_a_lattice_axis`
 * refusal because there is no way to ask for one.
 *
 * Spec: MOS-IMG-039, MOS-IMG-041. See docs/adr/OBLIQUE_MPR_PLAN.md for the three designs
 * this was synthesised from and the two that died of their own attacks.
 * ===================================================================================== */

/**
 * Below this, a direction cosine is float noise rather than a crossing.
 *
 * SIZED TO A DICOM DS, not to a double. (0020,0037) is written as decimal strings of about
 * seven significant digits, so two cosines stated independently are not exactly orthogonal
 * once parsed: a real cardiac short-axis orientation gives `ex . ey = -1.9e-05`, and a
 * seven-decimal MR oblique gives `-7.2e-08`. Both are far above 1e-9, which is what this
 * was, so the near-parallel family counted as CROSSED.
 *
 * `pitchMm` is a minimum and shrugs that off. `coarsestMm` is a MAXIMUM and is maximally
 * sensitive to exactly the family the test exists to discard: measured, the same phantom
 * dimensions under a cardiac orientation reported `resolutionMm [52312.08, 36990.23]` and
 * under the seven-decimal one `[1.37e+07, 9.67e+06]` millimetres. The second number in each
 * pair is the LATTICE axis the plane keeps -- the one this module promises can never differ
 * from its pitch -- so the sentence on screen named the exact axis that resolves exactly.
 *
 * 1e-6 is below any obliquity a reader could see (it is a millionth of a unit vector) and
 * four orders of magnitude above the residual a stated orientation carries.
 */
const EPS = 1e-6;

/** One decimal, which is the precision the name is canonical at. */
const DECIMALS = 1;

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function scale(v, k) {
  return [v[0] * k, v[1] * k, v[2] * k];
}

/**
 * The source's three axes, made exactly orthonormal.
 *
 * WHY THIS IS NOT A TOLERANCE QUESTION. (0020,0037) is written as decimal strings of about
 * seven significant digits, so two cosines stated independently are not orthogonal once
 * parsed. A real cardiac short-axis orientation gives `ex . ey = -1.9e-05`. That is not
 * noise to be thresholded away -- it is a stated value that is very slightly wrong, and the
 * standard says the two SHALL be orthogonal, so the honest reading is the nearest
 * orthonormal pair rather than the literal one.
 *
 * It matters here and almost nowhere else, because `crossingsAlong` takes a MAXIMUM over
 * `spacing / |w . axis|`. A residual of 1e-5 in the wrong place makes that quotient 70000,
 * and the frame reported `resolutionMm [52312.08, 36990.23]` millimetres -- the second of
 * those being the LATTICE axis the plane keeps, the one axis this module promises resolves
 * exactly. The picture and the pitch were unaffected throughout, because a minimum is not
 * sensitive to a family it barely crosses. Only the sentence on screen was wrong, and it
 * was wrong about the axis it had least business being wrong about.
 *
 * Gram-Schmidt: keep ex, remove its component from ey, renormalise both, and take the
 * normal as their cross product rather than the stack's stored one -- which was derived
 * from the same unorthogonalised pair.
 */
function basisOf(stack) {
  if (stack._obliqueBasis) return stack._obliqueBasis;
  const o = stack.frames[0].orientation;
  const rawX = [o[0], o[1], o[2]];
  const rawY = [o[3], o[4], o[5]];

  const nx = Math.hypot(rawX[0], rawX[1], rawX[2]) || 1;
  const ex = scale(rawX, 1 / nx);
  const proj = dot(rawY, ex);
  const perp = [rawY[0] - proj * ex[0], rawY[1] - proj * ex[1], rawY[2] - proj * ex[2]];
  const ny = Math.hypot(perp[0], perp[1], perp[2]) || 1;
  const ey = scale(perp, 1 / ny);

  stack._obliqueBasis = { ex, ey, n: cross(ex, ey) };
  return stack._obliqueBasis;
}

function combine(u, su, v, sv) {
  return [u[0] * su + v[0] * sv, u[1] * su + v[1] * sv, u[2] * su + v[2] * sv];
}

/**
 * The canonical name of an oblique plane, or null when the request names one that already
 * has a name.
 *
 * A PLANE IS AN ADDRESS IN THIS CODEBASE, not a parameter. `annotations.js` compares it with
 * `===` as the key every measurement is drawn by, `app.js` keeps it in a DOM dataset, and the
 * measurements panel prints it into a table cell. An object would make that comparison
 * reference equality: two panels on the same oblique would never share a caliper, and a
 * panel re-entering the plane after a layout change would lose every measurement taken
 * there while still listing it. So the vocabulary is open in its values and closed in its
 * grammar, and exactly one function mints a member of it.
 *
 * 0 and 90 degrees are excluded because they ARE the named planes -- a second name for the
 * axial splits that address in half.
 *
 * @param {'x'|'y'} axis  the lattice axis the plane keeps
 * @param {number} deg    strictly inside (-90, 90), excluding 0
 */
export function obliqueName(axis, deg) {
  if (axis !== 'x' && axis !== 'y') return null;
  if (!Number.isFinite(deg)) return null;
  const rounded = Number(deg.toFixed(DECIMALS));
  if (!(Math.abs(rounded) > 0) || Math.abs(rounded) >= 90) return null;
  const sign = rounded < 0 ? '-' : '+';
  return `oblique ${axis}${sign}${Math.abs(rounded).toFixed(DECIMALS)}°`;
}

/** Whether a plane name is an oblique at all. The only test anything outside makes. */
export function isOblique(plane) {
  return typeof plane === 'string' && plane.startsWith('oblique ');
}

/** The axis and angle a canonical name carries, or null when the string is not one. */
export function obliqueParts(plane) {
  if (!isOblique(plane)) return null;
  const m = /^oblique ([xy])([+-])(\d+\.\d)°$/.exec(plane);
  if (!m) return null;
  return { axis: m[1], deg: (m[2] === '-' ? -1 : 1) * Number(m[3]) };
}

/**
 * How far apart, along `w`, the crossings of each voxel-layer family are.
 *
 *     crossing_k = d_k / |w . e_k|     e = [ex, ey, n]   d = [colMm, rowMm, sliceSpacing]
 *
 * THE MINIMUM IS THE SAMPLE PITCH AND THE MAXIMUM IS WHAT THE AXIS RESOLVES, and they are
 * the same formula because they are the same question asked of a different family. Crossing
 * the closest-spaced family is what makes the value change; crossing the widest-spaced one
 * is the finest detail the direction can carry.
 *
 * A family the direction is parallel to is never crossed, so it constrains nothing and is
 * left out of both. On every named plane exactly one family is crossed, so the two answers
 * are equal -- which is why no existing frame has ever had anything to declare.
 *
 * ONE decision point: the pixel spacing, the resolution, the plane's step and the slab
 * thickness all ask this.
 *
 * @returns {{pitchMm:number, coarsestMm:number}}
 */
export function crossingsAlong(stack, w) {
  const { ex, ey, n } = basisOf(stack);
  const [rowMm, colMm] = stack.frames[0].pixelSpacing;

  const families = [
    [ex, colMm],
    [ey, rowMm],
    [n, stack.sliceSpacing],
  ];

  let pitchMm = Infinity;
  let coarsestMm = 0;
  for (const [axis, spacing] of families) {
    const share = Math.abs(dot(w, axis));
    if (share < EPS) continue;
    const crossing = spacing / share;
    if (crossing < pitchMm) pitchMm = crossing;
    if (crossing > coarsestMm) coarsestMm = crossing;
  }
  return { pitchMm, coarsestMm };
}

/**
 * How far the volume extends along `w`, in millimetres.
 *
 * THE FULL BOUNDING EXTENT, never the chord through the volume at this index. A grid cut to
 * the chord changes size as the reader scrolls, so `fitOf` refits every frame and the zoom
 * jumps under the cursor -- on a plane whose whole purpose is to be scrolled through.
 */
function spanAlong(stack, w) {
  const { ex, ey, n } = basisOf(stack);
  const [rowMm, colMm] = stack.frames[0].pixelSpacing;
  return Math.abs(dot(w, ex)) * stack.columns * colMm
    + Math.abs(dot(w, ey)) * stack.rows * rowMm
    + Math.abs(dot(w, n)) * stack.depth * stack.sliceSpacing;
}

/**
 * Everything about an oblique plane that does not depend on which slice of it is shown.
 *
 * Cached per stack per name: the trigonometry and the bounding box are the same at every
 * index, and `reslice` is called on every scroll.
 *
 * Returns null when the stack cannot carry an oblique at all -- `reconstructionRefusal`
 * reports which of the reasons applies and is what a caller should ask; this merely
 * declines to invent a grid.
 */
export function obliqueGrid(stack, plane) {
  const parts = obliqueParts(plane);
  if (!parts) return null;

  const first = stack.frames[0];
  if (!first || first.orientation.length !== 6 || first.position.length !== 3) return null;

  stack._oblique = stack._oblique || new Map();
  const hit = stack._oblique.get(plane);
  if (hit) return hit;

  const { ex, ey, n } = basisOf(stack);
  const down = [-n[0], -n[1], -n[2]];
  const theta = (parts.deg * Math.PI) / 180;
  const c = Math.cos(theta);
  const s = Math.sin(theta);

  // e1 is the LATTICE axis the plane keeps and e2 is the one that tilts. On 'x' the kept
  // axis is the source's column direction, so theta = 90 reproduces `reconstructedGeometry`'s
  // coronal `[...ex, ...down]` exactly; on 'y' theta = 0 is its sagittal `[...ey, ...down]`.
  const e1 = parts.axis === 'x' ? ex : ey;
  const e2 = parts.axis === 'x' ? combine(ey, c, down, s) : combine(down, c, ex, s);
  const nOb = cross(e1, e2);

  const along1 = crossingsAlong(stack, e1);
  const along2 = crossingsAlong(stack, e2);
  const alongN = crossingsAlong(stack, nOb);

  const columns = Math.max(1, Math.ceil(spanAlong(stack, e1) / along1.pitchMm));
  const rows = Math.max(1, Math.ceil(spanAlong(stack, e2) / along2.pitchMm));
  const depth = Math.max(1, Math.ceil(spanAlong(stack, nOb) / alongN.pitchMm));

  // WHERE THE BOX STARTS. The grid has to cover the volume from every index, so its origin
  // is the corner of the volume's bounding box in this plane's own coordinates -- the least
  // projection of the eight corners onto each of e1, e2 and the plane normal.
  const [rowMm, colMm] = first.pixelSpacing;
  const P0 = first.position;
  let lo1 = Infinity;
  let lo2 = Infinity;
  let loN = Infinity;
  for (const cc of [0, stack.columns]) {
    for (const rr of [0, stack.rows]) {
      for (const zz of [0, stack.depth]) {
        const q = [
          P0[0] + cc * colMm * ex[0] + rr * rowMm * ey[0] + zz * stack.sliceSpacing * n[0],
          P0[1] + cc * colMm * ex[1] + rr * rowMm * ey[1] + zz * stack.sliceSpacing * n[1],
          P0[2] + cc * colMm * ex[2] + rr * rowMm * ey[2] + zz * stack.sliceSpacing * n[2],
        ];
        lo1 = Math.min(lo1, dot(q, e1));
        lo2 = Math.min(lo2, dot(q, e2));
        loN = Math.min(loN, dot(q, nOb));
      }
    }
  }

  const grid = {
    axis: parts.axis,
    deg: parts.deg,
    e1,
    e2,
    normal: nOb,
    rows,
    columns,
    depth,
    /** What the samples are spaced at. The picture is drawn on this. */
    pixelSpacing: [along2.pitchMm, along1.pitchMm],
    /** What the samples can RESOLVE. Equal to the above on a named plane, coarser here. */
    resolutionMm: [along2.coarsestMm, along1.coarsestMm],
    stepMm: alongN.pitchMm,
    /** Patient position of pixel (0, 0) of the plane at `index`. */
    originAt(index) {
      const d = loN + index * alongN.pitchMm;
      return [
        lo1 * e1[0] + lo2 * e2[0] + d * nOb[0],
        lo1 * e1[1] + lo2 * e2[1] + d * nOb[1],
        lo1 * e1[2] + lo2 * e2[2] + d * nOb[2],
      ];
    },
  };
  stack._oblique.set(plane, grid);
  return grid;
}

/**
 * The pixels of one oblique plane, sampled nearest-neighbour from the packed volume.
 *
 * THE ROTATION IS IN PATIENT SPACE AND NOT IN INDEX SPACE, and that is the whole of the
 * arithmetic below. Rotating index coordinates as though the voxels were cubes is the
 * invisible version of this feature: on the phantom's 45 degree plane it advances the row
 * index and the slice index by 0.7071 each per sample, so a nodule spanning nine samples
 * reads as five -- a solid that measures 7.9 mm down the rows measuring 4.0 mm instead.
 * Both look like a round blob; only the count separates them.
 *
 * So each output pixel is placed in PATIENT millimetres and converted back through the
 * source's own direction cosines:
 *
 *     c = (Q - P0).ex / colMm     r = (Q - P0).ey / rowMm     z = (Q - P0).n / sliceSpacing
 *
 * which is affine exactly because the stack is unsheared -- `reconstructionRefusal` refuses
 * an oblique on a sheared one, because after a rounded rectification the volume's third
 * axis is the table's direction rather than the slice normal and this inverse is wrong by
 * up to half a row per slice.
 */
export function obliqueSample(stack, grid, index, volume, overlayVolume, fillValue) {
  const first = stack.frames[0];
  const { ex, ey, n } = basisOf(stack);
  const [rowMm, colMm] = first.pixelSpacing;
  const P0 = first.position;

  const { rows, columns } = grid;
  const [rowStep, colStep] = grid.pixelSpacing;
  const origin = grid.originAt(index);

  const out = new volume.constructor(rows * columns);
  const ovr = overlayVolume ? new Uint8Array(rows * columns) : null;
  // WHICH SAMPLES FELL OUTSIDE THE ACQUIRED BOX, as a mask rather than as a value.
  //
  // The fill has to be SOME number, and the only ones available are the declared padding
  // value or -- when the series declares none -- the volume's minimum. That minimum is real
  // acquired air, so declaring it as padding excluded genuine air from every ROI on the
  // plane. A mask says exactly which pixels the scanner never reached and leaves every
  // value in the volume meaning what it measured.
  const outside = new Uint8Array(rows * columns);
  const frameStride = stack.rows * stack.columns;

  for (let r = 0; r < rows; r++) {
    const br = [
      origin[0] + r * rowStep * grid.e2[0],
      origin[1] + r * rowStep * grid.e2[1],
      origin[2] + r * rowStep * grid.e2[2],
    ];
    for (let cIdx = 0; cIdx < columns; cIdx++) {
      const qx = br[0] + cIdx * colStep * grid.e1[0] - P0[0];
      const qy = br[1] + cIdx * colStep * grid.e1[1] - P0[1];
      const qz = br[2] + cIdx * colStep * grid.e1[2] - P0[2];

      const sc = Math.round((qx * ex[0] + qy * ex[1] + qz * ex[2]) / colMm);
      const sr = Math.round((qx * ey[0] + qy * ey[1] + qz * ey[2]) / rowMm);
      const sz = Math.round((qx * n[0] + qy * n[1] + qz * n[2]) / stack.sliceSpacing);

      const at = r * columns + cIdx;
      if (sc < 0 || sc >= stack.columns || sr < 0 || sr >= stack.rows
        || sz < 0 || sz >= stack.depth) {
        // OUTSIDE THE ACQUIRED BOX. A rectangle around a rotated volume has corners the
        // scanner never reached at every index, so the sample is marked rather than valued.
        out[at] = fillValue;
        outside[at] = 1;
        continue;
      }
      const src = sz * frameStride + sr * stack.columns + sc;
      out[at] = volume[src];
      if (ovr) ovr[at] = overlayVolume[src];
    }
  }
  return { pixels: out, overlay: ovr, outside };
}
