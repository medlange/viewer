/* =====================================================================================
 * The one mapping between a screen point and an image pixel.
 *
 * WHY THIS IS ITS OWN MODULE
 * ---------------------------
 * `viewport.render()` computes a physical-aspect fit -- the scale that makes a 0.7 x 0.9 mm
 * pixel display with its real proportions instead of square -- and then `readout()` inverts
 * that fit by hand to turn a mouse position back into a pixel index. Two copies of one
 * piece of arithmetic, and `readout()`'s own comment already said what that costs:
 *
 *     "Kept in step with it by hand, which is a seam worth a test: if the two ever disagree
 *      the reported HU is for a pixel the reader is not pointing at."
 *
 * That was written as a known risk and left. Adding measurements would have made it a third
 * copy -- and a caliper anchored one pixel off from where the reader clicked is a wrong
 * number that looks right, which is the failure mode this viewer keeps finding in itself.
 * So the fit is computed ONCE here and both directions come from the same numbers.
 *
 * THE FIT, STATED
 * ----------------
 * An image of `columns x rows` pixels with spacing `[rowMm, colMm]` occupies
 * `columns * colMm` by `rows * rowMm` millimetres. That PHYSICAL rectangle is fitted inside
 * the canvas preserving its aspect, then scaled by zoom and shifted by pan. Fitting the
 * PIXEL rectangle instead would stretch anisotropic data -- every shape on screen would be
 * wrong, and a measurement taken from it would inherit the error while the caliper looked
 * perfectly placed.
 *
 * Coordinates:
 *   IMAGE   `{x, y}` in pixels, x across columns, y down rows, origin top-left
 *   NDC     WebGL clip space, [-1, 1] both axes, y UP
 *   SCREEN  CSS pixels relative to the canvas's bounding rect, y DOWN
 *
 * Spec: MOS-IMG-039, MOS-IMG-041 (a measurement computed anywhere but the source array is a
 * defect), MOS-UI-009a (MOS-UI-009 withdrawn at specification 0.3.0).
 * ===================================================================================== */

/* -------------------------------------------------------------------------------------
 * ROTATE AND FLIP, as one 2x2 matrix that three consumers share.
 *
 * WHY A MATRIX AND NOT TWO BOOLEANS AND AN ANGLE
 * -----------------------------------------------
 * `flipH`, `flipV` and `rotate` interact: flipping horizontally and then rotating twice is
 * flipping vertically, and a viewer holding all three separately has to decide an order of
 * application and then apply that same order in every consumer. There are three consumers
 * here -- the vertex shader that draws the pixels, this module's hit-testing that turns a
 * click into a pixel, and the orientation markers that say which edge is the patient's
 * left. A composition rule written out three times is a composition rule that will
 * eventually be written differently in one of them, and the failure is invisible: the
 * picture, the caliper and the letters each look internally consistent.
 *
 * One matrix has no order to get wrong. Every operation is a multiplication onto what is
 * already there, and the consumers apply it rather than reconstruct it.
 *
 * WHY THE INVERSE IS THE TRANSPOSE
 * ---------------------------------
 * Every matrix reachable from `NO_TRANSFORM` by these operations is a product of rotations
 * and reflections, so it is orthogonal: its inverse IS its transpose, exactly, in integers,
 * with no division and no floating-point error. `screenToImage` and `imageToScreen` stay
 * exact inverses through any sequence of flips and rotations because of that, and a gate
 * below asserts the round trip rather than trusting the argument.
 * ----------------------------------------------------------------------------------- */

/**
 * Row-major [a, b, c, d] for [[a, b], [c, d]], mapping IMAGE-normalised coordinates to
 * SCREEN-normalised ones. +x is right and +y is up in both, which is NDC's convention and
 * not DICOM's -- the row order flip lives in the fragment shader, where it always did.
 */
export const NO_TRANSFORM = [1, 0, 0, 1];

