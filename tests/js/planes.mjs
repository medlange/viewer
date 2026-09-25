// SPDX-License-Identifier: Apache-2.0
//
// What the plane buttons SAY against what the planes ARE.
//
// WHY THIS IS SYNTHETIC WHEN THE DEFECT WAS FOUND ON REAL DATA. The defect was measured
// against a clinic MR corpus -- 89 sagittal and 26 coronal acquisitions against 15 axial,
// and 19 of 29 offered plane buttons showing anatomy other than their label. That corpus
// is not in this repository and will not be. It does not need to be: the defect is a
// property of the ORIENTATION, and restating the demo phantom's (0020,0037) reproduces a
// sagittal or coronal acquisition exactly. The same trick the cross-series harness uses to
// make a feet-first series.
//
// Run by tests/integration/test_viewer_geometry_executes.py.

import { readFileSync } from 'node:fs';
import { buildStack } from '/src/viewer/src/image/volume.js';
import {
  PLANES, planeAnatomy, planeNormal, reconstructionRefusal,
} from '/src/viewer/src/image/mpr.js';

const geom = JSON.parse(readFileSync('/src/corpus_geometry.json', 'utf8'));

let fail = 0;
const check = (name, cond, detail = '') => {
  if (!cond) { fail++; console.log(`FAIL ${name}: ${detail}`); }
  else console.log(`ok   ${name}${detail ? ` — ${detail}` : ''}`);
};

/** The phantom, restated as if it had been acquired on another plane. */
function acquiredAs(iop, axis) {
  const recs = geom.source.map((rec, k) => {
    const out = { ...rec, '00200037': iop };
    // The slice axis moves with the acquisition, so the positions have to move with it or
    // the stack is a pile of coplanar frames rather than a volume.
    const p = [...rec['00200032']];
    const z = k * 2.0;
    out['00200032'] = axis === 'x' ? [z - 156.45, p[1], p[2]]
      : axis === 'y' ? [p[0], z - 111.65, p[2]]
        : [p[0], p[1], z];
    return out;
  });
  return buildStack(recs.map((rec) => {
    const ds = { ...rec };
    ds['7fe00010'] = new Uint8Array(rec['00280010'] * rec['00280011'] * 2);
    return { dataset: ds };
  }));
}

/** What the plane's own normal says it is. Independent of `planeAnatomy`. */
function fromNormal(n) {
  const k = [0, 1, 2].reduce((b, i) => (Math.abs(n[i]) > Math.abs(n[b]) ? i : b), 0);
  return ['sagittal', 'coronal', 'axial'][k];
}

const CASES = [
  ['an axial acquisition', [1, 0, 0, 0, 1, 0], 'z', 'axial'],
  ['a sagittal acquisition', [0, 1, 0, 0, 0, -1], 'x', 'sagittal'],
  ['a coronal acquisition', [1, 0, 0, 0, 0, -1], 'y', 'coronal'],
];

for (const [name, iop, axis, expect] of CASES) {
  const stack = acquiredAs(iop, axis);

  // THE ACQUIRED PLANE IS NAMED FOR WHAT IT IS, not for the address `PLANES.AXIAL`.
  const acquired = planeAnatomy(stack, PLANES.AXIAL);
  check(`${name}: the acquired plane is named ${expect}`,
    acquired && acquired.name === expect && !acquired.oblique,
    `planeAnatomy said ${acquired && acquired.name}`);

  // AND EVERY OFFERED BUTTON AGREES WITH ITS OWN NORMAL. This is the check that was 19/29
  // against the real corpus.
  let disagree = 0;
  const labels = [];
  for (const plane of [PLANES.AXIAL, PLANES.CORONAL, PLANES.SAGITTAL]) {
    if (reconstructionRefusal(stack, plane)) { labels.push('refused'); continue; }
    const a = planeAnatomy(stack, plane);
    const truth = fromNormal(planeNormal(stack, plane));
    if (!a || a.name !== truth) disagree += 1;
    labels.push(a ? a.name : 'null');
  }
  check(`${name}: no button names anatomy it does not show`, disagree === 0,
    `buttons read ${labels.join(', ')}`);
}

// THE THREE NAMES ARE DISTINCT on any one acquisition. A mapping that collapsed two planes
// onto one name would pass the agreement check above and still be useless.
const sag = acquiredAs([0, 1, 0, 0, 0, -1], 'x');
const names = [PLANES.AXIAL, PLANES.CORONAL, PLANES.SAGITTAL]
  .map((p) => (reconstructionRefusal(sag, p) ? null : planeAnatomy(sag, p).name))
  .filter(Boolean);
check('the three planes are three different names', new Set(names).size === names.length,
  names.join(', '));

// AN OBLIQUE ACQUISITION SAYS SO. 8 degrees is where a reader stops calling it axial.
const oblique = acquiredAs([1, 0, 0, 0, 0.9063, -0.4226], 'y');   // 25 degrees off coronal
const ob = planeAnatomy(oblique, PLANES.AXIAL);
check('an angled acquisition is marked oblique rather than named a cardinal plane',
  ob && ob.oblique === true, `name ${ob && ob.name}, oblique ${ob && ob.oblique}`);

console.log(fail === 0 ? '\nALL GREEN' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
