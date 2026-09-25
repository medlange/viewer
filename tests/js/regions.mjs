// SPDX-License-Identifier: Apache-2.0
//
// A RECTANGULAR ROI IS NOT A ROUNDED ELLIPSE. It measures different pixels.
//
// `regionStatistics(frame, box, shape)` has taken a shape since it was written, its JSDoc
// types the parameter `'ellipse'|'rectangle'`, and the pixel loop reads it -- but the one
// caller passed the string `'ellipse'`, so for its whole life the rectangle branch was
// implemented, documented and unreachable. A static gate can prove a rectangle tool now
// asks for one. It cannot prove the answer DIFFERS, and if it did not, the second tool
// would be a second button onto the same measurement and the reader would be choosing a
// drawing style while believing they were choosing what to measure.
//
// So this runs the function. The frame is built by `buildStack` from a real corpus record,
// because a frame assembled by hand here would be testing this file's idea of a frame.
//
// Run by tests/integration/test_viewer_geometry_executes.py.

import { readFileSync } from 'node:fs';
import { buildStack } from '/src/viewer/src/image/volume.js';
import { polygonStatistics, regionStatistics, remeasure } from '/src/viewer/src/image/measure.js';

const geom = JSON.parse(readFileSync('/src/corpus_geometry.json', 'utf8'));

let fail = 0;
const check = (name, cond, detail = '') => {
  if (!cond) { fail++; console.log(`FAIL ${name}: ${detail}`); }
  else console.log(`ok   ${name}${detail ? ` — ${detail}` : ''}`);
};

// ---------------------------------------------------------------- a frame we control
const BG = 1024;          // -> 0 HU
const HOT = 2024;         // -> 1000 HU, the value of a corner
const rec = geom.source[0];
const rows = rec['00280010'];
const columns = rec['00280011'];

// The box, in pixels. Deliberately square and well inside the frame, so the clamp at the
// edges plays no part in the count.
const half = Math.floor(Math.min(rows, columns) / 4);
const cx = Math.floor(columns / 2);
const cy = Math.floor(rows / 2);
const box = { x0: cx - half, y0: cy - half, x1: cx + half, y1: cy + half };

const stored = new Int16Array(rows * columns).fill(BG);
// THE FOUR CORNERS OF THE BOX, and nothing else. |nx|=|ny|=1 there, so the ellipse test
// `nx*nx + ny*ny <= 1` gives 2 and excludes every one of them.
for (const [x, y] of [[box.x0, box.y0], [box.x1, box.y0], [box.x0, box.y1], [box.x1, box.y1]]) {
  stored[y * columns + x] = HOT;
}

const stack = buildStack([{
  dataset: {
    ...rec,
    '00280100': 16,
    '00280101': 16,
    '00280103': 1,                 // signed, so the Int16 view above is read as written
    '00280030': [0.5, 0.5],
    '00281052': -1024,
    '00281053': 1,
    '7fe00010': new Uint8Array(stored.buffer),
  },
}]);
const frame = stack.frames[0];
check('the frame was built by the viewer, not by this file',
  frame && frame.rows === rows && frame.columns === columns,
  `${frame && frame.rows}x${frame && frame.columns}`);

const rect = regionStatistics(frame, box, 'rectangle');
const ell = regionStatistics(frame, box, 'ellipse');

// ---------------------------------------------------------------- they are not the same
check('a rectangle measures more pixels than an ellipse in the same box',
  rect.count > ell.count, `${rect.count} vs ${ell.count}`);

// THE RATIO IS THE AREA RATIO. pi/4 = 0.7854. Anything else means the ellipse test is not
// an ellipse -- a diamond, a circle on a non-square box, or an off-centre one.
const ratio = ell.count / rect.count;
check('the ellipse encloses pi/4 of the box', Math.abs(ratio - Math.PI / 4) < 0.02,
  `ratio ${ratio.toFixed(4)}, pi/4 = ${(Math.PI / 4).toFixed(4)}`);

// THE CORNERS ARE THE DIFFERENCE, stated as a number a reader would see. This is the whole
// claim: the rectangle samples what the ellipse leaves out.
check('the rectangle sees the corners and the ellipse does not',
  rect.max === 1000 && ell.max === 0, `rect max ${rect.max} HU, ellipse max ${ell.max} HU`);
check('and so the two means differ', rect.mean !== ell.mean,
  `${rect.mean.toFixed(3)} vs ${ell.mean.toFixed(3)} HU`);

// ---------------------------------------------------------------- the area follows suit
check('the area is the pixels counted, not the shape’s formula',
  Math.abs(rect.areaMm2 - rect.count * 0.25) < 1e-9
  && Math.abs(ell.areaMm2 - ell.count * 0.25) < 1e-9,
  `${rect.areaMm2.toFixed(2)} and ${ell.areaMm2.toFixed(2)} mm2`);
