/* =====================================================================================
 * Multiplanar reconstruction: axial, coronal, sagittal from one acquired stack.
 *
 * WHY IT IS HERE -- AND THE AUTHORITY IT DOES *NOT* HAVE
 * -------------------------------------------------------
 * An earlier version of this header said "`MOS-UI-211` requires it". That overreached, and
 * the correction matters more than the feature does.
 *
 * `MOS-UI-211` sits in chapter 19 §19.4.4, whose subject is "every annotation viewport" of
 * the ANNOTATION surface, and `MOS-UI-213` binds that whole subsection to OHIF
 * configuration or an extension-package module. This viewer declares itself
 * `clinical_viewer` (`dicomweb.js`, `SURFACE_HEADER`), so `MOS-UI-211` does not reach it.
 * Meanwhile `MOS-UI-009` affirmatively forbids the clinician surface to "implement image
 * decoding, windowing, stack scrolling, MPR, or any viewport rendering of pixel data" --
 * naming MPR explicitly -- and the counter-argument section of the Viewer row in
 * `docs/adr/BUILD_VS_ADOPT.md` names MPR as the tripwire: "If it grows codecs, MPR, 4D or
 * any editing primitive, it becomes a worse SOUP item than the one it replaced."
 *
 * THAT WAS TRUE WHEN IT WAS WRITTEN AND IS NOT TRUE NOW, AND BOTH HALVES ARE KEPT.
 * The paragraph above described this module as non-compliant against a requirement nobody
 * had withdrawn, and asked for "the same explicit reversal `MOS-CORE-038` got, recorded
 * under `MOS-CORE-036`". It got exactly that. `MOS-UI-009` is WITHDRAWN at specification
 * 0.3.0 and replaced by `MOS-UI-009a`, which permits a first-party viewer and states the
 * four guarantees it is held to instead -- one route to the pixels through the Gateway, no
 * pixel created or edited, every value carrying its unit or marked as not recorded, and
 * refusal rather than approximation where the geometry does not support a reconstruction.
 * The four refusals this file raises are that last clause. Register entry 103 records the
 * gap and its closure; entry 106 records the three further requirements that survived it
 * and were withdrawn at 0.4.0.
 *
 * The earlier text is left above rather than deleted for the reason the specification
 * gives for striking requirements instead of removing them: a reader holding a review
 * written while this module was non-compliant has to be able to find what it said then.
 *
 * WHY IT IS WORTH ARGUING FOR ANYWAY
 * -----------------------------------
 * `MOS-UI-211` states the engineering reason better than a comment could: "A segmentation
 * authored on axial slices alone with no cross-plane check produces a mask that is correct
 * slice by slice and wrong in the craniocaudal direction, and the reader cannot see it."
 * The same is true of a mask this platform GENERATED and a reader is being asked to accept
 * under `MOS-SAFE-069`. Without a coronal view, a lung segmentation that stops four slices
 * early looks perfect on every axial slice anybody scrolls through.
 *
 * WHY CPU RESLICE AND NOT A 3D TEXTURE
 * -------------------------------------
 * The tempting implementation is a WebGL2 `TEXTURE_3D` of the whole volume, sampled by the
 * shader at an arbitrary plane. For a 512x512x148 int16 volume that is 77 MB of VRAM in one
 * allocation, and `MAX_3D_TEXTURE_SIZE` is only guaranteed to be 256 by the ES 3.0 spec --
 * so a 512-deep series is not portably allocatable at all, and the failure is a black
 * viewport on someone else's laptop rather than an error here.
 *
 * A reslice is a strided copy. Coronal on that volume is 512x148 = 75 776 samples, which is
 * well under a millisecond, and it produces exactly the 2-D integer texture
 * `viewport.setFrame` already takes. No new GPU path, no new failure mode, and the same
 * `R16I` + shader-side windowing that keeps the HU readout honest.
 *
 * ANISOTROPY IS CARRIED, NOT CORRECTED AWAY
 * ------------------------------------------
 * A thoracic CT is typically 0.7 mm in plane and 2-3 mm between slices. The coronal and
 * sagittal planes are therefore strongly anisotropic, and each resliced plane reports its
 * own `pixelSpacing` so the viewport's physical-aspect fit stretches it correctly. What is
 * NOT done is interpolation between slices: the reslice takes the nearest acquired slice,
 * so a coronal view of a 3 mm study looks blocky. That is honest. Smoothing it would draw
 * tissue boundaries at positions no slice measured, which is the same objection that makes
 * `viewport.js` sample with NEAREST rather than LINEAR.
 *
* Spec: MOS-UI-009a (MOS-UI-009 withdrawn at specification 0.3.0; see above),
* MOS-UI-211 (annotation surface, does not
 * bind here), MOS-IMG-039, MOS-IMG-041, MOS-UI-204 (nothing here edits anything).
 * ===================================================================================== */

import { paddingTest } from './units.js';
import {
  isOblique, obliqueGrid, obliqueSample,
} from './oblique.js';

export const PLANES = Object.freeze({ AXIAL: 'axial', CORONAL: 'coronal', SAGITTAL: 'sagittal' });

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/**
 * Patient-space geometry for a RECONSTRUCTED plane.
 *
 * A resliced plane is a real plane in the patient and it has to be able to say so, or
 * nothing downstream can relate it to anything: `reference.js` draws where one plane cuts
 * another, and a plane with no position, orientation or normal is a picture with no place.
 *
 * THE DERIVATION. Take the coronal. Its output row 0 is slice `depth-1` (rows are written
 * bottom-up so the head is at the top), its output column 0 is source column 0, and it
 * holds volume row `index` throughout. So its origin is that slice's own origin stepped
 * along the source's column direction to the volume row in question -- allowing for the
 * shear correction, which is why `rowStart` appears rather than `index` alone:
 *
 *     origin = frames[depth-1].position + (index - rowStart[depth-1]) · rowMm · ey
 *
 * Its own axes follow from what varies: output columns run along the source's `ex`, and
 * output rows run along the NEGATED slice normal, because increasing output row means
 * decreasing z. The sagittal is the same construction with `ey` in place of `ex`.
 */
function reconstructedGeometry(stack, plane, index) {
  const first = stack.frames[0];
  if (first.orientation.length !== 6 || first.position.length !== 3) return {};

  const last = stack.frames[stack.depth - 1];
  if (last.position.length !== 3) return {};

  const ex = first.orientation.slice(0, 3);
  const ey = first.orientation.slice(3, 6);
  const [rowMm, colMm] = first.pixelSpacing;
  const n = first.normal;
  const down = [-n[0], -n[1], -n[2]];
  const start = geometryOf(stack).rowStart[stack.depth - 1];

  if (plane === PLANES.CORONAL) {
    const offset = (index - start) * rowMm;
    return {
      position: [
        last.position[0] + offset * ey[0],
        last.position[1] + offset * ey[1],
        last.position[2] + offset * ey[2],
      ],
      orientation: [...ex, ...down],
      normal: cross(ex, down),
    };
  }

  const alongX = index * colMm;
  const alongY = -start * rowMm;
  return {
    position: [
      last.position[0] + alongX * ex[0] + alongY * ey[0],
      last.position[1] + alongX * ex[1] + alongY * ey[1],
      last.position[2] + alongX * ex[2] + alongY * ey[2],
    ],
    orientation: [...ey, ...down],
    normal: cross(ey, down),
  };
}

