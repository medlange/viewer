/* =====================================================================================
 * What the numbers are numbers OF, decided in exactly one place.
 *
 * THE DEFECT THIS REMOVES
 * ------------------------
 * The viewer wrote the literal string "HU" in three places -- the cursor readout, the
 * on-image annotation label and the measurements panel -- and none of the three consulted
 * the modality. On a CT that is right. On a PET the rescaled value is an activity
 * concentration whose unit the header states in (0054,1001), typically BQML; on an MR the
 * stored values are arbitrary and have no defined unit at all.
 *
 * So a PET voxel of 12500 Bq/ml rendered as "12500 HU", and an ROI over a lesion read
 * "18400 ± 2100 HU". Both numbers are arithmetically correct and both labels are a
 * category error: there is no Hounsfield scale on a PET. A reader comparing that figure to
 * a CT threshold, or copying it into a report, carries a number in the wrong unit with
 * nothing on screen suggesting it is wrong.
 *
 * WHY ONE FUNCTION AND NOT THREE FIXES
 * -------------------------------------
 * `MOS-UI-029` states the principle for the REJECTED/FAILED distinction: the state "MUST be
 * decided in exactly one place in the surface's code, and every renderer MUST ask that one
 * function. A surface that string-matches a state in more than one component will
 * eventually disagree with itself." The same argument applies exactly here, and the
 * evidence is that three components already did disagree with the data.
 *
 * WHAT THIS REFUSES TO DO
 * ------------------------
 * It never invents a unit. Radiologists say "signal intensity" for MR, and a viewer that
 * printed "SI" would be asserting a vocabulary DICOM does not supply for that field. When
 * no unit can be derived the caller is given null and renders the value with the literal
 * marker `unit not recorded` -- the same idiom `MOS-UI-037` fixes for the provenance panel,
 * where an absent field is shown as absent rather than omitted. A bare number with no unit
 * is worse than either: it invites the reader to supply "HU" from habit.
 *
 * Spec: MOS-UI-029 (one decision point), MOS-UI-037 (absent is rendered, not omitted),
 * MOS-CORE-004 (units are vocabulary), MOS-IMG-039, MOS-IMG-041.
 * ===================================================================================== */

/** The literal shown where a unit would go when the header does not supply one. */
export const NO_UNIT = 'unit not recorded';

/**
 * Hounsfield units, named once.
 *
 * EXPORTED BECAUSE SOMETHING OUTSIDE HAS TO COMPARE AGAINST IT. `volume.js` picks a
 * default window and the CT soft-tissue pair 400/40 is only meaningful on this scale, so
 * it has to ask whether it is on it -- and writing `=== 'HU'` there would put the
 * spelling of a unit in a second file, which is the decision
 * `test_no_renderer_hardcodes_a_unit` exists to stop being taken three times.
 *
 * A COMPARISON IS NOT A RENDERING, and that gate cannot tell them apart -- nor should it
 * try, because the way to make the difference safe is for there to be one spelling.
 */
export const HOUNSFIELD = 'HU';

/**
 * (0028,1054) RescaleType = "US" means UNSPECIFIED, which is a statement that there is no
 * unit rather than the name of one. Rendering "US" beside a number would read as a unit.
 */
const UNSPECIFIED = 'US';

/**
 * The unit of `slope * stored + intercept`, or null when the header does not say.
 *
 * Precedence is PS3.3's, not a preference:
 *
 *   1. (0054,1001) Units    PET and NM state it outright. BQML, CNTS, PROPCNTS, CM2ML.
 *   2. (0028,1054) RescaleType  The Modality LUT's own output unit, when present.
 *   3. Modality CT          Hounsfield by definition of the modality.
 *   4. nothing              MR, US, and anything else whose stored values are arbitrary.
 *
 * Order matters: a PET that also carries RescaleType must be read through (0054,1001),
 * which is the more specific statement.
 *
 * @param {{modality?:string, rescaleType?:string, units?:string}} source
 * @returns {string|null}
 */
export function deriveUnit(source) {
  const clean = (v) => (typeof v === 'string' ? v.trim().toUpperCase() : '');

  const units = clean(source && source.units);
  if (units) return units;

  const rescaleType = clean(source && source.rescaleType);
  if (rescaleType && rescaleType !== UNSPECIFIED) return rescaleType;

  if (clean(source && source.modality) === 'CT') return HOUNSFIELD;

  return null;
}

/**
 * A value with its unit, for display.
 *
 * The number is formatted here and the stored measurement keeps full precision, so nothing
 * downstream is ever tempted to re-parse a label back into a number.
 *
 * @param {number} value
 * @param {string|null} unit
 * @param {number} [digits]
 */
export function withUnit(value, unit, digits = 0) {
  const n = Number(value).toFixed(digits);
  return unit ? `${n} ${unit}` : `${n} · ${NO_UNIT}`;
}

