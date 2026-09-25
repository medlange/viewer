/* =====================================================================================
 * A CT stack, built from parsed instances. Geometry first, pixels second.
 *
 * WHY SLICES ARE SORTED BY POSITION AND NOT BY INSTANCE NUMBER
 * -------------------------------------------------------------
 * (0020,0013) InstanceNumber is a display hint. It is not required to be present, not
 * required to be unique, and not required to increase along the patient axis; multi-echo,
 * re-sent and re-numbered series all break it. Sorting by it produces a stack that scrolls
 * in the wrong order or interleaves two acquisitions, and NOTHING ABOUT THAT LOOKS LIKE
 * AN ERROR -- it looks like anatomy.
 *
 * So the sort key is the projection of (0020,0032) ImagePositionPatient onto the slice
 * normal, which is the cross product of the two direction cosines in (0020,0037)
 * ImageOrientationPatient. That is the patient-space depth of the slice, and it is what
 * the SEG overlay must agree with (`seg.js`). PS3.3 C.7.6.2.
 *
 * VALUES OF INTEREST ARE NOT PIXEL VALUES
 * ----------------------------------------
 * Stored pixels are integers in an arbitrary vendor range. The measurement is
 * `slope * stored + intercept` (PS3.3 C.11.1), which for CT is Hounsfield units. Every HU
 * threshold in the platform -- `lung_segmentation`'s air threshold, `emphysema_laa`'s
 * -950 -- is in that space, and `MOS-IMG-039`/`MOS-IMG-041` make a measurement computed
 * anywhere else "a defect, not an approximation". This module therefore carries slope and
 * intercept through to the shader rather than baking them into the texture: the GPU holds
 * stored values, and windowing happens in HU.
 *
 * Spec: MOS-IMG-039, MOS-IMG-041, MOS-CORE-038 (reversed at 0.4.0).
 * ===================================================================================== */

import { DicomRefusal } from '../dicom/parse.js';
import { deriveUnit, HOUNSFIELD } from './units.js';

const T = {
  SOP_INSTANCE_UID: '00080018',
  MODALITY: '00080060',
  ROWS: '00280010',
  COLUMNS: '00280011',
  SAMPLES_PER_PIXEL: '00280002',
  PHOTOMETRIC: '00280004',
  NUMBER_OF_FRAMES: '00280008',
  PER_FRAME_GROUPS: '52009230',
  SHARED_GROUPS: '52009229',
  PLANE_POSITION: '00209113',
  PLANE_ORIENTATION: '00209116',
  PIXEL_MEASURES: '00289110',
  // THE MODALITY LUT AND THE WINDOW ALSO LIVE IN FUNCTIONAL GROUPS, and for an Enhanced
  // instance they are usually absent from the top level entirely. Reading geometry from
  // the groups and these from the dataset gave an enhanced CT slope 1 and intercept 0 --
  // raw stored values, labelled HU -- while its positions came out perfectly correct.
  // (0028,0120) and (0028,0121). Pixels that carry no measurement -- on CT the area
  // outside the reconstruction circle. measure.js drops them from an ROI so they cannot
  // pull the mean toward a value no scanner produced.
  // (0028,0301). Whether the PIXELS carry patient identifiers -- a name burned into an
  // ultrasound still, a re-photographed film, a secondary capture. MOS-DATA-040 permits
  // `pixel_phi.action: ALLOW` -- unredacted pixels, no modification -- "only when the
  // consumer class is clinical_viewer", which makes this surface the one place the
  // platform deliberately lets burned-in PHI arrive. It has to say so.
  BURNED_IN_ANNOTATION: '00280301',
  // (0008,0008). MOS-DATA-041 permits an ORIGINAL\PRIMARY acquisition to be presumed free
  // of burned-in text without screening. Without that, an absent (0028,0301) would warn on
  // every CT in the archive -- and a warning that fires on everything is read as noise
  // exactly when it fires on the ultrasound that does carry a name.
  IMAGE_TYPE: '00080008',
  PIXEL_PADDING_VALUE: '00280120',
  PIXEL_PADDING_RANGE_LIMIT: '00280121',
  // (0028,1056). Which transfer function the window was authored for. It lives in the
  // FrameVOILUTSequence on an Enhanced instance, so it resolves through the same
  // functional-group precedence as the window itself.
  VOI_LUT_FUNCTION: '00281056',
  RESCALE_TYPE: '00281054',
  // (0054,1001). PET and NM state their own unit outright -- BQML, CNTS, PROPCNTS -- and
  // it is the more specific statement than RescaleType where both are present.
  UNITS: '00541001',
  PIXEL_VALUE_TRANSFORMATION: '00289145',
  FRAME_VOI_LUT: '00289132',
  BITS_ALLOCATED: '00280100',
  // unread: PS3.5 8.1.1 requires a writer to zero the unused high bits (unsigned) or
  // sign-extend into them (signed), so for conformant data the full 16-bit word IS the
  // value and masking would change nothing. A non-conformant writer is a real hazard but
  // detecting it costs a scan of every pixel, and this loader does not pay that per slice.
  BITS_STORED: '00280101',
  PIXEL_REPRESENTATION: '00280103',
  PIXEL_SPACING: '00280030',
  RESCALE_INTERCEPT: '00281052',
  RESCALE_SLOPE: '00281053',
  WINDOW_CENTER: '00281050',
  WINDOW_WIDTH: '00281051',
  IMAGE_POSITION: '00200032',
  IMAGE_ORIENTATION: '00200037',
  PIXEL_DATA: '7fe00010',
  FRAME_OF_REFERENCE_UID: '00200052',
};