/**
 * How far each slice is displaced IN ITS OWN PLANE from the first, in pixels.
 *
 * WHY THIS IS NOT ZERO ON A TILTED GANTRY
 * ----------------------------------------
 * With the gantry tilted, the table steps along the patient's z axis while the imaging
 * plane's normal leans away from it. Consecutive slices are therefore offset from each
 * other WITHIN the plane as well as along the normal, and stacking them at a common origin
 * -- which is what a contiguous copy does -- packs a sheared volume. The axial plane is
 * unaffected, because it IS the acquired plane; the coronal and sagittal lean, and a
 * caliper across the lean measures a distance no anatomy has.
 *
 * MEASURED FROM THE POSITIONS, NOT READ FROM (0018,1120) GantryDetectorTilt. The header
 * field states an angle; the positions state what the scanner actually did. They agree on
 * conformant data and the positions are what the reconstruction has to match, which is the
 * same argument that makes `sliceSpacing` a measurement rather than a reading of
 * (0018,0088).
 *
 * @returns {{rowOffsets:number[], columnShear:number, sheared:boolean}}
 */
function shearOf(stack) {
  const first = stack.frames[0];
  const flat = {
    rowOffsets: stack.frames.map(() => 0), rounded: stack.frames.map(() => 0),
    columnShear: 0, sheared: false,
  };
  if (first.orientation.length !== 6 || first.position.length !== 3) return flat;

  const ex = first.orientation.slice(0, 3);   // direction of increasing COLUMN index
  const ey = first.orientation.slice(3, 6);   // direction of increasing ROW index
  const [rowMm, colMm] = first.pixelSpacing;
  const p0 = first.position;

  const rowOffsets = [];
  let columnShear = 0;
  for (const f of stack.frames) {
    if (f.position.length !== 3) { rowOffsets.push(0); continue; }
    const d = [f.position[0] - p0[0], f.position[1] - p0[1], f.position[2] - p0[2]];
    const alongColumns = d[0] * ex[0] + d[1] * ex[1] + d[2] * ex[2];
    const alongRows = d[0] * ey[0] + d[1] * ey[1] + d[2] * ey[2];
    rowOffsets.push(alongRows / rowMm);
    columnShear = Math.max(columnShear, Math.abs(alongColumns / colMm));
  }

  const span = Math.max(...rowOffsets) - Math.min(...rowOffsets);
  // Half a pixel of drift is float noise in patient coordinates, not a tilt.
  // SHEARED MEANS "THE VOLUME LAYOUT MOVES A SLICE", and the layout moves it by the
  // ROUNDED offset. `span > 0.5` was a different question: at a span of exactly 0.5,
  // `Math.round` still sends slice 1 to volume row 1 -- so the volume grew a row, every
  // slice was written one row down, and `sheared` said false, which is what `volumeOf`
  // consults before filling the vacated rows. They stayed zero-initialised and undeclared:
  // not padding, so an ROI over them averaged in a value no scanner produced.
  //
  // Asking the rounded offsets directly is the same question the layout asks.
  const rounded = rowOffsets.map((o) => Math.round(o));
  return {
    rowOffsets,
    /** The whole-pixel displacement the volume layout actually applies. */
    rounded,
    columnShear,
    sheared: Math.max(...rounded) !== Math.min(...rounded),
  };
}

/**
 * The shear resolved to whole pixels, and the volume height that fits it.
 *
 * Rounded rather than interpolated. This module already samples with NEAREST between
 * slices, for the reason its header gives: interpolation draws tissue boundaries at
 * positions no slice measured. Sub-pixel shear correction would be the same invention in
 * a different axis, and half a pixel of lean is not what makes a tilted reconstruction
 * unreadable -- fifty pixels is.
 */
function geometryOf(stack) {
  if (stack._geometry) return stack._geometry;
  const shear = shearOf(stack);
  // ROUNDED ONCE, in `shearOf`, because rounding here as well is two answers to "how far
  // does this slice move" -- and it was two answers, which is how a volume grew a row that
  // `sheared` said it had not.
  const { rounded } = shear;
  const lo = Math.min(...rounded);
  const hi = Math.max(...rounded);
  stack._geometry = {
    ...shear,
    /** Volume row each slice's first row lands on, so the stack is upright again. */
    rowStart: rounded.map((o) => o - lo),
    /** Tall enough that the shear displaces nothing off the end. */
    volumeRows: stack.rows + (hi - lo),
  };
  return stack._geometry;
}

/**
 * What to put where a sheared slice does not reach.
 *
 * The vacated corners are outside the acquired field for that slice, which is exactly what
 * (0028,0120) describes -- so the declared padding value is the right fill when there is
 * one. When there is not, the stack minimum is used AND the reconstructed frame declares it
 * as padding, so `measure.js` excludes it from an ROI either way. That over-excludes
 * genuine minimum-valued pixels, which are air outside the body; erring toward leaving real
 * air out of a mean is the safe direction, and the excluded count says it happened.
 *
 * The scan runs once per stack and only when a shear correction is actually needed.
 */
function fillValueOf(stack) {
  const declared = stack.frames[0].paddingValue;
  if (declared !== null && declared !== undefined) return declared;
  let min = Infinity;
  for (const f of stack.frames) {
    for (let i = 0; i < f.pixels.length; i++) if (f.pixels[i] < min) min = f.pixels[i];
  }
  return Number.isFinite(min) ? min : 0;
}

/**
 * Pack a sorted stack into one contiguous volume, once, upright.
 *
 * Built lazily by `reslice` and cached on the stack, because a reader who never leaves the
 * axial plane should not pay 77 MB and a copy for a feature they did not use.
 */
function volumeOf(stack) {
  if (stack._volume) return stack._volume;
  const { rows, columns, depth } = stack;
  const g = geometryOf(stack);
  const frame = g.volumeRows * columns;
  // THE VOLUME TAKES THE SOURCE ARRAY'S TYPE, not a hardcoded Int16Array. (0028,0103)
  // PixelRepresentation = 0 means the stored values run to 65535, and set() into an
  // Int16Array wraps everything above 32767 into a large negative that measure.js then
  // reports as the reader's HU.
  const Storage = stack.frames[0].pixels.constructor;
  const volume = new Storage(frame * depth);
  if (g.sheared) {
    stack._fill = fillValueOf(stack);
    volume.fill(stack._fill);
  }
  for (let z = 0; z < depth; z++) {
    volume.set(stack.frames[z].pixels, z * frame + g.rowStart[z] * columns);
  }
  stack._volume = volume;
  return volume;
}