/** `b` applied after `a`, which is the matrix product `b * a`. */
function compose(b, a) {
  return [
    b[0] * a[0] + b[1] * a[2], b[0] * a[1] + b[1] * a[3],
    b[2] * a[0] + b[3] * a[2], b[2] * a[1] + b[3] * a[3],
  ];
}

/**
 * A quarter turn clockwise ON SCREEN, whatever is already applied.
 *
 * What was at the top of the picture ends up at its right: M(0,1) = (1,0). The reader
 * pressed a button about what they can see, so the rotation composes onto the current
 * state rather than replacing it.
 */
export function rotatedRight(m) {
  return compose([0, 1, -1, 0], m);
}

/** A left-right mirror ON SCREEN, composed the same way. */
export function flippedHorizontally(m) {
  return compose([-1, 0, 0, 1], m);
}

/** A top-bottom mirror. Not `rotate twice then flip`, because that is a rule to get wrong. */
export function flippedVertically(m) {
  return compose([1, 0, 0, -1], m);
}

/** Image-normalised -> screen-normalised. */
function applyTransform(m, x, y) {
  return [m[0] * x + m[1] * y, m[2] * x + m[3] * y];
}

/**
 * Screen-normalised -> image-normalised.
 *
 * The transpose, for the reason argued in the block above. Written as a transpose rather
 * than as a general 2x2 inversion so that the orthogonality assumption is stated in the
 * code instead of being silently relied on by a division that would also "work".
 */
function unapplyTransform(m, x, y) {
  return [m[0] * x + m[2] * y, m[1] * x + m[3] * y];
}

/** Whether a transform is in effect at all, for a surface that has to say so. */
export function isTransformed(m) {
  return !(m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1);
}

/**
 * The view state every consumer needs, read off a viewport in ONE place.
 *
 * Three call sites used to build `{ zoom: vp.zoom, pan: vp.pan }` by hand -- the pointer
 * handler, the measurement tools and the annotation layer. Adding a third field to that
 * object meant editing three literals, and forgetting one would leave a caliper that lands
 * where the picture is not, or an annotation drawn at the pixel's unrotated position. The
 * object is built here so there is one literal to add to.
 */
export function viewOf(viewport) {
  return {
    zoom: viewport.zoom,
    pan: viewport.pan,
    transform: viewport.transform || NO_TRANSFORM,
  };
}

/**
 * The fit for one frame in one canvas, as the numbers both directions need.
 *
 * @param {{rows:number, columns:number, pixelSpacing:[number,number]}} frame
 * @param {{width:number, height:number}} canvas  CSS size, not backing-store size
 * @param {{zoom:number, pan:[number,number]}} view
 */
export function fitOf(frame, canvas, view) {
  // A DEGENERATE CANVAS HAS NO FIT, and saying so beats computing one. A pane that is
  // hidden, mid-layout or zero-height gives width/0 = Infinity, so sx collapses to 0 and
  // every later division yields NaN -- which sails past the `Math.abs(u) > 1` bounds check,
  // because NaN > 1 is false. The reader then sees "NaN HU   (NaN, NaN)" where they
  // expected a number. Observed in this very session with the browser pane collapsed, and
  // the inline arithmetic this module replaced had exactly the same hole.
  if (!(canvas.width > 0) || !(canvas.height > 0)) return null;
  const [rowMm, colMm] = frame.pixelSpacing || [1, 1];
  const m = view.transform || NO_TRANSFORM;

  // THE DISPLAYED EXTENT, not the stored one. A quarter turn puts the image's height along
  // the screen's width, so fitting the unfrotated rectangle would letterbox a portrait
  // study against the wrong axis and -- because the fit is what makes millimetres map to
  // screen distance by ONE uniform scale -- would stretch every shape on screen by the
  // aspect ratio. A caliper across a rotated frame would then return the wrong length,
  // which is the failure that makes rotation a correctness feature and not a convenience.
  //
  // Each row of these matrices has exactly one non-zero entry, so this is exact rather
  // than a bound.
  const storedW = frame.columns * colMm;
  const storedH = frame.rows * rowMm;
  const shownW = Math.abs(m[0]) * storedW + Math.abs(m[1]) * storedH;
  const shownH = Math.abs(m[2]) * storedW + Math.abs(m[3]) * storedH;

  const imageAspect = shownW / shownH;
  const canvasAspect = canvas.width / canvas.height;
  const [sx, sy] = imageAspect > canvasAspect
    ? [1, canvasAspect / imageAspect]
    : [imageAspect / canvasAspect, 1];
  return {
    sx: sx * view.zoom,
    sy: sy * view.zoom,
    px: view.pan[0],
    py: view.pan[1],
    rows: frame.rows,
    columns: frame.columns,
    transform: m,
    shownW,
    shownH,
  };
}