check('a rectangle covers more area than the ellipse inside it',
  rect.areaMm2 > ell.areaMm2, `${rect.areaMm2.toFixed(2)} > ${ell.areaMm2.toFixed(2)} mm2`);

// ---------------------------------------------------------------- and it says which it is
check('the result carries the shape that produced it',
  rect.shape === 'rectangle' && ell.shape === 'ellipse',
  `${rect.shape} / ${ell.shape}`);

// THE DEFAULT IS STILL THE ELLIPSE. The rectangle was added by giving an existing parameter
// a second value; a default that had drifted would silently change every ROI ever taken.
const byDefault = regionStatistics(frame, box);
check('omitting the shape still measures an ellipse',
  byDefault.count === ell.count && byDefault.shape === 'ellipse',
  `${byDefault.shape}, ${byDefault.count} px`);

// A DEGENERATE BOX MEASURES NOTHING, both ways. A click without a drag is not an ROI of
// one pixel with a standard deviation of zero.
const flat = { x0: cx, y0: cy, x1: cx, y1: cy };
check('a box with no width encloses nothing under the ellipse test',
  regionStatistics(frame, flat, 'ellipse').count === 0,
  `count ${regionStatistics(frame, flat, 'ellipse').count}`);

// ---------------------------------------------------------------- and it survives an edit
//
// A MEASUREMENT IS RE-COMPUTED WHEN THE READER DRAGS A CORNER. `remeasure` read `m.shape`
// to decide how, and then left it out of the record it returned -- so a rectangle resized
// once measured as a rectangle that one time and came back with no shape at all. It was
// drawn as an ellipse from then on and measured as one on the NEXT drag: a shape the reader
// did not ask for, and numbers to match. Two edits are the test, because one passes.
const held = {
  id: 'm1', kind: 'roi', shape: 'rectangle', box,
  plane: 0, sliceIndex: 0, seriesUID: '1.2.3', label: 'nodule',
};
const once = remeasure(held, frame);
check('a resized rectangle is measured as a rectangle',
  once && once.value.count === rect.count, `count ${once && once.value.count}`);
check('and still SAYS it is one', once && once.shape === 'rectangle',
  `shape ${once && once.shape}`);
const twice = remeasure(once, frame);
check('and is still a rectangle after a second edit',
  twice && twice.shape === 'rectangle' && twice.value.count === rect.count,
  `shape ${twice && twice.shape}, count ${twice && twice.value.count}`);
check('the name the reader gave it survives both edits',
  twice && twice.label === 'nodule', `label ${twice && twice.label}`);

// AND AN ELLIPSE IS NOT TURNED INTO A RECTANGLE by the same path. A record written before
// the shape existed carries none, and the default it falls back to must be the one every
// ROI ever taken was measured with.
const legacy = { id: 'm2', kind: 'roi', box, plane: 0, sliceIndex: 0, seriesUID: '1.2.3' };
const migrated = remeasure(legacy, frame);
check('an ROI recorded before shapes existed is still an ellipse',
  migrated && migrated.shape === 'ellipse' && migrated.value.count === ell.count,
  `shape ${migrated && migrated.shape}, count ${migrated && migrated.value.count}`);

// ---------------------------------------------------------------- the freehand region
//
// A TRACED OUTLINE IS MEASURED BY WHAT IT ENCLOSES, and the only way to know the
// point-in-polygon test is right is to give it shapes whose answer is already known.
// A string gate can prove the function is called. It cannot prove it encloses anything.

// A POLYGON TRACING THE BOX IS THE BOX. Vertices on the pixel centres of the corners, so
// the even-odd test must admit exactly the rectangle's pixels -- no more, and in
// particular not one row or column fewer, which is what an off-by-one in the crossing
// rule produces and what would quietly shrink every freehand area by a few percent.
const asPolygon = [
  { x: box.x0, y: box.y0 }, { x: box.x1, y: box.y0 },
  { x: box.x1, y: box.y1 }, { x: box.x0, y: box.y1 },
];
const traced = polygonStatistics(frame, asPolygon);
const side = Math.abs(box.x1 - box.x0);
// VERTICES EXACTLY ON PIXEL CENTRES ARE THE DEGENERATE CASE, and the crossing rule's
// half-open edges put the far row and column OUT: 160x160, not 161x161. That is correct
// and it is the convention that makes a self-crossing trace stable, but it is only
// visible when an outline lies exactly on centres, which a traced one never does.
// Asserted explicitly so the convention is pinned rather than discovered later as drift.
check('a polygon on the pixel centres encloses the half-open box',
  traced.count === side * side, `${traced.count} against ${side}x${side}`);