/** Same, for the per-slice segment index planes, so the overlay reslices with the image. */
function overlayVolumeOf(stack, seg) {
  if (!seg) return null;
  if (seg._volume && seg._volumeFor === stack) return seg._volume;
  const { columns, depth } = stack;
  // THE SAME SHEAR, or the overlay slides off the anatomy it was computed on -- which is
  // the one failure a segmentation viewer must never produce, because a mask displaced by
  // a few millimetres still looks like a mask.
  const g = geometryOf(stack);
  const frame = g.volumeRows * columns;
  const volume = new Uint8Array(frame * depth);
  for (const [z, plane] of seg.planes) {
    if (z >= 0 && z < depth) volume.set(plane, z * frame + g.rowStart[z] * columns);
  }
  seg._volume = volume;
  seg._volumeFor = stack;
  return volume;
}

/** How many slices the given plane has. */
export function planeDepth(stack, plane) {
  // An oblique's depth is its own bounding extent along its own normal, computed once in
  // `obliqueGrid`. It is unsigned and zero-based like every other plane, so app.js's
  // mid-slice default, its cine wrap and slabPlan's edge clipping all mean what they meant.
  if (isOblique(plane)) {
    const grid = obliqueGrid(stack, plane);
    return grid ? grid.depth : 1;
  }
  // The VOLUME's height, not a slice's. A sheared stack is packed into a taller volume so
  // the correction displaces nothing off the end, and a coronal indexes that height.
  if (plane === PLANES.CORONAL) return geometryOf(stack).volumeRows;
  if (plane === PLANES.SAGITTAL) return stack.columns;
  return stack.depth;
}

/**
 * Where a plane sits along its OWN normal, in millimetres from the patient origin.
 *
 * A scalar, because that is all a slice position is once the direction is fixed: two panels
 * showing the same plane of the same anatomy agree exactly when this number agrees.
 *
 * NO PIXELS ARE TOUCHED. `reconstructedGeometry` and `obliqueGrid` both compute a plane's
 * origin from the stack's geometry alone, so this costs the trigonometry and nothing else --
 * which is what makes it usable on every scroll event.
 *
 * `sync.js` said for a long time that "a panel showing a RECONSTRUCTED plane never
 * position-links: its index is a row or a column of the resliced volume, not a slice, so
 * there is no patient-space depth to match". That was true when a reconstruction was a bare
 * index. It stopped being true when `reconstructedGeometry` began supplying a position and
 * a normal per index, and the oblique branch does the same -- measured, a coronal at index
 * 100 reports position [-156.45, -41.65, 126.00] and an oblique reports
 * [-156.45, -105.65, 134.00]. The sentence outlived its reason.
 *
 * @returns {number|null} null when the stack states no orientation to measure against.
 */
/**
 * The unit normal of the plane a panel is SHOWING, in patient coordinates.
 *
 * NOT the acquisition's slice normal. `stack.frames[0].normal` comes from (0020,0037) and
 * is the axis the SLICES advance along; this is the axis the DISPLAYED plane advances
 * along, and the two are equal only for `PLANES.AXIAL`. A coronal's normal is built from
 * the in-plane cosines -- `cross(ex, down)` in `reconstructedGeometry` -- so it rotates
 * with the in-plane orientation while the slice normal does not move at all.
 *
 * WHY IT IS EXPORTED. `planeOrdinate` already projects on this normal, correctly. What did
 * not use it was `sync.js`'s gate: `positionLinkable` compared the two stacks' ACQUIRED
 * normals and then let `followIndex` compare ordinates measured along the PLANE normals.
 * Measured, against the demo corpus's source series and the same volume described
 * feet-first (IOP [-1,0,0,0,-1,0], origin at the opposite corner, one frame of reference):
 * both acquired normals are [0,0,1] so the dihedral read 0.000 degrees and the link was
 * allowed, while the coronal normals are [0,1,0] and [0,-1,0]. The two coronals then linked
 * index 100 to index 100 at a reported 0.000 mm, badged `position-linked` kind `exact`,
 * with the panels 83.30 mm apart on opposite sides of the midline -- and `describeLink`
 * printed no distance clause at all, because 0.000 is below its 0.01 mm threshold. The
 * axial link between the very same pair is correct, which is what makes it hard to see.
 *
 * @returns {number[]|null} a unit vector, or null when the plane has no geometry.
 */
export function planeNormal(stack, plane) {
  if (isOblique(plane)) {
    const grid = obliqueGrid(stack, plane);
    return grid ? grid.normal : null;
  }
  const first = stack.frames[0];
  if (plane === PLANES.AXIAL) return first.normal ?? null;
  if (first.orientation.length !== 6 || first.position.length !== 3) return null;
  const g = reconstructedGeometry(stack, plane, 0);
  return g.normal ?? null;
}

/**
 * What a reader will SEE on this plane, named in the patient's anatomy.
 *
 * THE PLANE NAMES IN THIS MODULE ARE ADDRESSES, NOT ANATOMY. `PLANES.AXIAL` means "the
 * acquired plane as stored" and `PLANES.CORONAL` means "the first reconstruction of it" --
 * `sync.js` says so in its own header. On a CT that distinction is invisible, because CT
 * is acquired axially and the address happens to name the anatomy.
 *
 * ON MR IT IS NOT INVISIBLE. Measured against a clinic MR corpus: of the acquisitions
 * sampled, 89 were sagittal and 26 coronal against 15 axial -- and on a sagittal
 * acquisition the button labelled "Axial" showed sagittal anatomy, "Coronal" showed axial
 * and "Sagittal" showed coronal. Nineteen of twenty-nine offered buttons showed anatomy
 * other than their label. The orientation letters on the image were right the whole time,
 * so a reader had one true statement and one false one about the same picture.
 *
 * The anatomy is read off the plane's own normal, which `planeNormal` already computes,
 * so this cannot drift from what is actually drawn.
 *
 * @returns {{name:string, oblique:boolean}|null}
 */
export function planeAnatomy(stack, plane) {
  // A SERIES THAT IS NOT COPLANAR HAS NO PLANE TO NAME. Its frames face three different
  // ways, so any single name is right for some of them and wrong for the rest -- which is
  // the defect this function exists to fix, one level up.
  if (stack && stack.coplanar === false) return null;
  const n = planeNormal(stack, plane);
  if (!n) return null;
  // PS3.3 C.7.6.2.1.1: +x is LEFT, +y is POSTERIOR, +z is HEAD. A plane's normal along x
  // is therefore a sagittal plane, along y a coronal one, along z an axial one.
  const axis = [0, 1, 2].reduce((best, i) => (Math.abs(n[i]) > Math.abs(n[best]) ? i : best), 0);
  const name = ['sagittal', 'coronal', 'axial'][axis];
  // A NORMAL THAT IS NOT ON AN AXIS IS NOT THAT PLANE. The 0.99 is about 8 degrees, which
  // is the point past which a radiologist reading a spine would not call it axial.
  return { name, oblique: Math.abs(n[axis]) <= 0.99 };
}

