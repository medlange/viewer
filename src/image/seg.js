/* =====================================================================================
 * DICOM SEG -> a per-slice segment index plane.
 *
 * THIS IS THE FILE THAT CAN BE WRONG WITHOUT LOOKING WRONG
 * ---------------------------------------------------------
 * A segmentation overlay drawn on the wrong slice still looks like a segmentation. It is
 * the single highest-consequence correctness risk this viewer took on when `MOS-CORE-038`
 * was reversed, and the register row's counter-argument names it: "the moment the platform
 * ships its own [viewer] it owns a rendering correctness problem it has no evidence for."
 *
 * So the alignment is done by IDENTITY, not by order:
 *
 *   1. PREFERRED. Each frame's (0008,9124) DerivationImageSequence -> (0008,2112)
 *      SourceImageSequence -> (0008,1155) ReferencedSOPInstanceUID names the exact CT
 *      instance the frame was computed from. That is an identifier, and matching on it
 *      cannot drift.
 *   2. FALLBACK. (0020,9113) PlanePositionSequence -> (0020,0032) ImagePositionPatient,
 *      projected on the stack normal and matched to the nearest slice within a tolerance
 *      of a quarter of the slice pitch. Used only when (1) is absent.
 *   3. NEVER. Frame order. PS3.3 C.7.6.16 does not require per-frame ordering to follow
 *      the source stack, and a SEG written by a tool that emits frames grouped by segment
 *      will overlay the right shapes on the wrong anatomy.
 *
 * A frame that matches by neither route is COUNTED AND REPORTED rather than dropped. An
 * overlay that is quietly missing half its frames is the same class of defect.
 *
 * BINARY ONLY, FOR NOW, AND IT SAYS SO
 * -------------------------------------
 * (0062,0001) SegmentationType FRACTIONAL carries probabilities, and rendering one as a
 * binary mask asserts a threshold nobody chose. `MOS-SVC-020` makes an operating point a
 * calibrated thing; inventing one in a viewer is exactly the "fabricated probability"
 * failure `services/lung_nodule/detector.py` refuses. FRACTIONAL is refused by name.
 *
 * Spec: MOS-CORE-038 (reversed at 0.4.0), MOS-SVC-020, MOS-IMG-066.
 * ===================================================================================== */

import { DicomRefusal } from '../dicom/parse.js';
import { dicomNumbers } from './volume.js';

const T = {
  SEGMENTATION_TYPE: '00620001',
  SEGMENT_SEQUENCE: '00620002',
  SEGMENT_NUMBER: '00620004',
  SEGMENT_LABEL: '00620005',
  SEGMENT_ALGORITHM_TYPE: '00620008',
  PER_FRAME_GROUPS: '52009230',
  SEGMENT_IDENTIFICATION: '0062000a',
  REFERENCED_SEGMENT_NUMBER: '0062000b',
  DERIVATION_IMAGE: '00089124',
  SOURCE_IMAGE: '00082112',
  REFERENCED_SOP_INSTANCE: '00081155',
  PLANE_POSITION: '00209113',
  IMAGE_POSITION: '00200032',
  ROWS: '00280010',
  COLUMNS: '00280011',
  NUMBER_OF_FRAMES: '00280008',
  PIXEL_DATA: '7fe00010',
};

/**
 * Decode a SEG instance against a stack.
 *
 * @returns {{
 *   segments: Array<{number:number,label:string,algorithm:string}>,
 *   planes: Map<number, Uint8Array>,   // stack frame index -> segment index per pixel
 *   matchedBy: {reference:number, position:number},
 *   unmatched: number,
 * }}
 */