/**
 * A mean and spread with their unit.
 *
 * Mean and SD travel together, always. A mean alone invites a heterogeneous region to be
 * read as a homogeneous one -- an ROI straddling the body edge during this viewer's own
 * verification reported -473, which looks like a plausible tissue value until the spread of
 * 430 beside it says the region spans air and soft tissue.
 */
/**
 * What to say about pixels an ROI enclosed and did not measure, or '' when there were none.
 *
 * `regionStatistics` drops (0028,0120) padding from the mean, which is right -- padding is
 * not tissue. But dropping it silently makes the reported count smaller than the shape the
 * reader drew, and the area beside the mean is that count times the pixel area. A shape
 * covering 500 pixels that reports 380 has to say why, or the two stop matching and the
 * reader is left to wonder which one is lying.
 *
 * Both renderers call this so they cannot disagree about it, which is the same rule that
 * put the unit itself in one place.
 */
/** The literal shown where a distance would go when (0028,0030) was never stated. */
export const NO_SCALE = 'pixel spacing not recorded';

/**
 * A distance in millimetres, or a refusal to call it one.
 *
 * (0028,0030) PixelSpacing is what turns a pixel count into a patient distance. CR and DX
 * do not carry it -- they state (0018,1164) ImagerPixelSpacing, which is a detector pitch
 * and not the same quantity -- so `volume.js` substitutes [1, 1] to keep the geometry
 * working and records that it did.
 *
 * A caliper on such a frame has measured something real: a number of pixels. It has not
 * measured millimetres, and printing "84.0 mm" for it is the same category error as
 * printing "HU" on a PET. So the pixel count is what gets shown, with the reason beside it.
 *
 * @param {number} mm     the value computed against the substituted spacing
 * @param {number} px     the same distance in pixels
 * @param {boolean} stated  whether the header gave a spacing
 */
export function distanceText(mm, px, stated, digits = 1) {
  if (stated) return `${Number(mm).toFixed(digits)} mm`;
  return `${Number(px).toFixed(digits)} px · ${NO_SCALE}`;
}

/**
 * An angle in degrees, or degrees with the reason they may not be the patient's.
 *
 * AN ANGLE DOES NOT CHANGE UNIT when the spacing is missing, which is exactly why it was
 * printed without a caveat while the caliper beside it carried one. `angle()` scales each
 * ray by (0028,0030) before taking the dot product, because on an anisotropic frame the
 * pixel angle and the patient angle differ -- measured, 45.000 degrees in pixels reads
 * 70.710 on a 2.00 x 0.70 mm coronal. When the header states no spacing, `volume.js`
 * substitutes [1, 1], and the number that comes out is the angle in the PIXEL GRID: correct
 * for the grid, and the patient's only if the pixels happen to be square.
 *
 * So the value still prints -- it is a real measurement of a real thing -- with the same
 * sentence the caliper uses, because the reader's question is the same one.
 */
export function angleText(deg, stated, digits = 1) {
  if (!Number.isFinite(deg)) return '';
  const text = `${Number(deg).toFixed(digits)}°`;
  return stated ? text : `${text} · ${NO_SCALE}`;
}

/** The same, for an area. */
export function areaText(mm2, px2, stated, digits = 1) {
  if (stated) return `${Number(mm2).toFixed(digits)} mm²`;
  return `${Number(px2).toFixed(0)} px² · ${NO_SCALE}`;
}

/**
 * Whether a stored value is padding, given the frame that declares it.
 *
 * (0028,0120) PixelPaddingValue and (0028,0121) PixelPaddingRangeLimit mark pixels the
 * scanner never measured -- the corners outside the reconstruction circle, the fill a shear
 * correction introduced. They are not tissue and they are not a density.
 *
 * ONE PREDICATE, because two ways of asking this is how two answers come about. `measure.js`
 * excludes padding from an ROI mean; `mpr.js` must exclude it from a projection's extreme,
 * and on a MINIMUM-intensity projection the difference is not subtle: padding is usually the
 * lowest value in the volume, so a min-IP that does not skip it returns the padding value
 * along every ray that touches a corner. The out-of-field region is then drawn over the
 * anatomy, at full contrast, looking like a finding.
 *
 * @param {{paddingValue?:number|null, paddingRangeLimit?:number|null}} source
 * @returns {(stored:number) => boolean}
 */
export function paddingTest(source) {
  const pad = source ? source.paddingValue : null;
  if (pad === null || pad === undefined) return () => false;
  const limit = source.paddingRangeLimit;
  if (limit === null || limit === undefined) return (stored) => stored === pad;
  const lo = Math.min(pad, limit);
  const hi = Math.max(pad, limit);
  return (stored) => stored >= lo && stored <= hi;
}