export function planeOrdinate(stack, plane, index) {
  if (isOblique(plane)) {
    const grid = obliqueGrid(stack, plane);
    if (!grid) return null;
    const at = Math.max(0, Math.min(grid.depth - 1, index));
    const o = grid.originAt(at);
    return o[0] * grid.normal[0] + o[1] * grid.normal[1] + o[2] * grid.normal[2];
  }

  const first = stack.frames[0];
  if (plane === PLANES.AXIAL) {
    const f = stack.frames[Math.max(0, Math.min(stack.depth - 1, index))];
    // `depth` is exactly this projection, computed once by the loader.
    return f.depth;
  }
  if (first.orientation.length !== 6 || first.position.length !== 3) return null;

  const at = Math.max(0, Math.min(planeDepth(stack, plane) - 1, index));
  const g = reconstructedGeometry(stack, plane, at);
  if (!g.position || !g.normal) return null;
  return g.position[0] * g.normal[0] + g.position[1] * g.normal[1] + g.position[2] * g.normal[2];
}

/**
 * How far one step along a plane's own normal is, in millimetres.
 *
 * The HUD prints this beside the slice counter and `slabPlan` measures slab thickness with
 * it, and the two were computed separately -- the same three-way choice written twice, one
 * function apart. That is how a slab comes to be quoted in another plane's spacing while
 * the millimetre figure beside it reads correctly, which is a disagreement no picture can
 * show. One function, asked by both.
 */
export function planeStepMm(stack, plane) {
  // AN OBLIQUE STEPS BY ITS OWN PITCH, which is neither the slice spacing nor the in-plane
  // one. Falling through to `stack.sliceSpacing` here is what makes a 10 mm slab on the
  // phantom's 45 degree plane report "over 10.0 mm" -- the suspiciously round answer --
  // where the truth is 9 samples of 0.99 mm, 8.9 mm.
  if (isOblique(plane)) {
    const grid = obliqueGrid(stack, plane);
    if (grid) return grid.stepMm;
  }
  if (plane === PLANES.CORONAL) return stack.frames[0].pixelSpacing[0];
  if (plane === PLANES.SAGITTAL) return stack.frames[0].pixelSpacing[1];
  return stack.sliceSpacing;
}

/**
 * One plane of the volume, shaped exactly like a frame so `viewport.setFrame` takes it
 * unchanged.
 *
 * @returns {{pixels:Int16Array, rows:number, columns:number, pixelSpacing:[number,number],
 *            slope:number, intercept:number, overlay:(Uint8Array|null)}}
 */
/**
 * Collapse a slab of axial slices into one frame by taking an extreme along each ray.
 *
 * WHAT A MIP IS FOR, AND WHAT IT COSTS
 * --------------------------------------
 * A pulmonary nodule a few millimetres across appears on two or three slices out of
 * hundreds, and a reader scrolling at speed can pass it without registering it. A maximum
 * intensity projection over a slab puts the brightest thing along each ray onto every
 * output, so the nodule persists while the reader scrolls the slab instead of appearing
 * and vanishing. That is the entire clinical argument, and it is a good one.
 *
 * The cost is that the output is NOT A SLICE. Each pixel is an extreme over a column of
 * tissue, so the value at a point is not the density at a place; it is the densest thing
 * somewhere along a ray, and nothing on the image says where. A reader who measures an ROI
 * on a MIP gets a mean of maxima -- a real number describing no tissue. The frame therefore
 * declares itself a projection, and everything downstream that reports a value has to say
 * so rather than presenting it as an HU reading.
 *
 * THE EXTREME IS TAKEN IN HU, NOT IN STORED VALUES. They order the same way only while
 * `slope` is positive. It almost always is, and "almost always" is how a viewer ends up
 * showing the DARKEST tissue on a study whose slope happens to be negative, with the word
 * MAXIMUM on screen.
 */
/**
 * The projection modes, as a closed table rather than a pair of string literals.
 *
 * Every vocabulary this platform renders is closed and declared in one place -- the
 * rejection reasons of `MOS-SVC-095`, the `burned_in_state` enum of `MOS-DATA-042`. A mode
 * this function does not know is a caller bug, and a caller bug that silently falls through
 * to "maximum" would hand back a MIP labelled as whatever was asked for.
 */
export const PROJECTION_MODES = { min: 'minimum', max: 'maximum' };

/**
 * What a slab request means at a particular position, or null when it means nothing.
 *
 * WHY THE THICKNESS IS NOT `slices * sliceSpacing`
 * -------------------------------------------------
 * A slab runs along the normal of the plane being drawn. For an axial that is the slice
 * axis and the step is `sliceSpacing`; for a coronal it is the ROW axis, whose step is
 * (0028,0030)[0]; for a sagittal it is the COLUMN axis, whose step is (0028,0030)[1]. On
 * this project's own phantom those are 3.0 mm and 0.7 mm, so quoting slice spacing on a
 * coronal would report a 10-slice slab as 30 mm when it is 7 -- a number that is wrong by
 * four times, printed beside a picture that cannot contradict it.
 *
 * WHY THE REQUEST IS IN MILLIMETRES AND NOT IN SLICES
 * ----------------------------------------------------
 * A slab is a physical thickness -- it is what a reader means by "10 mm MIP", and it is the
 * same 10 mm whichever plane it is drawn on. A count is not: 12 slices is 24 mm of this
 * phantom's axial and 8.4 mm of its coronal, so a count control would silently mean three
 * different things across the three panels.
 *
 * A count also cannot be honoured. The projection is centred on the displayed plane, so it
 * spans `2 * half + 1` positions and is always odd -- a request for 12 returns 13, which
 * was measured on this phantom before this parameter was changed. Asking in millimetres
 * makes that rounding visible in the one place it belongs: the achieved thickness below.
 *
 * `mm` in the note reports what was PROJECTED, not what was requested -- rounded to whole
 * positions, and clipped where the slab runs past the end of the volume. The honest thing
 * for a label to say is how thick the result actually is.
 *
 * @param {{mm:number, mode:string}} slab
 * @param {number} centre   index of the displayed plane along the projection axis
 * @param {number} count    how many positions that axis has
 * @param {number} stepMm   distance between adjacent positions on that axis
 * @param {number} slope    (0028,1053) RescaleSlope, whose SIGN orders stored against output
 */
/**
 * How far either side of the centre a slab of `mm` reaches, or 0 when it reaches nowhere.
 *
 * EXPORTED BECAUSE THE TOOLBAR HAS TO ASK THE SAME QUESTION. The strip greys a thickness it
 * believes cannot be built, and it computed that belief with its own copy of the arithmetic
 * below. The two then disagreed in both directions: a MIP/MinIP button that stayed lit over
 * a slice no projection had touched, and a thickness offered on one plane and silently
 * ignored on another. `MOS-UI-029`'s rule is the one that applies -- one decision point,
 * and every consumer asks it.
 */