/**
 * Screen point -> image pixel. Fractional; the caller floors when it needs an index.
 *
 * Returns null when the point is outside the image, which is a different answer from
 * "pixel (0,0)" and must stay different: a caliper that clamped would silently anchor to a
 * corner the reader never clicked.
 */
export function screenToImage(frame, canvas, view, point) {
  const fit = fitOf(frame, canvas, view);
  if (!fit) return null;
  const ndcX = (point.x / canvas.width) * 2 - 1;
  const ndcY = 1 - (point.y / canvas.height) * 2;
  const sx = (ndcX - fit.px) / fit.sx;
  const sy = (ndcY - fit.py) / fit.sy;
  // Screen-normalised back to IMAGE-normalised before the bounds check, so that a click
  // outside a rotated image is rejected against the image's own rectangle rather than
  // against the screen-aligned box around it.
  const [u, v] = unapplyTransform(fit.transform, sx, sy);
  if (Math.abs(u) > 1 || Math.abs(v) > 1) return null;
  return {
    x: (u * 0.5 + 0.5) * fit.columns,
    y: (1 - (v * 0.5 + 0.5)) * fit.rows,
  };
}

/**
 * Image pixel -> screen point. The exact inverse of `screenToImage`, which is the whole
 * reason both live here: an annotation drawn with a second implementation would sit beside
 * the pixel its number was computed from rather than on it.
 */
export function imageToScreen(frame, canvas, view, pixel) {
  const fit = fitOf(frame, canvas, view);
  if (!fit) return null;
  const u = (pixel.x / fit.columns - 0.5) * 2;
  const v = ((1 - pixel.y / fit.rows) - 0.5) * 2;
  const [tu, tv] = applyTransform(fit.transform, u, v);
  const ndcX = tu * fit.sx + fit.px;
  const ndcY = tv * fit.sy + fit.py;
  return {
    x: ((ndcX + 1) / 2) * canvas.width,
    y: ((1 - ndcY) / 2) * canvas.height,
  };
}

/**
 * Millimetres per SCREEN pixel. ONE number, not two.
 *
 * The first version of this returned `{x, y}` with a comment claiming "anisotropic frames
 * have two answers, so both are returned rather than one averaged". A round-trip probe
 * disagreed: on a 3.0 x 0.98 mm coronal frame both components came back 0.74, identical.
 *
 * They must be. `fitOf` fits the PHYSICAL rectangle -- `columns * colMm` by `rows * rowMm`
 * -- preserving its aspect, so millimetres map to screen distance by ONE uniform scale in
 * both directions. That isotropy is the entire point of fitting physical rather than pixel
 * extent, and it is what makes a caliper drawn diagonally across an anisotropic frame the
 * right length. A function returning two numbers implied the fit stretched, which would
 * have meant every shape on screen was wrong.
 *
 * NOT EXPORTED. It was, on the strength of "a scale bar and a hit tolerance both need it",
 * and neither existed -- so for several commits it was a declaration nothing reached, which
 * is the shape `test_no_module_declares_a_dicom_tag_it_never_reads` gates for one directory
 * along. The scale bar below is its one caller now, in this same file. It becomes an export
 * again when something outside needs it, and not before.
 *
 * Corrected, separately, because a comment that describes behaviour the code does not have
 * is how the dtype check ended up unreachable in kserve_v2.
 */
