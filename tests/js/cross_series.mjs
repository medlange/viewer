// Drives the viewer's OWN sync.js against the geometry of the two seeded studies.
// Nothing here reimplements the arithmetic: buildStack and followIndex are imported from
// the shipped source, and the expectation is computed from the DICOM numbers directly.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildStack } from '/src/viewer/src/image/volume.js';
import { followIndex, LINK, describeLink, linkBadge, positionLinkable, dihedralDegrees } from '/src/viewer/src/image/sync.js';
import { planeNormal } from '/src/viewer/src/image/mpr.js';
import { PLANES, planeDepth } from '/src/viewer/src/image/mpr.js';

// The bytes actually under test, stated rather than assumed -- see run.sh.
for (const m of ['sync.js', 'mpr.js', 'volume.js']) {
  const b = readFileSync(`/src/viewer/src/image/${m}`);
  console.log(`     ${m.padEnd(10)} sha256 ${createHash('sha256').update(b).digest('hex').slice(0, 16)}  ${b.length} bytes`);
}

const geom = JSON.parse(readFileSync('/src/corpus_geometry.json', 'utf8'));

function instances(records) {
  return records.map((rec) => {
    const ds = { ...rec };
    const n = rec['00280010'] * rec['00280011'];
    ds['7fe00010'] = new Uint8Array(n * 2);   // geometry is what is under test, not pixels
    return { dataset: ds };
  });
}

const mkStack = (recs) => buildStack(instances(recs));
const source = mkStack(geom.source);
const target = mkStack(geom.companion);

let fail = 0;
const check = (name, cond, detail) => {
  if (!cond) { fail++; console.log(`FAIL ${name}: ${detail}`); }
  else console.log(`ok   ${name}${detail ? ` — ${detail}` : ''}`);
};

check('two distinct stacks', source !== target, `${source.depth} and ${target.depth} slices`);
check('frame of reference shared',
  source.frameOfReferenceUID === target.frameOfReferenceUID,
  source.frameOfReferenceUID);

const link = positionLinkable(source, target, PLANES.AXIAL);
check('position-linkable', link.ok, `dihedral ${link.dihedral.toFixed(3)}° — ${link.reason || 'no refusal'}`);

// THE CROSS-STACK BRANCH, over every slice of the source.
const OFFSET = 7.0, PITCH = 2.0;
let worst = 0, sampled = [];
for (let i = 0; i < source.depth; i++) {
  const r = followIndex(source, i, PLANES.AXIAL, target, PLANES.AXIAL);
  // Inside the companion's extent it is a correspondence; outside, a clamp. The boundary is
  // NOT a free parameter: 2 mm pitch, so half a cell is 1 mm, and z=0..85 is what it covers.
  const inRange = i * PITCH >= OFFSET - PITCH / 2 && i * PITCH <= OFFSET + (target.depth - 1) * PITCH + PITCH / 2;
  const expectMode = inRange ? LINK.POSITION : LINK.CLAMPED;
  if (r.mode !== expectMode) { fail++; console.log(`FAIL slice ${i} (z=${i*PITCH}): mode ${r.mode}, expected ${expectMode}`); break; }
  if (inRange && r.distanceMm > PITCH / 2 + 1e-9) { fail++; console.log(`FAIL slice ${i}: called it a correspondence at ${r.distanceMm} mm`); break; }
  // Independent expectation from the header numbers: source depth i is at i*PITCH; the
  // companion's slice j is at OFFSET + j*PITCH; nearest j clamped into the companion.
  const want = i * PITCH;
  const exact = (want - OFFSET) / PITCH;
  const expect = Math.max(0, Math.min(target.depth - 1, Math.round(exact)));
  const expectDist = Math.abs(OFFSET + expect * PITCH - want);
  if (r.index !== expect || Math.abs(r.distanceMm - expectDist) > 1e-9) {
    fail++;
    console.log(`FAIL slice ${i}: got index ${r.index} d=${r.distanceMm}; expected ${expect} d=${expectDist}`);
    break;
  }
  worst = Math.max(worst, r.distanceMm);
  if (i === 0 || i === 4 || i === 30 || i === source.depth - 1) sampled.push([i, r]);
}
check('every source slice is classified correctly', fail === 0, `largest residual inside range ${worst.toFixed(2)} mm`);