export function slabHalf(mm, stepMm) {
  if (!(mm > 0) || !(stepMm > 0)) return 0;
  // See the note on the caller: solving `(2 * half + 1) * step <= mm` for an integer half,
  // so the result is never thicker than what was asked for.
  const half = Math.floor((mm / stepMm - 1) / 2);
  return half >= 1 ? half : 0;
}

function slabPlan(slab, centre, count, stepMm, slope) {
  if (!slab || !(slab.mm > 0) || !(stepMm > 0) || count < 2) return null;

  const mode = PROJECTION_MODES[slab.mode];
  if (!mode) {
    throw new Error(
      `projection_mode_unknown: ${JSON.stringify(slab.mode)} is not one of `
      + `${Object.keys(PROJECTION_MODES).join(', ')}.`,
    );
  }

  // NEVER MORE THAN WAS ASKED FOR. A projection spans `2 * half + 1` positions, so the
  // centre contributes a full step and `floor(mm / 2 / step)` OVERSHOOTS: on this phantom's
  // 2 mm axial a 20 mm request returned 22 mm, measured. The extra sits at the far end of
  // every ray, which is exactly where a structure the reader excluded on purpose becomes
  // the maximum and is read as being inside the slab.
  //
  // A request too thin to fit three positions is not a slab and returns null rather than
  // rounding itself up into one.
  const half = slabHalf(slab.mm, stepMm);
  if (!half) return null;

  const from = Math.max(0, centre - half);
  const to = Math.min(count - 1, centre + half);
  if (to <= from) return null;

  return {
    from,
    to,
    // A MAXIMUM-intensity projection wants the densest tissue, which is the LARGEST stored
    // value only while the rescale slope is positive. A negative slope reverses the order,
    // and a MIP taken on raw stored values would then return the least dense voxel along
    // every ray -- an image that is the exact opposite of what it says it is, at full
    // plausibility. The comparison is decided once, here, from the sign.
    wantHigher: (mode === PROJECTION_MODES.max) === ((slope ?? 1) >= 0),
    note: { mode, slices: to - from + 1, mm: (to - from + 1) * stepMm },
  };
}

/**
 * The extreme along each ray of an axial slab, skipping padding.
 *
 * A ray that is padding all the way through keeps the padding value, so it stays declared
 * padding and an ROI over it still excludes it rather than averaging in a corner.
 */
/**
 * The first frame in a range whose Modality LUT differs from the reference, or null.
 *
 * A projection compares stored values against each other and keeps one. That comparison is
 * only about density while every frame in the slab maps stored to output the same way: mix
 * a slope of 1 with a slope of 2 and the extreme along each ray is decided by which frame
 * had the coarser scale, not by which voxel was denser. The result is a picture of the
 * acquisition's bookkeeping.
 *
 * `reslice` already refuses a RECONSTRUCTION across a varying Modality LUT for the same
 * reason. A slab crosses frames exactly as a reconstruction does, so it inherits the check
 * rather than a comment claiming the case cannot arise.
 */
export function rescaleVariesOver(frames, from, to) {
  const ref = frames[from];
  for (let z = from + 1; z <= to; z++) {
    if (frames[z].slope !== ref.slope || frames[z].intercept !== ref.intercept) {
      return frames[z];
    }
  }
  return null;
}

function projectAxial(stack, plan, declaring) {
  const base = stack.frames[plan.from];
  const out = new base.pixels.constructor(base.pixels.length);
  out.set(base.pixels);

  const isPad = paddingTest(declaring);
  const seeded = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) seeded[i] = isPad(out[i]) ? 0 : 1;

  for (let z = plan.from + 1; z <= plan.to; z++) {
    const px = stack.frames[z].pixels;
    for (let i = 0; i < out.length; i++) {
      const v = px[i];
      if (isPad(v)) continue;
      if (!seeded[i]) { out[i] = v; seeded[i] = 1; continue; }
      if (plan.wantHigher ? v > out[i] : v < out[i]) out[i] = v;
    }
  }
  return out;
}

/**
 * Why this plane cannot be built from this stack, or null when it can.
 *
 * ONE ENUMERATION, because the toolbar and the module were each keeping their own. The
 * plane buttons guarded two of these four and `reslice` threw all four, so a series with a
 * per-frame Modality LUT or an uncorrectable gantry tilt offered a Coronal button that
 * threw out of `draw` when pressed. `draw` has no try, so the canvas kept the PREVIOUS
 * plane's pixels, letters and scale bar while the toolbar showed the new plane selected --
 * a picture of one plane labelled as another, which is the worst shape a refusal can fail
 * in. A refusal that only some callers know about is a refusal that some callers ignore.
 *
 * @returns {{code:string, message:string}|null}
 */
