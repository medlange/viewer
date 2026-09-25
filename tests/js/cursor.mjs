// SPDX-License-Identifier: Apache-2.0
//
// The patient-space cursor, executed against the geometry the seeder actually wrote.
//
// WHAT THIS PROVES THAT A STATIC GATE CANNOT. The static gates read that the functions
// exist and that their refusals are present. Whether a point round-trips through two
// conversions, whether scrolling one plane leaves the other two axes untouched, and
// whether the coronal beside an axial stays put while its crosshair moves are claims
// about ARITHMETIC, and the only way to check arithmetic is to run it.
//
// Run by tests/integration/test_viewer_geometry_executes.py, with the sources streamed in
// over stdin rather than bind-mounted -- see that module for why.

import { readFileSync } from 'node:fs';
import { buildStack } from '/src/viewer/src/image/volume.js';
import { PLANES, reslice, planeOrdinate } from '/src/viewer/src/image/mpr.js';
import { pixelToPatient, patientToPixel } from '/src/viewer/src/image/reference.js';
import { cursorAt, slideCursor, indexForCursor, crosshairOn, indexAtOrdinate, LINK }
  from '/src/viewer/src/image/sync.js';

const geom = JSON.parse(readFileSync('/src/corpus_geometry.json', 'utf8'));
const A = buildStack(geom.source.map((rec) => {
  const ds = { ...rec }; ds['7fe00010'] = new Uint8Array(rec['00280010'] * rec['00280011'] * 2);
  return { dataset: ds };
}));

let fail = 0;
const check = (name, cond, detail = '') => {
  if (!cond) { fail++; console.log(`FAIL ${name}: ${detail}`); }
  else console.log(`ok   ${name}${detail ? ` — ${detail}` : ''}`);
};

const ax = reslice(A, PLANES.AXIAL, 30);

// ---- the two conversions are exact inverses --------------------------------------
const probe = [[0, 0], [100.5, 240.25], [447, 319]];
let worst = 0;
for (const [c, r] of probe) {
  const mm = pixelToPatient(ax, c, r);
  const back = patientToPixel(ax, mm);
  worst = Math.max(worst, Math.abs(back.col - c), Math.abs(back.row - r));
}
check('pixelToPatient and patientToPixel are inverses', worst < 1e-9,
  `worst round-trip error ${worst.toExponential(1)} px`);

// ---- a point on this slice is ON the plane; one a slice away is not ---------------
const centre = cursorAt(A, ax, 223.5, 159.5);
const here = crosshairOn(A, ax, PLANES.AXIAL, centre);
check('the cursor set on this slice reads as on-plane', here.onPlane && Math.abs(here.offMm) < 1e-9,
  `offMm ${here.offMm}`);

const ax32 = reslice(A, PLANES.AXIAL, 32);
const there = crosshairOn(A, ax32, PLANES.AXIAL, centre);
check('two slices away it is off-plane, by the true distance',
  !there.onPlane && Math.abs(Math.abs(there.offMm) - 4) < 1e-6,
  `offMm ${there.offMm.toFixed(2)} (2 slices x 2.00 mm)`);

// ---- the cursor drives every plane ------------------------------------------------
for (const [plane, expect] of [[PLANES.AXIAL, 30], [PLANES.CORONAL, null], [PLANES.SAGITTAL, null]]) {
  const r = indexForCursor(A, plane, centre);
  const ord = r.index === null ? null : planeOrdinate(A, plane, r.index);
  check(`the cursor gives the ${plane} an index`, r.index !== null && r.mode === LINK.POSITION,
    `index ${r.index}, ${r.distanceMm.toFixed(3)} mm off${expect !== null ? ` (expected ${expect})` : ''}`);
  if (plane === PLANES.AXIAL) {
    check('and on the acquired plane it is the slice it came from', r.index === 30, `got ${r.index}`);
  }
}

// ---- scrolling slides ONE axis --------------------------------------------------
const moved = slideCursor(centre, A, PLANES.AXIAL, 40, ax);
check('scrolling the axial moves only z',
  Math.abs(moved.mm[0] - centre.mm[0]) < 1e-9
  && Math.abs(moved.mm[1] - centre.mm[1]) < 1e-9
  && Math.abs(moved.mm[2] - centre.mm[2] - 20) < 1e-6,
  `x,y unchanged; z ${centre.mm[2]} -> ${moved.mm[2]} (10 slices x 2.00 mm)`);

// and the coronal's ROW follows while its INDEX does not move
const cor = reslice(A, PLANES.CORONAL, indexForCursor(A, PLANES.CORONAL, centre).index);
const before = crosshairOn(A, cor, PLANES.CORONAL, centre);
const after = crosshairOn(A, cor, PLANES.CORONAL, moved);
check('the coronal stays put and its crosshair moves',
  indexForCursor(A, PLANES.CORONAL, moved).index === indexForCursor(A, PLANES.CORONAL, centre).index
  && Math.abs(after.y - before.y) > 1,
  `coronal index unchanged; crosshair row ${before.y.toFixed(1)} -> ${after.y.toFixed(1)}`);

// ---- the refusals ----------------------------------------------------------------
const alien = { forUID: 'not.the.same.uid', mm: centre.mm };
const r1 = indexForCursor(A, PLANES.AXIAL, alien);
check('a cursor from another frame of reference is refused',
  r1.index === null && /different frame of reference/.test(r1.reason), r1.reason.slice(0, 54));
const c1 = crosshairOn(A, ax, PLANES.AXIAL, alien);
check('and the crosshair says why it is absent rather than vanishing',
  Boolean(c1.absent), c1.absent);

const noSpacing = { ...ax, hasPixelSpacing: false };
check('a frame that never stated its spacing gives no patient point',
  pixelToPatient(noSpacing, 10, 10) === null && patientToPixel(noSpacing, centre.mm) === null);

console.log(fail === 0 ? '\nALL GREEN' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