/**
 * Whether the pixel at `index` was measured at all, given the frame carrying it.
 *
 * TWO WAYS A PIXEL CAN BE NOT-TISSUE, and until an oblique plane existed there was only
 * one. (0028,0120) declares a VALUE the scanner writes where it measured nothing, which is
 * what `paddingTest` answers. A resampled plane has a second kind: a rectangle drawn around
 * a rotated volume has corners the acquisition never reached, and the sampler has to put
 * SOME number there.
 *
 * The only numbers available for that are the declared padding value, or -- when the series
 * declares none -- the volume's minimum. That minimum is real acquired air, so declaring it
 * as padding excluded genuine air from every ROI on the plane and reported it as excluded.
 * A mask says which samples fell outside and leaves every value meaning what it measured.
 *
 * Takes an INDEX rather than a value, because a mask is per pixel and a declaration is per
 * frame, and one function has to answer for both.
 */
export function notMeasuredAt(frame) {
  const isPad = paddingTest(frame);
  const pixels = frame && frame.pixels;
  const outside = frame && frame.outside;
  if (!outside) return (index) => isPad(pixels[index]);
  return (index) => outside[index] === 1 || isPad(pixels[index]);
}

export function paddingNote(value) {
  const n = value && value.excluded;
  return n ? ` · ${n} padding px excluded` : '';
}

/**
 * How to say that a value came off a projection rather than a slice, or '' when it did not.
 *
 * A MIP's pixel is the densest thing somewhere along a ray, so an ROI over it reports a
 * mean of maxima. The number is real and it is not a tissue density, and the difference is
 * invisible in the figure alone -- which is exactly when a surface has to say it in words.
 */
export function projectionNote(measurement) {
  const p = measurement && measurement.projection;
  // WHAT THE NUMBER IS, and nothing about the picture. The overlay caveat that rides on the
  // same record belongs to the panel showing the contour, not to a row in a list of
  // measurements -- a reader scanning values does not need to be told, once per row, which
  // slice a segmentation came from. `reslice` records both; each surface says its own.
  // ONE DECIMAL, the same as the HUD prints. A coronal slab of 27 0.7 mm steps is 18.9 mm;
  // rounded to whole millimetres here and not there, the panel says a measurement was taken
  // over 19 mm while the picture it was taken on says 18.9, and a reader comparing the two
  // has no way to tell which one moved.
  return p ? ` · ${p.mode} over ${p.mm.toFixed(1)} mm` : '';
}

/**
 * What an ROI that measured NOTHING says, or '' when it measured something.
 *
 * `regionStatistics` excludes (0028,0120) padding, which is right -- padding is not tissue.
 * An ROI drawn entirely inside the out-of-field corner of a reconstruction circle therefore
 * excludes every pixel it enclosed, and the running mean is never updated: it came back
 * `NaN` with an `NaN` spread, rendered as "NaN +/- NaN HU".
 *
 * `NaN` is what a program prints when it has lost track of a number. It is not a statement
 * about the region, and a reader seeing it has no way to tell a padding-only ROI from a
 * bug in the viewer. The sentence says which, and the pixel count makes it checkable.
 */
export function emptyRegionNote(value) {
  if (!value || value.count > 0) return '';
  const n = value.excluded || 0;
  return n
    ? `no measurement · all ${n} px enclosed were padding`
    : 'no measurement · the shape enclosed no pixels';
}

/**
 * What to say when a plane resolves less than it is drawn at, or '' when it does not.
 *
 * On the three named planes one step across the picture is one voxel, so the sample pitch
 * and the resolvable detail are the same number and this returns nothing. An oblique cuts
 * across the lattice and they come apart: on this project's phantom a 45 degree plane is
 * drawn on a 0.99 mm row grid and resolves 2.83 mm.
 *
 * NOTHING IN THE PICTURE CAN SHOW THAT. A reader measuring the phantom's nodule down the
 * rows of such a plane gets 7.9 mm and across the columns 7.0 mm, on a solid that is
 * symmetric in the plane -- the 0.9 mm is the coarser axis over-reporting the extent. The
 * discrepancy is reproducible with two calipers, and this sentence is what tells a reader
 * it is the plane and not the anatomy.
 *
 * Takes anything carrying both fields -- the frame for the HUD, the measurement record for
 * the panel -- so there is one sentence and not two.
 */
export function resolutionNote(source) {
  const pitch = source && source.pixelSpacing;
  const resolved = source && source.resolutionMm;
  if (!pitch || !resolved || pitch.length !== 2 || resolved.length !== 2) return '';

  const axes = [];
  if (resolved[0] > pitch[0] + 1e-6) {
    axes.push(`rows resolved at ${resolved[0].toFixed(2)} mm, drawn at ${pitch[0].toFixed(2)} mm`);
  }
  if (resolved[1] > pitch[1] + 1e-6) {
    axes.push(`columns resolved at ${resolved[1].toFixed(2)} mm, drawn at ${pitch[1].toFixed(2)} mm`);
  }
  return axes.length ? ` · ${axes.join(' · ')}` : '';
}

export function spreadWithUnit(mean, sd, unit, digits = 0) {
  const m = Number(mean).toFixed(digits);
  const s = Number(sd).toFixed(digits);
  return unit ? `${m} ± ${s} ${unit}` : `${m} ± ${s} · ${NO_UNIT}`;
}