export function reconstructionRefusal(stack, plane) {
  if (plane === PLANES.AXIAL) return null;

  if (stack.spatial === false) {
    return {
      code: 'reconstruction_needs_spatial_frames',
      message: 'these frames carry no distinct positions, so they are separated by time '
        + 'rather than by distance. Reslicing them would treat seconds as millimetres.',
    };
  }
  if (stack.uniformSpacing === false) {
    const { min, max } = stack.spacingRange;
    return {
      code: 'spacing_non_uniform',
      message: `the gaps between these slices run from ${min.toFixed(2)} mm to `
        + `${max.toFixed(2)} mm. A reconstruction places every slice the same distance from `
        + 'the last, so the wider gaps would be drawn at the narrower spacing and the '
        + 'anatomy inside them would appear at positions nothing was acquired at.',
    };
  }
  const tilt = geometryOf(stack).columnShear;
  if (tilt > 1) {
    return {
      code: 'gantry_tilt_uncorrectable',
      message: `the slices are displaced by ${tilt.toFixed(1)} pixels along the column axis `
        + 'as well as the row axis. This module corrects a row shear, which is a gantry tilt '
        + 'about the left-right axis; a column displacement is a different geometry and '
        + 'translating rows would leave it uncorrected while looking corrected.',
    };
  }
  const first = stack.frames[0];

  // THE OBLIQUE REFUSALS COME AFTER THE FOUR ABOVE, so a cine loop is told the more
  // fundamental thing first: that its frames are separated by time. All four inherit
  // automatically, because this function returns null only for the axial plane.
  //
  // Every one of the seven is ANGLE-INDEPENDENT -- four are about the series, these three
  // about its orientation, spacing and shear -- which is what lets the toolbar probe the
  // whole family with a single angle and be honest about it.
  if (isOblique(plane)) {
    if (first.orientation.length !== 6) {
      return {
        code: 'oblique_needs_a_stated_orientation',
        message: 'this series does not state (0020,0037), so its slices have no stated '
          + 'direction in the patient. A coronal is still the volume’s own row axis and '
          + 'can be built without one -- it selects the right voxels and merely cannot say '
          + 'which edge is the patient’s left. An oblique is an angle, and an angle needs '
          + 'an axis to be an angle from; there is nothing here to measure it against.',
      };
    }
    if (first.hasPixelSpacing === false) {
      return {
        code: 'oblique_needs_stated_pixel_spacing',
        message: 'this series does not state (0028,0030), so the distance from one pixel to '
          + 'the next is unknown and a spacing has been substituted. An oblique is cut at an '
          + 'angle to those pixels, and the angle only means something once the distances do: '
          + 'a 45 degree plane through pixels that might be 0.5 mm or 2.0 mm apart is not 45 '
          + 'degrees to the patient, and the voxels it selects are not the ones it crosses. '
          + 'The three named planes stay available, because they select along the lattice '
          + 'rather than across it.',
      };
    }
    if (stack.hasSliceSpacing === false) {
      return {
        code: 'oblique_needs_a_measured_slice_pitch',
        message: 'this series carries one instance, so there is no gap between slices to '
          + 'measure and a 1 mm pitch has been stood in to keep the arithmetic finite. An '
          + 'oblique is cut at an angle THROUGH that pitch: every millimetre it reports -- '
          + 'the spacing it is drawn at, what it resolves, the thickness of a slab through '
          + 'it -- is derived from a number nothing measured. The plane the instance was '
          + 'acquired on is still available, because it selects that instance rather than '
          + 'cutting across it.',
      };
    }

    const shear = geometryOf(stack);
    if (shear.sheared) {
      const worst = Math.max(...shear.rounded) - Math.min(...shear.rounded);
      return {
        code: 'oblique_needs_an_unsheared_stack',
        message: `these slices are displaced within their own plane by up to ${worst} `
          + 'pixels, and this module rectifies that by translating each slice a whole number '
          + 'of rows. The named planes index the rectified volume directly, so the rounding '
          + 'is a relabelling they can carry. An oblique is a direction in the patient that '
          + 'has to be converted into volume indices, and after a rounded rectification the '
          + 'volume’s third axis is the table’s direction rather than the slice normal '
          + '-- so the conversion would be wrong by up to half a row per slice, and every '
          + 'sample would be taken from a voxel beside the one the plane crosses.',
      };
    }
  }

  const varying = stack.frames.find(
    (f) => f.slope !== first.slope || f.intercept !== first.intercept,
  );
  if (varying) {
    return {
      code: 'reconstruction_needs_uniform_rescale',
      message: 'this series maps stored values to output units differently across frames '
        + `(${first.slope}/${first.intercept} versus ${varying.slope}/${varying.intercept}). `
        + 'A plane cut through them would be in two scales at once, and one readout over it '
        + 'would describe neither.',
    };
  }
  return null;
}