// THE ROUNDING THE 7 mm OFFSET EXISTS TO EXERCISE. A multiple of the pitch would land
// exactly and pass whether the rounding were right, wrong or absent.
const half = followIndex(source, 5, PLANES.AXIAL, target, PLANES.AXIAL);   // 10 mm -> 1.5
check('a half-slice landing rounds and reports the residual',
  half.distanceMm > 0.9 && half.distanceMm < 1.1,
  `source 10.0 mm -> companion index ${half.index} at ${half.distanceMm.toFixed(2)} mm`);

// NO OVERLAP AT THE HEAD OF THE SOURCE. Slices 0..3 of the source sit BELOW the companion's
// first slice, so the honest answer is the clamped index WITH a distance that says so.
const below = followIndex(source, 0, PLANES.AXIAL, target, PLANES.AXIAL);
check('a slice outside the companion is NOT badged as an exact correspondence',
  below.index === 0 && Math.abs(below.distanceMm - OFFSET) < 1e-9
    && below.mode === LINK.CLAMPED && linkBadge(below.mode).kind !== 'exact',
  `${linkBadge(below.mode).text} / ${linkBadge(below.mode).kind} — ${describeLink(below.mode, below)}`);

// THE MEASURED CASE THIS WHOLE CLASSIFICATION EXISTS FOR: 41 mm past the end.
const past = followIndex(source, 63, PLANES.AXIAL, target, PLANES.AXIAL);
check('41 mm past the end of the companion is not "position-linked / exact"',
  past.mode === LINK.CLAMPED && linkBadge(past.mode).kind === 'weak',
  `index ${past.index}, ${past.distanceMm.toFixed(1)} mm — badge "${linkBadge(past.mode).text}"`);

// ONE SLICE INSIDE THE BOUNDARY MUST STILL BE A CORRESPONDENCE, or the fix has simply
// broken the link rather than qualified it.
const inside = followIndex(source, 4, PLANES.AXIAL, target, PLANES.AXIAL);
check('a slice within half a pitch of a companion slice still links exactly',
  inside.mode === LINK.POSITION && linkBadge(inside.mode).kind === 'exact',
  `index ${inside.index} at ${inside.distanceMm.toFixed(2)} mm`);

// AND THE PAIR THAT MUST NOT LINK.
const cross = followIndex(source, 30, PLANES.AXIAL, target, PLANES.CORONAL);
check('axial against coronal refuses rather than inventing an index',
  cross.index === null && cross.mode === LINK.NONE,
  cross.reason.slice(0, 72) + '…');

// ---- THE RECONSTRUCTED BRANCH, CROSS-STACK. -----------------------------------------
// The companion is shifted 5 mm in plane, which is 7.14 rows at 0.7 mm. Without that shift
// these three checks were vacuous: identical extents made the link the IDENTITY (index 100
// -> index 100, which an implementation that ignored the geometry would also return) and
// put every row of one inside the other, so the out-of-range branch was unreachable.
const ROW = 0.7, SHIFT = 5.0;
const cor = followIndex(source, 100, PLANES.CORONAL, target, PLANES.CORONAL);
const corExpect = Math.round((100 * ROW - SHIFT) / ROW);      // 92.86 -> 93
check('coronal-to-coronal is the geometry, not the identity',
  cor.mode === LINK.POSITION && cor.index === corExpect && cor.index !== 100,
  `index 100 -> ${cor.index} of ${planeDepth(target, PLANES.CORONAL)} (expected ${corExpect}), ${describeLink(cor.mode, cor)}`);

// The rounding: 7.14 rows is not a whole number, so the residual must be non-zero and
// under half a row. Zero here would mean the shift was ignored.
check('the in-plane shift lands between rows and reports the residual',
  cor.distanceMm > 1e-6 && cor.distanceMm < ROW / 2 + 1e-9,
  `${cor.distanceMm.toFixed(4)} mm, half a row is ${(ROW / 2).toFixed(2)} mm`);