function millimetresPerScreenPixel(frame, canvas, view) {
  const fit = fitOf(frame, canvas, view);
  if (!fit) return NaN;
  // FROM THE DISPLAYED EXTENT, so it stays true through a quarter turn: after one, the
  // screen's width carries the frame's HEIGHT, and `fit.columns * colMm` would be
  // measuring the wrong side of the picture.
  return fit.shownW / (fit.sx * canvas.width);
}

/* -------------------------------------------------------------------------------------
 * A SCALE BAR, and why it is the honest answer to "actual size".
 *
 * Readers want to know how big something is without drawing a caliper on it. There are two
 * ways a viewer can offer that, and only one of them is knowable in a browser.
 *
 *   ACTUAL SIZE -- one millimetre on the display is one millimetre in the patient. This
 *   needs the display's PHYSICAL size, and no browser reports it. `devicePixelRatio` is a
 *   ratio to the CSS pixel, and the CSS pixel is defined against a NOTIONAL 96 dpi, not a
 *   measured one. A 27-inch 4K panel and a 13-inch laptop can report the same numbers and
 *   differ by more than a factor of two. A viewer printing "actual size" from that is
 *   asserting a physical fact it has no source for -- and it would be believed, because the
 *   whole point of the control is that the reader stops using a caliper.
 *
 *   A SCALE BAR -- a drawn line labelled with the distance it spans. It needs nothing about
 *   the display: it is derived from the image geometry and the current zoom, and it stays
 *   true when the reader zooms, when the window is resized, and on a projector. RadiAnt
 *   solves the first problem by asking the user to calibrate their monitor against a real
 *   ruler; a scale bar is what remains correct when nobody has.
 *
 * So this viewer draws the bar and does not offer actual size. `millimetresPerScreenPixel`
 * was written for exactly this and had no caller until now -- the same declared-and-never-
 * read shape the tag-table gates exist for, one directory along.
 * ----------------------------------------------------------------------------------- */

/**
 * The lengths a scale bar is allowed to be.
 *
 * Round numbers in a 1-2-5 progression, which is what every map and every oscilloscope
 * uses, because the reader estimates by halving and doubling what the bar shows. A bar
 * labelled "37 mm" is arithmetically finer and useless for that.
 *
 * The range runs from a tenth of a millimetre -- reachable at diagnostic zoom on a
 * 0.3 mm mammography pixel -- to half a metre, which is a whole-body coronal fitted to a
 * panel.
 */
const NICE_MM = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];

/**
 * At most this much of the PICTURE's width, so the bar never competes with the anatomy.
 *
 * Of the picture and not of the panel: a wide, short pane fits the image by its height, so
 * the image can occupy a third of the panel's width with black either side. Measured
 * against the panel, a bar within its allowance came out at 64% of the anatomy -- longer
 * than the thorax it was sitting under.
 */
const MOST_OF_THE_WIDTH = 0.25;

/**
 * The longest round length that fits, and how wide it is on screen.
 *
 * Returns null when the geometry gives no answer -- a degenerate canvas, or a frame with no
 * pixel spacing. A bar drawn from a guess is worse than no bar, because a reader uses it to
 * size a finding they are about to put in a report.
 *
 * @returns {{mm:number, px:number}|null}
 */
export function scaleBarOf(frame, canvas, view) {
  // THE DOCSTRING ABOVE PROMISED THIS AND THE CODE DID NOT DO IT. `volume.js` substitutes
  // [1, 1] for an absent (0028,0030) so the fit has an aspect to work with, and every
  // millimetre derived from it is a pixel count wearing a unit. On a 2048-column CR whose
  // real detector pitch is 0.143 mm, the bar came out labelled in hundreds of millimetres
  // across a span of tens -- wrong by a factor of seven, drawn on every frame, and
  // indistinguishable from a bar derived from a stated spacing.
  if (frame && frame.hasPixelSpacing === false) return null;

  const fit = fitOf(frame, canvas, view);
  const mmPerPx = millimetresPerScreenPixel(frame, canvas, view);
  if (!fit || !Number.isFinite(mmPerPx) || mmPerPx <= 0) return null;

  // Zoomed in, the picture is wider than the panel and the panel is what the reader can
  // see; zoomed out, the picture is narrower and the picture is what the bar sits under.
  // The smaller of the two is the one the bar has to stay inside.
  const visible = Math.min(fit.sx * canvas.width, canvas.width);
  const widest = visible * MOST_OF_THE_WIDTH * mmPerPx;
  // The largest round length that still fits. At extreme zoom even the smallest is wider
  // than the allowance, and showing it anyway beats showing nothing -- the bar is still
  // correct, it is simply long.
  let mm = NICE_MM[0];
  for (const candidate of NICE_MM) {
    if (candidate <= widest) mm = candidate;
  }
  return { mm, px: mm / mmPerPx };
}