/** DS/IS are text with backslash separators. One place that knows that. */
function numbers(value) {
  if (value === undefined || value === null) return [];
  if (typeof value === 'number') return [value];
  if (typeof value !== 'string') return Array.from(value, Number);
  return value.split('\\').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
}

function firstNumber(value, fallback) {
  const n = numbers(value);
  return n.length ? n[0] : fallback;
}

/**
 * A multi-valued CS or LO as its parts, upper-cased. DICOM separates values with a
 * backslash (PS3.5 6.2), which is why this lives beside `numbers` rather than inline: the
 * separator is easy to get wrong in a string literal and wrong here is silent.
 */
function textValues(value) {
  if (value === undefined || value === null) return [];
  return String(value).toUpperCase().split(String.fromCharCode(92)).map((s) => s.trim());
}

/**
 * Every consecutive gap in the stack, and whether they agree.
 *
 * TOLERANCE IS RELATIVE, because the numbers are floats derived from patient coordinates
 * and a 0.7 mm study does not have the same absolute noise as a 5 mm one. One percent of
 * the median, floored at 10 microns, accepts real acquisition jitter and rejects a missing
 * slice -- which is a gap of exactly one pitch, a hundred times the threshold.
 *
 * The MEDIAN rather than the mean: one 10 mm gap in a 2 mm series drags a mean to 2.3 and
 * leaves it looking plausible, while the median stays 2 and `uniform` goes false. The
 * number a reader sees should not be quietly bent by the outlier that makes it unsafe.
 */