// Source coronal rows 0..6 sit 5 mm outside the companion's extent. This is the case
// `break 4` failed to catch: the reconstructed branch clamped with Math.min/Math.max and
// reported LINK.POSITION for it, exactly as the acquired branch did.
const corPast = followIndex(source, 0, PLANES.CORONAL, target, PLANES.CORONAL);
check('a coronal outside the companion is a clamp, not a correspondence',
  corPast.mode === LINK.CLAMPED && corPast.index === 0
    && Math.abs(corPast.distanceMm - SHIFT) < 1e-6
    && linkBadge(corPast.mode).kind === 'weak',
  `index ${corPast.index}, ${corPast.distanceMm.toFixed(2)} mm — ${linkBadge(corPast.mode).text}`);

// And the far end, to prove the check is not simply "index 0 is suspicious".
const last = planeDepth(source, PLANES.CORONAL) - 1;
const corEnd = followIndex(source, last, PLANES.CORONAL, target, PLANES.CORONAL);
check('the far coronal end is an ordinary correspondence',
  corEnd.mode === LINK.POSITION,
  `index ${last} -> ${corEnd.index}, ${corEnd.distanceMm.toFixed(3)} mm`);

// =====================================================================================
// THE SAME VOLUME, DESCRIBED DIFFERENTLY. None of this needs a second acquisition: it is
// one series' geometry restated with different in-plane cosines, which is what a
// feet-first patient, a rotated MR FOV or a reformatted secondary capture produces. The
// acquired slice normal is [0,0,1] in every one of them, so the gate that ran on the
// acquired normal passed all of them at 0.000 degrees.
// =====================================================================================
const restate = (recs, iop, flipX, flipY) => mkStack(recs.map((rec) => ({
  ...rec,
  '00200037': iop,
  '00200032': [
    (flipX ? -1 : 1) * rec['00200032'][0],
    (flipY ? -1 : 1) * rec['00200032'][1],
    rec['00200032'][2],
  ],
})));

// FEET-FIRST SUPINE against head-first: both in-plane axes negated. Same physical volume.
const FF = restate(geom.source, [-1, 0, 0, 0, -1, 0], true, true);
check('a feet-first series has the SAME acquired normal, so the old gate saw 0°',
  dihedralDegrees(source.frames[0].normal, FF.frames[0].normal) === 0,
  `acquired ${JSON.stringify(source.frames[0].normal)} vs ${JSON.stringify(FF.frames[0].normal)}`);
check('but its CORONAL normal is antiparallel, which is what is compared',
  Math.abs(planeNormal(source, PLANES.CORONAL)[1] + planeNormal(FF, PLANES.CORONAL)[1]) < 1e-9,
  `${JSON.stringify(planeNormal(source, PLANES.CORONAL))} vs ${JSON.stringify(planeNormal(FF, PLANES.CORONAL))}`);

// 319 - 100: the mirror index. Anything else puts the two panels on opposite sides of the
// midline while the badge reads "exact".
for (const [plane, i, extent] of [[PLANES.CORONAL, 100, 320], [PLANES.SAGITTAL, 100, 448]]) {
  const r = followIndex(source, i, plane, FF, plane);
  check(`a feet-first ${plane} links to the MIRRORED index, not the same one`,
    r.mode === LINK.POSITION && r.index === extent - 1 - i,
    `index ${i} -> ${r.index} (mirror is ${extent - 1 - i}), ${r.distanceMm.toFixed(3)} mm`);
}
// The axial of the same pair was always right, which is what made this hard to see.
const ffAx = followIndex(source, 30, PLANES.AXIAL, FF, PLANES.AXIAL);
check('the axial of that same pair is unchanged and still correct',
  ffAx.mode === LINK.POSITION && ffAx.index === 30 && ffAx.distanceMm === 0,
  `index 30 -> ${ffAx.index} at ${ffAx.distanceMm} mm`);