export function reslice(stack, plane, index, seg = null, slab = null) {
  const { rows, columns, depth } = stack;
  const first = stack.frames[0];

  // EVERY REFUSAL, from the one place that enumerates them. These were four separate
  // checks here and two of them were mirrored in the toolbar, so the other two were
  // reachable from a button. See `reconstructionRefusal`.
  const refusal = reconstructionRefusal(stack, plane);
  if (refusal) throw new Error(`${refusal.code}: ${refusal.message}`);

  // THE AXIAL PLANE IS THE FRAME ITSELF, so it is SPREAD rather than rebuilt.
  //
  // This function used to hand-pick the fields it copied -- pixels, rows, columns,
  // pixelSpacing, overlay, slope, intercept -- which made every field added to a frame in
  // `volume.js` a field that had to be remembered here too. Three defects came out of that
  // one habit, and all three were silent:
  //
  //   photometric      dropped, so `viewport` read undefined and rendered every
  //                    MONOCHROME1 study as MONOCHROME2. The polarity fix in 1e061bf was
  //                    dead on the real draw path from the moment it was committed; it was
  //                    verified against `stack.frames[0]`, which is not what app.js draws.
  //   slope/intercept  taken from slice 0 even on the axial plane, where the frame's own
  //                    values were right there. Wrong for anything whose Modality LUT
  //                    varies per frame.
  //   sopInstanceUID   dropped, so every measurement recorded its provenance as null even
  //                    on the axial plane, where the instance is known exactly.
  //
  // A spread cannot forget a field that does not exist yet. That is the entire argument.
  if (plane === PLANES.AXIAL) {
    const f = stack.frames[Math.max(0, Math.min(depth - 1, index))];
    // `valueUnit` is derived on the STACK, not the frame, so the spread cannot carry it
    // and it has to be named in both branches. That is the one field this design makes
    // easy to forget, which is why a gate below asserts every frame consumer's reads.
    // A SLAB REPLACES THE PIXELS AND NOTHING ELSE. The geometry, spacing, rescale and unit
    // all still describe this slice -- the projection changes what the VALUES mean, not
    // where the frame is. `projection` is what lets that be said downstream.
    //
    // THAT DOES NOT MAKE A CALIPER ON IT SAFE, which an earlier version of this comment
    // claimed. The in-plane geometry is unchanged, so the millimetres are computed
    // correctly; but a projection composites structures that lie on different slices, so
    // the two points the reader clicked may be 12 mm apart in z and the caliper reports
    // only their separation IN the plane. The number is a projected distance and it reads
    // as a distance between two structures, so it is marked like the ROI mean is.
    const overlay = seg ? (seg.planes.get(index) || null) : null;
    const plan = slabPlan(slab, index, depth, planeStepMm(stack, PLANES.AXIAL), f.slope);
    // AND THE SPACING HAS TO BE EVEN, for the reason the reconstruction gives above. The
    // AXIAL PLANE is exempt from that refusal because it SELECTS a frame; a slab does not
    // -- it crosses them, and quotes its thickness as `positions * sliceSpacing`, where
    // `sliceSpacing` is the MEDIAN gap. On a series assembled from two blocks, a slab
    // straddling the join reports the median thickness for rays that traversed the real
    // one, and the number is wrong by the whole of the gap with nothing on screen showing
    // it. The plane stays available; only the projection through it is refused.
    if (plan && stack.uniformSpacing === false) {
      const { min, max } = stack.spacingRange;
      throw new Error(
        'projection_needs_uniform_spacing: the gaps between these slices run from '
        + `${min.toFixed(2)} mm to ${max.toFixed(2)} mm, so a slab quoted at the median `
        + 'spacing would state a thickness the rays did not travel.',
      );
    }

    // THE SAME GUARD THE RECONSTRUCTION MAKES, because a slab crosses frames too.
    const mixed = plan ? rescaleVariesOver(stack.frames, plan.from, plan.to) : null;
    if (mixed) {
      const ref = stack.frames[plan.from];
      throw new Error(
        'projection_needs_uniform_rescale: the frames in this slab map stored values to '
        + `output units differently (${ref.slope}/${ref.intercept} versus `
        + `${mixed.slope}/${mixed.intercept}). The extreme along each ray would be decided `
        + 'by which frame had the coarser scale rather than by which voxel was denser.',
      );
    }
    return {
      ...f,
      rows,
      columns,
      valueUnit: stack.valueUnit,
      overlay,
      // EQUAL TO THE PITCH ON EVERY NAMED PLANE, and named anyway. One step across this
      // picture is one voxel, so what the samples resolve is what they are spaced at -- the
      // two only come apart on an oblique. Setting it on every plane means a consumer reads
      // one field instead of testing which kind of plane it is holding.
      resolutionMm: [...f.pixelSpacing],
      // A SELECTED FRAME HAS NO OVERHANG. Stated rather than left undefined, because
      // `notMeasuredAt` reads it and a field a consumer reads is a field both branches
      // name -- the rule `valueUnit` is here for.
      outside: null,
      ...(plan ? {
        pixels: projectAxial(stack, plan, f),
        projection: { ...plan.note, overlayIsCentrePlane: overlay !== null },
        // A PROJECTION BELONGS TO NO ONE INSTANCE. The spread above carries the centre
        // frame's identity, and a slab crosses eleven of them -- so a measurement taken on
        // it recorded the provenance of whichever slice happened to be in the middle. The
        // reconstruction branch already says null here for exactly this reason; an axial
        // slab is no more a single instance than a coronal is.
        sopInstanceUID: null,
        frameNumber: null,
      } : { projection: null }),
    };
  }

  // A RECONSTRUCTED PLANE IS NOT A FRAME, and the difference has to be stated rather than
  // inherited. It crosses every slice, so it belongs to no instance and has no position of
  // its own -- spreading `first` here would attach slice 0's identity to a plane cut
  // through all of them, which is a provenance claim that is simply false.
  //
  // Rescale must be UNIFORM for a reconstruction to mean anything: resampling across
  // frames that map stored values differently produces a plane whose voxels are in two
  // scales at once, and a single readout over it is a number about nothing. The old
  // code asserted uniformity in a comment ("every frame in a series shares it") and used
  // slice 0's values without checking. It is checked now.
  const common = {
    // A reconstruction's in-plane axis comes straight from (0028,0030); if the series never
    // stated it, the reconstructed plane has not measured it either.
    hasPixelSpacing: first.hasPixelSpacing,
    // The reconstructions index the volume directly, so nothing falls outside it.
    outside: null,
    slope: first.slope,
    intercept: first.intercept,
    valueUnit: stack.valueUnit,
    // The transfer function the window was authored for. Without this a coronal of a
    // SIGMOID study renders LINEAR while its own axial renders SIGMOID -- two planes of one
    // acquisition disagreeing about contrast, which a reader reads as a windowing change
    // they did not make.
    voiFunction: first.voiFunction,
    // Uniform across the stack: `buildStack` refuses a series that mixes them.
    photometric: stack.photometric,
    signed: first.signed,
    // Padding is a property of the acquisition, so a reconstructed plane inherits it: an
    // ROI drawn on a coronal view crosses the same out-of-field pixels an axial one does.
    paddingValue: first.paddingValue,
    paddingRangeLimit: first.paddingRangeLimit,
    // EXPLICITLY NULL, not absent and not inherited. `measure.js` records this as the
    // source of a measurement, and a reconstructed plane genuinely has no single source
    // instance. Null says that; slice 0's UID would say something untrue.
    sopInstanceUID: null,
    frameNumber: null,
    frameOfReferenceUID: stack.frameOfReferenceUID,
  };

  const volume = volumeOf(stack);
  const overlayVolume = overlayVolumeOf(stack, seg);

  // AN OBLIQUE IS CUT FROM THE SAME VOLUME, at an angle to it. It spreads `common` above
  // for the same reason the coronal and sagittal do -- it belongs to no instance, and its
  // rescale, unit, photometric and transfer function are the acquisition's.
  //
  // What it adds is `resolutionMm`. On every other plane one step across the picture is one
  // voxel, so the sample pitch and the resolvable detail are the same number and no frame
  // has ever had to distinguish them. Here they differ, and nothing in the picture can show
  // it: see the header of oblique.js.
  if (isOblique(plane)) {
    const grid = obliqueGrid(stack, plane);
    if (!grid) {
      throw new Error(
        `oblique_plane_unknown: ${JSON.stringify(plane)} is not a plane this module can `
        + 'build. Canonical names are minted by `obliqueName` and look like "oblique x+45.0'
        + '°"; a value outside that grammar names nothing.',
      );
    }
    const at = Math.max(0, Math.min(grid.depth - 1, index));
    // A SLAB THROUGH AN OBLIQUE steps along the OBLIQUE's own normal, at the pitch
    // `planeStepMm` reports for it. Falling through to the slice spacing would make a 10 mm
    // request on the phantom's 45 degree plane report "over 10.0 mm" -- the suspiciously
    // round answer -- where the truth is 9 samples of 0.99 mm, 8.9 mm.
    const plan = slabPlan(slab, at, grid.depth, grid.stepMm, first.slope);
    // The fill is unconditional here, unlike the shear fill below: a rectangle around a
    // rotated volume has corners outside the acquired box at EVERY index, not only where a
    // correction moved a slice.
    const fillValue = fillValueOf(stack);
    const cut = obliqueSample(stack, grid, at, volume, overlayVolume, fillValue);

    // The projection is taken over whole resampled planes rather than over the source
    // voxels, because the ray is the oblique's normal and the source lattice has no axis
    // along it. Padding is skipped for the reason `projectAxial` skips it: the fill is the
    // volume's minimum, so a min-IP that kept it would draw the box corners over the
    // anatomy at full contrast.
    if (plan) {
      const isPad = paddingTest({
        paddingValue: fillValue,
        paddingRangeLimit: fillValue === first.paddingValue ? first.paddingRangeLimit : null,
      });
      const seeded = new Uint8Array(cut.pixels.length);
      for (let i = 0; i < cut.pixels.length; i++) {
        seeded[i] = (cut.outside[i] || isPad(cut.pixels[i])) ? 0 : 1;
      }
      for (let z = plan.from; z <= plan.to; z++) {
        if (z === at) continue;
        const other = obliqueSample(stack, grid, z, volume, null, fillValue);
        for (let i = 0; i < cut.pixels.length; i++) {
          if (other.outside[i]) continue;
          const v = other.pixels[i];
          if (isPad(v)) continue;
          if (!seeded[i]) { cut.pixels[i] = v; seeded[i] = 1; continue; }
          if (plan.wantHigher ? v > cut.pixels[i] : v < cut.pixels[i]) cut.pixels[i] = v;
        }
      }
      // A PROJECTED PIXEL IS OUTSIDE ONLY WHERE EVERY RAY WAS. `seeded` already tracks
      // exactly that: it is set the first time any contributing plane supplied a real
      // sample, so its complement is the overhang of the whole slab rather than of the
      // centre plane alone.
      for (let i = 0; i < cut.outside.length; i++) cut.outside[i] = seeded[i] ? 0 : 1;
    }
    const origin = grid.originAt(at);
    return {
      ...common,
      pixels: cut.pixels,
      overlay: cut.overlay,
      rows: grid.rows,
      columns: grid.columns,
      pixelSpacing: [...grid.pixelSpacing],
      /** What the samples RESOLVE, which is coarser than what they are spaced at. */
      resolutionMm: [...grid.resolutionMm],
      position: origin,
      orientation: [...grid.e1, ...grid.e2],
      normal: grid.normal,
      /** Samples the acquisition never reached, per pixel. See `notMeasuredAt`. */
      outside: cut.outside,
      // A DECLARED PADDING VALUE IS PASSED ON; AN INVENTED ONE IS NOT. `fillValueOf` falls
      // back to the volume's MINIMUM when the series declares nothing, and that minimum is
      // real acquired air -- declaring it here excluded genuine air from every ROI on this
      // plane and counted it as padding. The overhang is carried by the mask above, which
      // is exact, so the value is only repeated when the header stated one.
      paddingValue: first.paddingValue ?? null,
      // AND THE RANGE IT CAME WITH. `fillValueOf` returns the DECLARED (0028,0120) verbatim
      // when the series states one, so the (0028,0121) limit stated beside it still applies.
      // Dropping it narrows a declared RANGE to a single value: on a series stating
      // -2000..-1200, every pixel from -1999 to -1200 is padding on the axial and the
      // coronal and tissue on the oblique, so an ROI at the field edge reads hundreds of HU
      // low and `excluded` under-reports. The reconstruction branch solves this six lines
      // below and says why; the oblique was written without looking.
      paddingRangeLimit: first.paddingRangeLimit ?? null,
      projection: plan
        ? { ...plan.note, overlayIsCentrePlane: cut.overlay !== null }
        : null,
      // A PROJECTION BELONGS TO NO ONE PLANE, and an oblique already belongs to no one
      // instance -- `common` says so. Stated again here only because the slab makes the
      // position above describe the centre of a slab rather than the plane drawn.
      ...(plan ? { sopInstanceUID: null, frameNumber: null } : {}),
    };
  }

  const g = geometryOf(stack);
  const volumeRows = g.volumeRows;
  const frame = volumeRows * columns;
  // The fill only exists where a shear correction moved a slice, and it declares itself as
  // padding so an ROI over a corner cannot average it in.
  // When the study declares padding, `fillValueOf` reuses that declared value -- so the
  // range limit that came with it still applies and dropping it here would narrow a
  // declared RANGE to a single value, letting the rest of the range read as tissue.
  const fill = g.sheared
    ? {
      paddingValue: stack._fill,
      paddingRangeLimit: stack._fill === first.paddingValue ? first.paddingRangeLimit : null,
    }
    : {};

  if (plane === PLANES.CORONAL) {
    // Fix the row (anterior-posterior position); vary column and slice.
    const y = Math.max(0, Math.min(volumeRows - 1, index));
    const out = new volume.constructor(columns * depth);
    const ovr = overlayVolume ? new Uint8Array(columns * depth) : null;
    // The slab runs along the ROW axis here, one (0028,0030)[0] per step.
    const plan = slabPlan(slab, y, volumeRows, planeStepMm(stack, PLANES.CORONAL), first.slope);
    const isPad = paddingTest({ ...common, ...fill });
    const seeded = plan ? new Uint8Array(columns) : null;
    for (let z = 0; z < depth; z++) {
      // Rows run superior->inferior as z increases, so write bottom-up to put the head at
      // the top of the image, which is how a coronal is read.
      const dst = (depth - 1 - z) * columns;
      const src = z * frame + y * columns;
      out.set(volume.subarray(src, src + columns), dst);
      if (ovr) ovr.set(overlayVolume.subarray(src, src + columns), dst);
      if (!plan) continue;
      for (let i = 0; i < columns; i++) seeded[i] = isPad(out[dst + i]) ? 0 : 1;
      for (let yy = plan.from; yy <= plan.to; yy++) {
        if (yy === y) continue;
        const s2 = z * frame + yy * columns;
        for (let i = 0; i < columns; i++) {
          const v = volume[s2 + i];
          if (isPad(v)) continue;
          const d = dst + i;
          if (!seeded[i]) { out[d] = v; seeded[i] = 1; continue; }
          if (plan.wantHigher ? v > out[d] : v < out[d]) out[d] = v;
        }
      }
    }
    return {
      pixels: out, rows: depth, columns,
      pixelSpacing: [stack.sliceSpacing, first.pixelSpacing[1]],
      resolutionMm: [stack.sliceSpacing, first.pixelSpacing[1]],
      overlay: ovr, ...common, ...fill,
      ...reconstructedGeometry(stack, PLANES.CORONAL, y),
      projection: plan ? { ...plan.note, overlayIsCentrePlane: ovr !== null } : null,
    };
  }

  // Sagittal: fix the column (left-right position); vary row and slice.
  const x = Math.max(0, Math.min(columns - 1, index));
  const out = new volume.constructor(volumeRows * depth);
  const ovr = overlayVolume ? new Uint8Array(volumeRows * depth) : null;
  // The slab runs along the COLUMN axis here, one (0028,0030)[1] per step.
  const plan = slabPlan(slab, x, columns, planeStepMm(stack, PLANES.SAGITTAL), first.slope);
  const isPad = paddingTest({ ...common, ...fill });
  const seeded = plan ? new Uint8Array(volumeRows) : null;
  for (let z = 0; z < depth; z++) {
    const dst = (depth - 1 - z) * volumeRows;
    const base = z * frame + x;
    for (let y = 0; y < volumeRows; y++) {
      out[dst + y] = volume[base + y * columns];
      if (ovr) ovr[dst + y] = overlayVolume[base + y * columns];
    }
    if (!plan) continue;
    for (let y = 0; y < volumeRows; y++) seeded[y] = isPad(out[dst + y]) ? 0 : 1;
    for (let xx = plan.from; xx <= plan.to; xx++) {
      if (xx === x) continue;
      const b2 = z * frame + xx;
      for (let y = 0; y < volumeRows; y++) {
        const v = volume[b2 + y * columns];
        if (isPad(v)) continue;
        const d = dst + y;
        if (!seeded[y]) { out[d] = v; seeded[y] = 1; continue; }
        if (plan.wantHigher ? v > out[d] : v < out[d]) out[d] = v;
      }
    }
  }
  return {
    pixels: out, rows: depth, columns: volumeRows,
    pixelSpacing: [stack.sliceSpacing, first.pixelSpacing[0]],
    resolutionMm: [stack.sliceSpacing, first.pixelSpacing[0]],
    overlay: ovr, ...common, ...fill,
    ...reconstructedGeometry(stack, PLANES.SAGITTAL, x),
    projection: plan ? { ...plan.note, overlayIsCentrePlane: ovr !== null } : null,
  };
}