function spacingOf(frames) {
  // ONE FRAME HAS NO GAPS. The 1 below keeps the reconstruction arithmetic finite --
  // nothing can be reconstructed from a single slice anyway -- and `stated: false` is
  // what stops it reaching a reader as a measured distance.
  if (frames.length < 2) {
    return { median: 1, uniform: true, min: 1, max: 1, stated: false };
  }

  const gaps = [];
  for (let i = 1; i < frames.length; i++) {
    gaps.push(Math.abs(frames[i].depth - frames[i - 1].depth));
  }
  const sorted = [...gaps].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;

  const tolerance = Math.max(median * 0.01, 1e-2);
  const uniform = gaps.every((g) => Math.abs(g - median) <= tolerance);

  return { median, uniform, min: sorted[0], max: sorted[sorted.length - 1], stated: true };
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/**
 * Build a stack from the instances of one series.
 *
 * Throws `DicomRefusal` when the series is not something this viewer can display as a
 * stack -- mixed geometry, absent pixel data, a bit depth it does not handle. It never
 * repairs: a stack assembled from slices of two different frames of reference is wrong in
 * a way that renders.
 */
export function buildStack(instances) {
  const frames = [];

  for (const { dataset } of instances) {
    const pixels = dataset[T.PIXEL_DATA];
    if (!pixels) continue;                       // SR and RTSTRUCT have none; not an error

    const rows = dataset[T.ROWS];
    const columns = dataset[T.COLUMNS];
    const bitsAllocated = dataset[T.BITS_ALLOCATED] ?? 16;
    const signed = (dataset[T.PIXEL_REPRESENTATION] ?? 1) === 1;

    // (0028,0004) PhotometricInterpretation. PS3.3 C.7.6.3.1.2.
    //
    // THIS ATTRIBUTE DECIDES WHICH END OF THE RAMP IS WHITE, and until this commit the
    // viewer did not read it. MONOCHROME1 -- the usual encoding for CR, DX and MG -- means
    // the MINIMUM stored value displays as WHITE. Rendered as MONOCHROME2 the image comes
    // out inverted: bone black, air white. It is not a crash and not a glitch; it is a
    // photographically plausible negative of the correct image, which is the worst kind of
    // wrong because nothing about it looks broken.
    //
    // Defaulting when absent: MONOCHROME2. The attribute is Type 1 and its absence means a
    // malformed dataset rather than an ambiguous one, but refusing would reject data the
    // viewer can otherwise display correctly in the overwhelmingly common case. Mixed
    // values WITHIN a series are refused below, which is the case where guessing renders.
    const photometric = String(dataset[T.PHOTOMETRIC] ?? 'MONOCHROME2').trim().toUpperCase();
    const samples = dataset[T.SAMPLES_PER_PIXEL] ?? 1;

    if (photometric !== 'MONOCHROME1' && photometric !== 'MONOCHROME2') {
      throw new DicomRefusal(
        'unsupported_photometric_interpretation',
        `PhotometricInterpretation is ${photometric}; this viewer renders MONOCHROME1 and ` +
        `MONOCHROME2. A colour or palette image read as grayscale is not a degraded ` +
        `picture, it is a different one.`,
      );
    }
    if (samples !== 1) {
      throw new DicomRefusal(
        'unsupported_samples_per_pixel',
        `SamplesPerPixel is ${samples}; this viewer reads single-sample grayscale. ` +
        `Interleaved samples read as one channel produce a plausible-looking stripe pattern.`,
      );
    }

    if (bitsAllocated !== 16) {
      throw new DicomRefusal(
        'unsupported_bit_depth',
        `BitsAllocated is ${bitsAllocated}; this viewer reads 16-bit CT. An 8-bit or 32-bit ` +
        `path would need its own verification and has none.`,
      );
    }

    // (0028,0008) NumberOfFrames. ONE INSTANCE CAN CARRY A WHOLE ACQUISITION.
    //
    // Until this was added the loader computed `rows * columns` and read exactly that many
    // values, so an Enhanced CT or MR instance -- or a US cine, or an XA run -- produced a
    // stack of depth 1 and the other N-1 frames were silently discarded. `seg.js` has read
    // this tag since it was written, because a SEG is ALWAYS multi-frame; the image loader
    // not reading it meant a multi-frame image carrying a segmentation would match a
    // hundred SEG frames against a stack one slice deep.
    const declaredFrames = Math.trunc(Number(dataset[T.NUMBER_OF_FRAMES] ?? 1)) || 1;
    const frameSize = rows * columns;

    // A TRUNCATED MULTI-FRAME IS REFUSED rather than read as far as it goes. Reading N-1
    // frames and stopping would produce a stack whose depth disagrees with the header, and
    // every position-matched overlay after the cut would land on the wrong slice.
    const needed = declaredFrames * frameSize * 2;
    if (pixels.byteLength < needed) {
      throw new DicomRefusal(
        'truncated_pixel_data',
        `(0028,0008) declares ${declaredFrames} frame(s) of ${columns}x${rows}, which needs ` +
        `${needed} bytes, and (7FE0,0010) carries ${pixels.byteLength}. A short read would ` +
        `give a stack whose depth disagrees with its own header.`,
      );
    }

    /**
     * One attribute for frame `k`, by PS3.3 C.7.6.16's precedence.
     *
     * Per-frame group first, then the shared group, then the top-level dataset. The last
     * step is what lets a single-frame instance run through the identical code path rather
     * than a parallel one -- and a parallel path is how the two drift.
     */
    const perFrame = dataset[T.PER_FRAME_GROUPS] || [];
    const sharedGroup = (dataset[T.SHARED_GROUPS] || [])[0] || {};
    const fromGroups = (k, sequence, element) => (
      perFrame[k]?.[sequence]?.[0]?.[element]
      ?? sharedGroup[sequence]?.[0]?.[element]
      ?? dataset[element]
    );

    const dv = new DataView(pixels.buffer, pixels.byteOffset, pixels.byteLength);

    for (let k = 0; k < declaredFrames; k++) {
      const orientation = numbers(fromGroups(k, T.PLANE_ORIENTATION, T.IMAGE_ORIENTATION));
      const position = numbers(fromGroups(k, T.PLANE_POSITION, T.IMAGE_POSITION));
      const spacing = numbers(fromGroups(k, T.PIXEL_MEASURES, T.PIXEL_SPACING));
      const normal = orientation.length === 6
        ? cross(orientation.slice(0, 3), orientation.slice(3, 6))
        : [0, 0, 1];
      const depth = position.length === 3
        ? position[0] * normal[0] + position[1] * normal[1] + position[2] * normal[2]
        : 0;

      // A 16-bit view over a byte range that may start at an odd absolute offset.
      const view = signed ? new Int16Array(frameSize) : new Uint16Array(frameSize);
      const base = k * frameSize;
      for (let i = 0; i < frameSize; i++) {
        const at = (base + i) * 2;
        view[i] = signed ? dv.getInt16(at, true) : dv.getUint16(at, true);
      }

      frames.push({
        sopInstanceUID: dataset[T.SOP_INSTANCE_UID],
        frameOfReferenceUID: dataset[T.FRAME_OF_REFERENCE_UID] || null,
        /** Which frame of its instance. Single-frame instances are frame 0 of one. */
        frameNumber: k,
        /**
         * WHETHER THIS FRAME KNOWS WHERE IT IS. False for a cine loop, whose frames are
         * separated by TIME and not by distance; `stack.spatial` is computed from it.
         */
        hasPosition: position.length === 3,
        rows, columns, signed, depth, normal, position, orientation, photometric,
        /**
         * WHETHER THIS FRAME KNOWS HOW BIG ITS PIXELS ARE. (0028,0030) is absent on CR and
         * DX, which state (0018,1164) ImagerPixelSpacing instead -- a detector pitch, not a
         * patient distance, and not interchangeable with one.
         *
         * The [1, 1] below keeps the geometry working: the fit needs SOME aspect and 1:1 is
         * the only neutral one. What it must never do is reach a reader as a millimetre.
         * The scale bar is drawn unbidden on every frame, so without this flag it printed a
         * round number of fabricated millimetres over a picture, with nothing to
         * distinguish it from a bar derived from a stated spacing.
         */
        hasPixelSpacing: spacing.length === 2,
        pixelSpacing: spacing.length === 2 ? spacing : [1, 1],
        // MODALITY WAS IN THIS TABLE AND READ BY NOTHING, which is how three renderers
        // came to print "HU" on every modality the viewer can open.
        modality: dataset[T.MODALITY] || null,
        burnedInAnnotation: dataset[T.BURNED_IN_ANNOTATION]
          ? String(dataset[T.BURNED_IN_ANNOTATION]).trim().toUpperCase()
          : null,
        imageType: textValues(dataset[T.IMAGE_TYPE]),
        paddingValue: firstNumber(dataset[T.PIXEL_PADDING_VALUE], null),
        paddingRangeLimit: firstNumber(dataset[T.PIXEL_PADDING_RANGE_LIMIT], null),
        rescaleType: fromGroups(k, T.PIXEL_VALUE_TRANSFORMATION, T.RESCALE_TYPE) || null,
        units: dataset[T.UNITS] || null,
        slope: firstNumber(fromGroups(k, T.PIXEL_VALUE_TRANSFORMATION, T.RESCALE_SLOPE), 1),
        intercept: firstNumber(fromGroups(k, T.PIXEL_VALUE_TRANSFORMATION, T.RESCALE_INTERCEPT), 0),
        windowCenter: firstNumber(fromGroups(k, T.FRAME_VOI_LUT, T.WINDOW_CENTER), null),
        windowWidth: firstNumber(fromGroups(k, T.FRAME_VOI_LUT, T.WINDOW_WIDTH), null),
        voiFunction: textValues(fromGroups(k, T.FRAME_VOI_LUT, T.VOI_LUT_FUNCTION))[0] || null,
        pixels: view,
      });
    }
  }

  if (!frames.length) {
    throw new DicomRefusal('no_pixel_data', 'no instance in this series carried (7FE0,0010) PixelData');
  }

  /**
   * DO THESE FRAMES ALL FACE THE SAME WAY?
   *
   * A 3-PLANE LOCALIZER DOES NOT, and it is not a rare object -- 43 of 153 MR series in a
   * clinic corpus carried slices in more than one orientation. Its frames are usually all
   * the same size, so `mixed_geometry` below passes them, and every one of them lands in
   * one stack.
   *
   * MEASURED, on one such series: 17 frames, five axial, five sagittal and seven coronal,
   * sorted into the order 0=axial 1=sagittal 2=axial 3=sagittal ... 13-16=coronal. The
   * reader scrolls and the anatomy flips between three planes while the HUD calls all
   * seventeen "axial", because the plane is taken from `frames[0]`. Two frames sat at
   * depth -30.0 and two more at -15.0, because a depth is the projection on `frames[0]`'s
   * normal and twelve of the seventeen do not share it.
   *
   * SO IT IS NOT SORTED. Depth is not an ordering here -- it is a projection of unrelated
   * planes onto one axis -- and sorting by it interleaves the three sets into an order
   * that means nothing. The encoded order is what the scanner wrote and the only order
   * that survives the question being wrong.
   */
  const facing = frames[0].normal;
  const coplanar = !facing || frames.every((f) => {
    if (!f.normal) return false;
    const dot = f.normal[0] * facing[0] + f.normal[1] * facing[1] + f.normal[2] * facing[2];
    // |dot|: a slice encoded with its normal reversed lies in the same plane.
    return Math.abs(Math.abs(dot) - 1) < 1e-3;
  });

  // STABLE BY SPECIFICATION, and that is what makes a cine loop come out in order. Every
  // frame of a temporal multi-frame has depth 0, so this comparator returns 0 for all of
  // them and ES2019's stability guarantee preserves the encoded order -- which for a cine
  // is the only order that means anything. A series that is not coplanar is left in that
  // order too, for the reason above.
  if (coplanar) frames.sort((a, b) => a.depth - b.depth);

  const { rows, columns } = frames[0];
  const mixed = frames.find((f) => f.rows !== rows || f.columns !== columns);
  if (mixed) {
    throw new DicomRefusal(
      'mixed_geometry',
      `this series mixes ${columns}x${rows} and ${mixed.columns}x${mixed.rows} frames. ` +
      `Displaying them as one stack would resample without saying so.`,
    );
  }

  // MIXED POLARITY IS REFUSED, and for a sharper reason than mixed geometry. The viewport
  // holds ONE invert flag for the stack, so a series carrying both encodings would render
  // half its slices as negatives of the other half -- and scrolling through it would look
  // like a window change rather than a fault.
  const pitch = spacingOf(frames);
  const { photometric } = frames[0];
  const flipped = frames.find((f) => f.photometric !== photometric);
  if (flipped) {
    throw new DicomRefusal(
      'mixed_photometric_interpretation',
      `this series mixes ${photometric} and ${flipped.photometric}. One of the two would ` +
      `be displayed as its own negative, and scrolling would look like a window change.`,
    );
  }

  /**
   * WHETHER THESE FRAMES ARE SEPARATED BY DISTANCE OR BY TIME.
   *
   * This is the distinction that decides whether a reconstruction means anything. A CT
   * series and a US cine loop are both "a stack of frames", and `mpr.js` will happily
   * resample either -- but on a cine the axis it treats as millimetres is SECONDS, so the
   * coronal view is one image row plotted against time, drawn with a millimetre scale, and
   * a caliper across it returns a distance for a duration. That is a number about nothing,
   * presented exactly like a number about the patient.
   *
   * A stack is spatial when every frame carries a position AND no two frames share a
   * depth. Duplicate depths are treated as non-spatial rather than tolerated: a resampling
   * through two coincident slices is as meaningless as one through a time series, and the
   * conservative answer costs a reconstruction nobody should have trusted.
   */
  const positioned = frames.every((f) => f.hasPosition);
  const distinctDepths = new Set(frames.map((f) => f.depth.toFixed(4))).size;
  // AND NOT SPATIAL WHEN THE FRAMES FACE DIFFERENT WAYS. `mpr.js` reads `spatial` to
  // decide whether a reconstruction means anything, and resampling a volume assembled from
  // three orthogonal sets is exactly the "number about nothing" the comment above refuses
  // for a cine. It reaches the same answer here by the same argument.
  const spatial = positioned && distinctDepths === frames.length && coplanar;

  return {
    frames,
    rows,
    columns,
    depth: frames.length,
    spatial,
    /**
     * Whether every frame lies in the same plane.
     *
     * Separate from `spatial` because it needs its own SENTENCE. "This series is not a
     * volume" and "these frames are separated by time" are different facts, and a reader
     * shown the cine wording for a localizer would go looking for a cine.
     */
    coplanar,
    /**
     * (0020,0052). THE KEY THAT DECIDES WHETHER TWO SERIES MAY BE SYNCHRONISED BY POSITION.
     *
     * PS3.3 C.7.4.1: a Frame of Reference UID asserts that every image carrying it shares one
     * patient coordinate system, so their (0020,0032) ImagePositionPatient values are
     * comparable. Two series with DIFFERENT values make no such assertion, and matching their
     * coordinates is arithmetic on two unrelated origins -- it produces a number, the viewer
     * scrolls, and the two panels show unrelated anatomy while looking perfectly synchronised.
     * `sync.js` refuses position sync across a mismatch for exactly that reason.
     *
     * Null when the series does not carry one, which is treated the same as a mismatch.
     */
    frameOfReferenceUID: frames[0].frameOfReferenceUID,
    /**
     * Slice pitch in mm, measured from the geometry rather than trusted from (0018,0088).
     *
     * MEASURED FROM EVERY GAP, not from the first two. This used to be
     * `abs(frames[1].depth - frames[0].depth)` and that one number was then applied to the
     * whole stack: as the reconstruction's craniocaudal axis in `mpr.js`, as the SEG
     * position-matching tolerance in `seg.js`, and as the HUD's millimetres per slice. A
     * series with a gap -- a dropped instance, a two-block acquisition -- reported the pitch
     * of its first pair and closed the gap silently, so a coronal view showed anatomy at
     * positions nothing was acquired at and a caliper down it was short by the gap.
     *
     * `pitch` below is the MEDIAN, which is the honest single number for a stack that is
     * mostly uniform, and `uniformSpacing` says whether a single number is honest at all.
     */
    sliceSpacing: pitch.median,
    /** Whether that pitch was MEASURED between two slices, or is the one-frame stand-in. */
    hasSliceSpacing: pitch.stated,
    /**
     * Whether every consecutive gap agrees. False for a stack with a gap or a variable
     * pitch, and `mpr.js` refuses to reconstruct one: resampling assumes the third axis is
     * evenly sampled, and where it is not the picture is drawn at positions that were
     * never acquired.
     */
    uniformSpacing: pitch.uniform,
    /** The measured extremes, so a refusal can say what it found rather than that it failed. */
    spacingRange: { min: pitch.min, max: pitch.max },
    /**
     * (0028,0004), uniform across the stack because a mixed one is refused above.
     *
     * The RENDERER applies this, never the loader. `frame.pixels` stays in stored values
     * and `measure.js` computes HU from it through slope/intercept -- inverting the array
     * here would silently negate every ROI mean and every caliper's underlying sample.
     * Polarity is a property of the DISPLAY transform, and the shader already has the
     * exact place for it: one line after windowing, before the overlay is mixed in.
     */
    photometric,
    /**
     * What `slope * stored + intercept` is a number OF, or null when the header does not
     * say. Derived once here by `units.js` so that the readout, the annotation label and
     * the measurements panel cannot disagree with each other -- which they did, by all
     * three printing "HU" unconditionally.
     */
    valueUnit: deriveUnit(frames[0]),
    modality: frames[0].modality,
    /**
     * What (0028,0301) says, verbatim, or null when the object does not say.
     *
     * NOT a `burned_in_state`. That enum is closed by MOS-DATA-042 to UNSCREENED, CLEAN,
     * SUSPECTED and REDACTED, and three of the four are claims about SCREENING that this
     * viewer has not performed and cannot perform. Rule 1 of MOS-DATA-038 can presume a
     * series clean without screening, but only against the tenant's `pixel_phi` block --
     * which this surface does not have. So it reports the attribute and leaves the state to
     * the plane that owns it; a viewer that asserted CLEAN would be inventing a platform
     * state from a header field.
     */
    burnedInAnnotation: frames[0].burnedInAnnotation,
    /**
     * Whether an absent (0028,0301) still warrants saying so.
     *
     * MOS-DATA-041: an ORIGINAL\PRIMARY acquisition MAY be presumed free of burned-in
     * text under rule 1 of MOS-DATA-038, and a tenant that declines that presumption sets
     * `screen_when_burned_in_annotation` to force universal screening. This surface takes
     * the presumption, because the alternative is a warning on every CT in the archive --
     * and a warning that fires on everything is read as noise at exactly the moment it
     * fires on the secondary capture that does carry a name.
     */
    burnedInUnknown: frames[0].burnedInAnnotation === null
      && !(frames[0].imageType[0] === 'ORIGINAL' && frames[0].imageType[1] === 'PRIMARY'),
    /** The default window: the header's if present, else a lung/soft-tissue compromise. */
    defaultWindow: pickWindow(frames[0], frames),
  };
}

/**
 * The initial window/level, on the series' OWN scale.
 *
 * (0028,1050)/(0028,1051) when the header carries them, because that is what the
 * acquisition intended.
 *
 * FAILING THAT, 400/40 IS A CT ANSWER AND WAS GIVEN TO EVERYTHING. It is a soft-tissue
 * window in HOUNSFIELD UNITS, and it is the right fallback on CT for the reason below --
 * but it was returned unconditionally, for any modality, on any scale. MEASURED: the
 * synthetic PET of `tools/demo/seed_corpus.py` carries a concentration in BQML with a
 * body background of 1200 and a lesion at 24000, and W 400 / L 40 put every one of those
 * values past the top of the ramp. The panel rendered as a white rectangle. `presets.json`
 * records the same failure from the other side -- the Brain window on brain MR, "whites
 * the panel out entirely" -- and the machinery added then refuses a HU PRESET on a non-HU
 * series while this, the DEFAULT, went on handing one out.
 *
 * SO THE FALLBACK ASKS WHAT SCALE IT IS ON. On HU, 400/40, rather than a full-range
 * autoscale which maps the -1000 HU air background and the +3000 HU table to the ends of
 * the ramp and leaves every soft tissue the same grey. On anything else -- PET in BQML,
 * MR in arbitrary signal intensity -- there IS no conventional window, and inventing one
 * would be `MOS-REL-077`'s forbidden value with no source. The honest answer is the data's
 * own range, taken at percentiles so that one hot voxel or one dead one does not set it.
 */
function pickWindow(frame, frames) {
  if (frame.windowCenter !== null && frame.windowWidth !== null && frame.windowWidth > 0) {
    return { center: frame.windowCenter, width: frame.windowWidth };
  }
  if (deriveUnit(frame) === HOUNSFIELD) return { center: 40, width: 400 };
  return windowFromData(frames && frames.length ? frames : [frame]);
}

/**
 * A window derived from the frame's own values, for a scale that has no convention.
 *
 * PERCENTILES, NOT MIN AND MAX. A single saturated voxel -- and a PET reconstruction has
 * them -- would otherwise set the top of the ramp and push the tissue everyone is looking
 * at into the bottom eighth of it.
 *
 * THE BACKGROUND IS EXCLUDED where it is exactly zero, which on PET and MR is air outside
 * the patient rather than a measurement. Including it puts the low end of the window
 * outside the body and spends half the ramp on nothing.
 */
function windowFromData(frames) {
  // ACROSS THE VOLUME, NOT ONE SLICE, and that distinction was not academic. The first
  // version read `frames[0]`, and on the synthetic PET the first slice is uniform
  // background: the 2nd and 98th percentiles were both 1200 BQML, the width came out 0,
  // and the panel rendered as one flat grey. The lesion -- the entire point of the series
  // -- lives on four slices out of thirty-two and was invisible to the window meant to
  // show it. A window describes what a reader is going to scroll through.
  //
  // SIXTEEN SLICES AT MOST, evenly spread. A 500-slice CT at full sampling is a sort of
  // several million values on the load path, and the percentiles of a volume do not move
  // measurably between sixteen slices and five hundred.
  const stride = Math.max(1, Math.ceil(frames.length / 16));
  const kept = [];
  for (let f = 0; f < frames.length; f += stride) {
    const frame = frames[f];
    const px = frame && frame.pixels;
    if (!px || !px.length) continue;
    // EVERY Nth VALUE within the slice, for the same reason.
    const step = Math.max(1, Math.floor(px.length / 4096));
    for (let i = 0; i < px.length; i += step) {
      const v = px[i] * frame.slope + frame.intercept;
      if (v !== 0) kept.push(v);
    }
  }
  if (kept.length < 16) return { center: 40, width: 400 };
  kept.sort((a, b) => a - b);

  // THE BOTTOM IS A PERCENTILE AND THE TOP IS THE MAXIMUM, which is not an inconsistency.
  //
  // A percentile at the top was the first version and it erased the only thing on the
  // image. MEASURED on the synthetic PET: the lesion is a 6 mm sphere in a 128x128x32
  // volume of 2.8 x 2.8 x 4 mm voxels -- about sixty voxels out of half a million, which
  // is 0.011% of the series. The 98th percentile is therefore the background exactly, the
  // 99.9th is too, the width came out 0, and the panel rendered as one flat grey with the
  // uptake nowhere in it.
  //
  // That is not a defect in the data. On PET the SIGNAL IS THE RARE BRIGHT THING, and a
  // robust estimator of the bulk is an estimator of the part nobody is looking at. The
  // bottom still takes a percentile, because the low end is noise and background where
  // robustness is exactly what is wanted.
  const at = (q) => kept[Math.min(kept.length - 1, Math.max(0, Math.round(q * (kept.length - 1))))];
  const low = at(0.02);
  const high = kept[kept.length - 1];
  const width = high - low;
  // A FLAT FRAME HAS NO WINDOW. Returning width 0 would divide by it in the shader and
  // render the panel as one colour with no way back; 1 is arbitrary and visible.
  if (!(width > 0)) return { center: low, width: 1 };
  return { center: low + width / 2, width };
}

export { numbers as dicomNumbers, T as TAGS };