// A 90 DEGREE IN-PLANE ROTATION has no slice correspondence on the reconstructions at all:
// the source's coronal is the target's sagittal. It must REFUSE, not link at 0.000 mm.
const ROT = restate(geom.source, [0, 1, 0, -1, 0, 0], false, false);
check('a 90° in-plane rotation still reads 0° on the ACQUIRED normal',
  dihedralDegrees(source.frames[0].normal, ROT.frames[0].normal) === 0,
  'which is exactly why the gate had to move to the plane normal');
const rot = followIndex(source, 100, PLANES.CORONAL, ROT, PLANES.CORONAL);
check('a 90° in-plane rotation is REFUSED on the coronal, not linked at 0.000 mm',
  rot.index === null && rot.mode === LINK.NONE && /90\.0°/.test(rot.reason),
  rot.reason);
check('and its axial still links, because the slice axis really is shared',
  followIndex(source, 30, PLANES.AXIAL, ROT, PLANES.AXIAL).mode === LINK.POSITION);

// AN ANTIPARALLEL ACQUIRED NORMAL. IOP [1,0,0,0,-1,0] gives cross() = [0,0,-1], so this
// series measures the SLICE axis in the opposite direction and every `frame.depth` is
// negated. The reconstructions above never reached this: all of them keep [0,0,1].
const AA = restate(geom.source, [1, 0, 0, 0, -1, 0], false, true);
check('the anti-axial series really does have the opposite slice normal',
  AA.frames[0].normal[2] === -1, JSON.stringify(AA.frames[0].normal));
const aa = followIndex(source, 30, PLANES.AXIAL, AA, PLANES.AXIAL);
// source 30 is z = 60. AA's frames sort by depth = -z, so z = 60 sits at index (126-60)/2.
check('an antiparallel acquired normal is corrected, not compared as-is',
  aa.mode === LINK.POSITION && aa.index === 33 && aa.distanceMm === 0,
  `index 30 (z=60) -> ${aa.index} at ${aa.distanceMm} mm (expected 33)`);

// UNEVEN SLICE SPACING, which is the only thing that can tell `Math.max` from `Math.min`
// in the cell width. Every series above is uniform, so both spellings agreed.
const uneven = geom.companion.slice(0, 20).map((rec, k) => ({
  ...rec,
  '00200032': [rec['00200032'][0], rec['00200032'][1], rec['00200032'][2] + (k >= 10 ? 10 : 0)],
}));
const UN = mkStack(uneven);
// z runs 7,9,...,25 then jumps to 37,39,...,55: one 12 mm gap among 2 mm pitches.
check('the uneven target really is uneven', UN.uniformSpacing === false,
  `spacingRange ${JSON.stringify(UN.spacingRange)}`);
// Source index 15 is z = 30, which sits INSIDE the sampled extent, in that 12 mm gap: 5 mm
// from the slice at 25 and 7 mm from the one at 37. It is a real correspondence -- the
// series covers z = 30 -- and only the wider neighbouring gap says so.
const un = followIndex(source, 15, PLANES.AXIAL, UN, PLANES.AXIAL);
check('a depth inside a wide gap is a correspondence, not a clamp',
  un.mode === LINK.POSITION && un.index === 9 && Math.abs(un.distanceMm - 5) < 1e-9,
  `z=30 -> index ${un.index} at ${un.distanceMm} mm; half the wide gap is 6 mm`);
// And past the far end it must still clamp, so the wider cell has not simply disabled it.
const unPast = followIndex(source, 63, PLANES.AXIAL, UN, PLANES.AXIAL);
check('past the end of the uneven series it still clamps',
  unPast.mode === LINK.CLAMPED,
  `z=126 -> index ${unPast.index} at ${unPast.distanceMm.toFixed(1)} mm`);

for (const [i, r] of sampled) {
  console.log(`     source ${String(i).padStart(2)} (z=${(i * PITCH).toFixed(1)}) -> companion ${String(r.index).padStart(2)}  ${describeLink(r.mode, r)}`);
}
console.log(fail === 0 ? '\nALL GREEN' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