export function decodeSegmentation(segInstance, stack) {
  const ds = segInstance.dataset;

  const type = ds[T.SEGMENTATION_TYPE];
  if (type && type !== 'BINARY') {
    throw new DicomRefusal(
      'fractional_segmentation',
      `SegmentationType is ${type}. This viewer renders BINARY segmentations only: ` +
      `displaying FRACTIONAL as a mask would apply a threshold nobody calibrated ` +
      `(MOS-SVC-020).`,
    );
  }

  const rows = ds[T.ROWS];
  const columns = ds[T.COLUMNS];
  if (rows !== stack.rows || columns !== stack.columns) {
    throw new DicomRefusal(
      'segmentation_geometry_mismatch',
      `the segmentation is ${columns}x${rows} and the series is ${stack.columns}x${stack.rows}. ` +
      `Resampling one onto the other would move boundaries without saying so.`,
    );
  }

  const segments = (ds[T.SEGMENT_SEQUENCE] || []).map((s) => ({
    number: Number(s[T.SEGMENT_NUMBER]),
    label: s[T.SEGMENT_LABEL] || `Segment ${s[T.SEGMENT_NUMBER]}`,
    algorithm: s[T.SEGMENT_ALGORITHM_TYPE] || 'UNKNOWN',
  }));

  const groups = ds[T.PER_FRAME_GROUPS] || [];
  const packed = ds[T.PIXEL_DATA];
  if (!packed) throw new DicomRefusal('no_segmentation_pixels', 'the SEG object carries no (7FE0,0010)');

  // Index the stack both ways, once.
  const byUID = new Map();
  stack.frames.forEach((f, i) => { if (f.sopInstanceUID) byUID.set(f.sopInstanceUID, i); });
  const normal = stack.frames[0].normal;
  const tolerance = Math.max(stack.sliceSpacing * 0.25, 1e-3);

  const planes = new Map();
  const matchedBy = { reference: 0, position: 0 };
  let unmatched = 0;
  const frameSize = rows * columns;

  // THE BITSTREAM HAS TO BE LONG ENOUGH FOR THE FRAMES THE OBJECT CLAIMS.
  //
  // The unpack below reads `packed[bit >> 3]`, and `packed` is a Uint8Array: past its end
  // that index is `undefined`, `undefined >> n` is 0, and every remaining pixel unpacks to
  // background. So a short bitstream produced an overlay that was fully present on the
  // early slices and empty on the late ones, threw nothing, and incremented nothing --
  // `matchedBy` counted every frame as matched and `unmatched` stayed 0, so the segments
  // panel printed "aligned: 4 by SOP reference, 0 unmatched" over a mask that stopped half
  // way. Measured on a SEG declaring four frames and carrying two:
  //
  //     pixels set per slice   1024, 1024, 0, 0      unmatched: 0
  //
  // The reassurance was wrong at the exact moment it mattered. `volume.js` already refuses
  // the equivalent truncation for images by name, and the two paths have to agree.
  //
  // (0028,0008) is read here and nowhere else in this module: it was in the tag table and
  // consulted by nothing, which is how the disagreement went unnoticed.
  const declared = Number(ds[T.NUMBER_OF_FRAMES] ?? groups.length) || groups.length;
  if (declared !== groups.length) {
    throw new DicomRefusal(
      'segmentation_frame_count_disagrees',
      `(0028,0008) declares ${declared} frame(s) and the per-frame functional groups `
      + `describe ${groups.length}. One of the two is wrong, and guessing which would put `
      + `a mask on slices nothing in this object accounts for.`,
    );
  }

  // Frames are packed CONTIGUOUSLY across the whole stream with no per-frame padding
  // (PS3.5 8.1.1), so the requirement is one ceiling over the total, not a sum of ceilings.
  const needed = Math.ceil((groups.length * frameSize) / 8);
  if (packed.length < needed) {
    throw new DicomRefusal(
      'truncated_segmentation_pixels',
      `${groups.length} frame(s) of ${columns}x${rows} at one bit per pixel need ${needed} `
      + `bytes and (7FE0,0010) carries ${packed.length}. Unpacking it would leave the last `
      + `${Math.ceil(((needed - packed.length) * 8) / frameSize)} frame(s) blank while every `
      + `counter reported a complete overlay.`,
    );
  }

  for (let frameIndex = 0; frameIndex < groups.length; frameIndex++) {
    const g = groups[frameIndex];

    const segNumber = Number(
      g[T.SEGMENT_IDENTIFICATION]?.[0]?.[T.REFERENCED_SEGMENT_NUMBER] ?? 1,
    );

    // (1) identity
    let target = null;
    const referenced = g[T.DERIVATION_IMAGE]?.[0]?.[T.SOURCE_IMAGE]?.[0]?.[T.REFERENCED_SOP_INSTANCE];
    if (referenced && byUID.has(referenced)) {
      target = byUID.get(referenced);
      matchedBy.reference++;
    } else {
      // (2) position
      const pos = dicomNumbers(g[T.PLANE_POSITION]?.[0]?.[T.IMAGE_POSITION]);
      if (pos.length === 3) {
        const depth = pos[0] * normal[0] + pos[1] * normal[1] + pos[2] * normal[2];
        let best = -1; let bestDelta = Infinity;
        for (let i = 0; i < stack.frames.length; i++) {
          const d = Math.abs(stack.frames[i].depth - depth);
          if (d < bestDelta) { bestDelta = d; best = i; }
        }
        if (best >= 0 && bestDelta <= tolerance) { target = best; matchedBy.position++; }
      }
    }

    if (target === null) { unmatched++; continue; }

    let plane = planes.get(target);
    if (!plane) { plane = new Uint8Array(frameSize); planes.set(target, plane); }

    // Unpack one bit per pixel, LSB first within each byte, frames packed contiguously
    // across the whole pixel-data stream (PS3.5 8.1.1).
    const bitStart = frameIndex * frameSize;
    for (let p = 0; p < frameSize; p++) {
      const bit = bitStart + p;
      if ((packed[bit >> 3] >> (bit & 7)) & 1) plane[p] = segNumber;
    }
  }

  return { segments, planes, matchedBy, unmatched };
}