// AND HALF A PIXEL OUT, IT LOSES NOTHING. This is the check that matters: it proves the
// half-open boundary is a property of outlines that sit exactly on centres and NOT a
// systematic under-count. A biased rule would still be short here, and on a 20x20 ROI
// that bias would be 9% of the area.
const outset = [
  { x: box.x0 - 0.5, y: box.y0 - 0.5 }, { x: box.x1 + 0.5, y: box.y0 - 0.5 },
  { x: box.x1 + 0.5, y: box.y1 + 0.5 }, { x: box.x0 - 0.5, y: box.y1 + 0.5 },
];
const around = polygonStatistics(frame, outset);
check('a polygon half a pixel outside the box encloses all of it',
  around.count === rect.count, `${around.count} against the rectangle's ${rect.count}`);
check('and reports the rectangle’s own statistics',
  around.mean === rect.mean && around.max === rect.max,
  `mean ${around.mean.toFixed(3)} vs ${rect.mean.toFixed(3)}, max ${around.max} vs ${rect.max}`);
check('and says which shape it is', traced.shape === 'polygon', traced.shape);

// A MANY-SIDED POLYGON ON THE ELLIPSE'S PERIMETER approaches the ellipse. 256 sides is
// well inside a pixel of it, so the counts must agree to a fraction of a percent; a
// crossing rule that dropped or double-counted vertices would not land here.
const pcx = (box.x0 + box.x1) / 2;
const pcy = (box.y0 + box.y1) / 2;
const rx = Math.abs(box.x1 - box.x0) / 2;
const ry = Math.abs(box.y1 - box.y0) / 2;
const circle = [];
for (let k = 0; k < 256; k++) {
  const a = (k / 256) * 2 * Math.PI;
  circle.push({ x: pcx + rx * Math.cos(a), y: pcy + ry * Math.sin(a) });
}
const approx = polygonStatistics(frame, circle);
const drift = Math.abs(approx.count - ell.count) / ell.count;
check('a 256-gon on the ellipse measures the ellipse', drift < 0.01,
  `${approx.count} against ${ell.count}, ${(drift * 100).toFixed(2)}% apart`);

// A CLICK IS NOT A REGION. Fewer than three vertices encloses nothing, and must report
// nothing rather than one pixel with a standard deviation of zero.
for (const degenerate of [[], [{ x: pcx, y: pcy }], [{ x: pcx, y: pcy }, { x: pcx + 9, y: cy }]]) {
  const r = polygonStatistics(frame, degenerate);
  check(`${degenerate.length} vertices enclose nothing`, r.count === 0 && Number.isNaN(r.mean),
    `count ${r.count}`);
}

// A SELF-CROSSING TRACE IS NORMAL, NOT AN ERROR. A reader dragging freehand crosses their
// own line constantly. Under the even-odd rule the doubly-enclosed lobe falls out, which
// is the conventional reading; what must NOT happen is a throw, or a count larger than
// the bounding box, which is what an unclosed or mis-wound test produces.
const bowtie = [
  { x: pcx - rx, y: pcy - ry }, { x: pcx + rx, y: pcy + ry },
  { x: pcx - rx, y: pcy + ry }, { x: pcx + rx, y: pcy - ry },
];
let crossed = null;
try { crossed = polygonStatistics(frame, bowtie); } catch (e) { crossed = null; }
check('a self-crossing trace measures rather than throwing',
  crossed !== null && crossed.count > 0 && crossed.count < rect.count,
  crossed ? `${crossed.count} px, inside the box's ${rect.count}` : 'threw');

// AND IT SURVIVES AN EDIT, from its VERTICES. A polygon has no bounding box to fall back
// on, so a `remeasure` that reached for `m.box` would report the area of a rectangle the
// reader never drew -- which is the defect the rectangle ROI actually had.
const heldPoly = {
  id: 'p1', kind: 'roi', shape: 'polygon', points: asPolygon,
  plane: 0, sliceIndex: 0, seriesUID: '1.2.3', label: 'traced',
};
const re1 = remeasure(heldPoly, frame);
const re2 = remeasure(re1, frame);
check('a resized freehand region is still a polygon',
  re2 && re2.shape === 'polygon' && re2.value.count === traced.count,
  `shape ${re2 && re2.shape}, count ${re2 && re2.value.count} against ${traced.count}`);
check('its vertices survive two edits',
  re2 && Array.isArray(re2.points) && re2.points.length === asPolygon.length,
  `${re2 && re2.points && re2.points.length} vertices`);
check('and the name the reader gave it', re2 && re2.label === 'traced',
  `label ${re2 && re2.label}`);

// IT PRODUCES NO MASK. `MOS-UI-010a` clause 1: the vertices exist so the shape can be
// re-measured, and the module must offer no way to turn them into one. This is the
// clause that keeps a measurement tool from being an annotation authoring tool, so it is
// checked rather than asserted in a comment.
const exported = Object.keys(re2 || {});
check('a freehand record carries no mask, contour or label map',
  !exported.some((k) => /mask|contour|labelmap|segment/i.test(k)),
  exported.join(','));

console.log(fail === 0 ? '\nALL GREEN' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