/**
 * The zoom at which one image pixel covers one DEVICE pixel, or null when that is not a
 * thing this frame can do.
 *
 * WHY THIS REFUSES ANISOTROPIC FRAMES
 * ------------------------------------
 * `fitOf` fits the PHYSICAL rectangle, so millimetres map to screen distance by one uniform
 * scale in both directions -- that isotropy is what makes a caliper drawn diagonally the
 * right length, and it is the reason the fit is written the way it is.
 *
 * On a frame whose pixels are square, one image pixel per device pixel is consistent with
 * that: both directions reach 1:1 together. On a reconstructed coronal of 0.70 x 2.00 mm
 * they cannot. Getting the columns to 1:1 leaves the rows at 2.9:1, and forcing both would
 * mean abandoning the physical fit -- which would stretch every shape on screen and make
 * every caliper wrong, to satisfy a button.
 *
 * So the control is refused on those frames and says why, the way the plane buttons refuse
 * a series with uneven spacing. A "1:1" that silently meant "1:1 across, 2.9:1 down" would
 * be a label the picture cannot contradict.
 *
 * @param {{width:number, height:number}} device  the DRAWING BUFFER size, not the CSS size
 */
export function zoomForOneToOne(frame, canvas, device, view) {
  const [rowMm, colMm] = frame.pixelSpacing || [1, 1];
  // An unstated spacing is substituted as square, so the anisotropy test below would pass
  // on a frame nobody measured. 1:1 is a claim about PIXELS rather than millimetres and is
  // still meaningful here -- but the fit it is derived from is not, so the honest answer is
  // that this frame has no 1:1 to offer either.
  if (frame.hasPixelSpacing === false) return null;
  if (Math.abs(rowMm - colMm) > 1e-6) return null;

  const fit = fitOf(frame, canvas, { ...view, zoom: 1 });
  if (!fit) return null;

  // How many IMAGE pixels lie along the screen's x axis. After a quarter turn that is the
  // frame's row count, not its column count -- the same displayed-extent question the fit
  // itself asks, answered from the same matrix.
  const m = fit.transform;
  const across = Math.abs(m[0]) * frame.columns + Math.abs(m[1]) * frame.rows;

  // The image spans `2 * fit.sx` of a 2-wide NDC, so it covers `fit.sx` of the buffer.
  const covered = fit.sx * device.width;
  if (!(covered > 0)) return null;
  return across / covered;
}


/**
 * A pointer event as an image pixel, or null when it is off the image.
 *
 * HERE RATHER THAN IN THE TOOLS. It was a private function in `measure-tools.js`, which
 * was the only caller until the shell needed to drag a handle -- and the shell importing
 * from a tools module to get a coordinate conversion would have the dependency pointing
 * the wrong way. It belongs beside `screenToImage`, which is the arithmetic it wraps; what
 * it adds is reading the panel's live rect, so a caller cannot use a stale one.
 */
export function pixelAt(panel, event) {
  if (!panel || !panel.frame || !panel.canvas) return null;
  const rect = panel.canvas.getBoundingClientRect();
  return screenToImage(
    panel.frame,
    { width: rect.width, height: rect.height },
    viewOf(panel.viewport),
    { x: event.clientX - rect.left, y: event.clientY - rect.top },
  );
}
