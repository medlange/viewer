/* =====================================================================================
 * The annotation layer: measurements drawn over the image, in SVG.
 *
 * WHY SVG AND NOT A SECOND GL CONTEXT OR A CANVAS2D
 * ---------------------------------------------------
 * A caliper needs text beside it, and text is the thing WebGL is worst at -- a glyph atlas
 * is a dependency, and `canvas2d.fillText` on a second stacked canvas costs another
 * backing store per viewport. SVG gives crisp text at any device pixel ratio, scales with
 * the page, and -- the reason that matters most here -- it is in the DOM, so a test can
 * assert that a 30 mm caliper drew a label reading "30.0 mm" without rendering a pixel.
 * `docs/adr/BUILD_VS_ADOPT.md` records that the rendering-correctness harness is owed; a
 * layer whose output is inspectable is a layer that harness can actually check.
 *
 * EVERY COORDINATE COMES FROM `transform.js`
 * --------------------------------------------
 * `imageToScreen` is the exact inverse of the `screenToImage` the HU readout uses --
 * round-tripped to 1.4e-13 over 96 frame/canvas/zoom/pan combinations. That is not a
 * nicety: a caliper drawn with its own arithmetic would sit BESIDE the pixels its number
 * was computed from, and the number would be right while the line was wrong. Nothing in
 * this file derives a position any other way.
 *
 * THE LABEL IS THE MEASUREMENT, NOT A ROUNDING OF IT
 * ----------------------------------------------------
 * Values are formatted for display here and nowhere else, and the underlying measurement
 * keeps full precision in state. A panel that re-parsed "30.0 mm" back into a number would
 * be measuring the label.
 *
 * WHAT THIS LAYER MUST NOT BECOME
 * ---------------------------------
 * `MOS-UI-204` and `MOS-UI-010`: no contour drawing, no scribble, no mask editing. A
 * measurement is a line or an ellipse whose VALUE is a number; the moment a shape here
 * starts producing a label map it is an annotation authoring tool and is forbidden. The
 * distinction is not the shape -- it is what comes out.
 *
 * Spec: MOS-IMG-039, MOS-IMG-041, MOS-UI-010, MOS-UI-204, MOS-SAFE-001 (the RUO statement
 * travels with a number that leaves the footer behind).
 * ===================================================================================== */

import { imageToScreen } from './transform.js';
import {
  angleText, areaText, distanceText, emptyRegionNote, paddingNote, projectionNote,
  resolutionNote, spreadWithUnit,
} from '../image/units.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Display formatting, in one place. The stored measurement keeps full precision. */
export function formatValue(measurement) {
  const v = measurement.value;
  if (measurement.kind === 'length') {
    return distanceText(v.mm, v.px, measurement.spacingStated)
      + projectionNote(measurement) + resolutionNote(measurement);
  }
  if (measurement.kind === 'angle') {
    // A PARTIAL ANGLE HAS NO VALUE. The tool places three points across three clicks
    // and previews the shape after the first two; `angle()` needs all three, so until
    // then there is a ray on screen and no number beside it. Rendering `NaN°`
    // there would say the measurement failed rather than that it is unfinished.
    return typeof v === 'number' ? angleText(v, measurement.spacingStated) : '';
  }
  if (measurement.kind === 'note') {
    // THE NOTE IS ITS OWN VALUE. There is no number to format and none to invent; an
    // empty one is a note the reader has not finished typing, and renders as nothing
    // rather than as a caption saying so.
    return String(measurement.text || '');
  }
  if (measurement.kind === 'roi') {
    // Mean and SD together, because a mean without a spread invites the reader to treat a
    // heterogeneous region as a homogeneous one -- which is the whole difference between
    // "this nodule is -600 HU" and "this nodule spans air and soft tissue".
    // The unit comes from the measurement, which recorded it from the frame it was taken
    // on. This line used to say "HU" unconditionally, on every modality the viewer opens.
    if (emptyRegionNote(v)) return emptyRegionNote(v);
    return `${spreadWithUnit(v.mean, v.sd, measurement.valueUnit)}  ·  ${areaText(v.areaMm2, v.areaPx, measurement.spacingStated)}${paddingNote(v)}${projectionNote(measurement)}`;
  }
  return '';
}

function el(name, attrs) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

export class AnnotationLayer {
  /**
   * @param {HTMLElement} host  the panel element; the layer is positioned over its canvas
   */
  constructor(host) {
    this.svg = el('svg', { class: 'annot' });
    // `pointer-events: none` on the layer: measurements are CREATED by the tool over the
    // canvas, and a layer that swallowed pointer events would break window/level the
    // moment one existed -- MOS-UI-207 requires the default bindings be live "the moment
    // the case opens, without the reader selecting a mode".
    this.svg.style.pointerEvents = 'none';
    host.appendChild(this.svg);
  }

  /**
   * Draw `measurements` plus an optional in-progress `preview`.
   *
   * Measurements not on the current slice are SKIPPED, not dimmed: a caliper from slice 40
   * shown on slice 41 is drawn across anatomy it did not measure, and a faded version of a
   * wrong thing is still a wrong thing.
   */
  /** Remove every drawn element. A layer with nothing to show shows nothing. */
  clear() {
    while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);
  }

  render(measurements, preview, frame, canvasSize, view, location, references = [],
         selected = null, crosshair = null) {
    this.clear();
    if (!frame || !canvasSize.width || !canvasSize.height) return;
    // KEPT SO `#label` CAN CLAMP TO IT. The layer is already handed the panel's extent;
    // without holding on to it, a label had nothing to measure itself against.
    this.size = canvasSize;

    this.svg.setAttribute('viewBox', `0 0 ${canvasSize.width} ${canvasSize.height}`);

    const toScreen = (pixel) => imageToScreen(frame, canvasSize, view, pixel);
    // A measurement recorded before this field existed has `seriesUID` undefined; it is
    // shown wherever it matches on plane and index, as it always was, rather than
    // vanishing from the panel it was taken on.
    const onThisSlice = (m) => m.plane === location.plane
      && m.sliceIndex === location.index
      && (m.seriesUID == null || m.seriesUID === location.seriesUID);

    // REFERENCE LINES GO UNDER THE MEASUREMENTS. A caliper is the reader's own assertion
    // and a reference line is the geometry's; when they cross, the one the reader drew is
    // the one they need to see unobscured.
    for (const ref of references) this.#reference(ref, toScreen);
    // UNDER THE MEASUREMENTS AND OVER THE REFERENCE LINES. A reference line says where
    // another panel's PLANE cuts this one; the crosshair says where the POINT is on that
    // line. The reader's own marks stay on top of both.
    if (crosshair) this.#crosshair(crosshair, toScreen, canvasSize);

    for (const m of measurements.filter(onThisSlice)) this.#draw(m, toScreen, false, m.id === selected);
    // THE PREVIEW IS FILTERED TOO, by the same predicate. It did not used to be, and that
    // is what made the angle tool's arm-time address invisible: the half-placed shape
    // followed the reader to whatever slice they scrolled to, so they aimed the vertex at
    // anatomy the measurement was not going to be filed against. `app.js` now discards
    // partial state whenever the slice, the plane or the active panel moves, which means
    // this filter should never reject anything -- and that is exactly why it is worth
    // stating: an invariant nothing checks is an invariant that stops holding quietly.
    if (preview && onThisSlice(preview)) this.#draw(preview, toScreen, true);
  }

  /**
   * One plane's intersection with this one, plus which plane it is.
   *
   * Dashed and thin on purpose: it is a locator, not a finding, and a solid line of the
   * same weight as a caliper would read as a measurement someone made.
   */
  /**
   * The cursor, as a cross on this picture.
   *
   * THREE STATES, AND THE THIRD IS THE POINT. A point off this plane still projects onto
   * it, so a crosshair drawn from the projection alone looks identical whether the reader
   * is looking at the point or forty millimetres behind it. On-plane is a solid cross;
   * off-plane is dashed with the distance beside it. OHIF's crosshair has no third state.
   *
   * Absence is DRAWN, not skipped: a crosshair that is simply missing looks the same as a
   * viewer that has not got round to drawing one.
   */
  #crosshair(cross, toScreen, canvasSize) {
    if (cross.absent) {
      // ABOVE THE BAND THE BADGE AND THE SCALE BAR ALREADY OWN.
      //
      // This sat at `height - 34`, which is inside both of them. Measured on a 2x2 of a
      // real MR study: 99x15 px of it over the `not linked` badge -- the badge's whole
      // width -- 35x12 over the `50 mm` scale bar, and 10x2 over the `P` orientation
      // letter. The badge is `bottom: 30px` and 28px tall, so it owns `height-58` to
      // `height-30`; the scale bar owns `height-61` to `height-34`. A baseline at
      // `height - 66` is above both and touches neither.
      const node = el('text', { class: 'annot-cross-absent', x: 10, y: canvasSize.height - 66 });
      node.textContent = `no crosshair: ${cross.absent}`;
      this.svg.appendChild(node);
      // AND IT STAYS ON THE PICTURE IT IS DRAWN ON. An SVG <text> neither wraps nor clips:
      // 355px of sentence on a 491px panel is close, and the same sentence on a 2x2 at
      // 1200px runs off the panel and over its neighbour. Trimmed to what the panel has,
      // with the ellipsis saying that it was.
      const room = Math.max(60, canvasSize.width - 20);
      if (node.getComputedTextLength() > room) {
        let text = node.textContent;
        while (text.length > 14 && node.getComputedTextLength() > room) {
          text = text.slice(0, -2);
          node.textContent = `${text}\u2026`;
        }
      }
      return;
    }
    const at = toScreen({ x: cross.x, y: cross.y });
    if (!at) return;

    const cls = cross.onPlane ? 'annot-cross' : 'annot-cross annot-cross-off';
    const gap = 7;
    const arm = 16;
    for (const [x1, y1, x2, y2] of [
      [at.x - arm - gap, at.y, at.x - gap, at.y],
      [at.x + gap, at.y, at.x + arm + gap, at.y],
      [at.x, at.y - arm - gap, at.x, at.y - gap],
      [at.x, at.y + gap, at.x, at.y + arm + gap],
    ]) {
      this.svg.appendChild(el('line', { class: cls, x1, y1, x2, y2 }));
    }

    if (!cross.onPlane) {
      // HOW FAR OFF, in the unit the reader measures in. A cross that is merely styled
      // differently says "not here" and not "how far"; the number is what lets them decide
      // whether to scroll to it.
      const node = el('text', { class: 'annot-cross-label', x: at.x + arm + 12, y: at.y - 6 });
      node.textContent = `${Math.abs(cross.offMm).toFixed(1)} mm off this plane`;
      this.svg.appendChild(node);
    }
  }

  #reference(ref, toScreen) {
    const from = toScreen(ref.from);
    const to = toScreen(ref.to);
    if (!from || !to) return;
    this.svg.appendChild(el('line', {
      class: 'annot-reference', x1: from.x, y1: from.y, x2: to.x, y2: to.y,
    }));
    if (!ref.label) return;
    const node = el('text', {
      class: 'annot-reference-label',
      x: Math.min(from.x, to.x) + 6,
      y: (from.y + to.y) / 2 - 5,
    });
    node.textContent = ref.label;
    this.svg.appendChild(node);
  }

  #draw(m, toScreen, isPreview, isSelected = false) {
    let cls = isPreview ? 'annot-shape annot-preview' : 'annot-shape';
    if (isSelected) cls += ' annot-selected';
    // A PREVIEW IS NOT YET A THING TO GRAB. It belongs to a gesture in progress and has no
    // id, so tagging it would give the hit-test a target that cannot be selected.
    const own = isPreview ? {} : { 'data-m': m.id };
    const label = formatValue(m);

    if (m.kind === 'note') {
      const at = toScreen((m.points || [])[0]);
      if (!at) return;
      // A MARKER, so an empty or not-yet-typed note is still a thing on the image
      // that can be selected and deleted. A note that drew nothing until it had text
      // would be unreachable in exactly the state a reader most wants to reach it.
      this.svg.appendChild(el('circle', {
        class: isSelected ? 'annot-handle annot-handle-on' : 'annot-handle',
        ...own, 'data-h': '0', cx: at.x, cy: at.y, r: isSelected ? 5 : 3.5,
      }));
      // OFFSET, so the text does not sit on the anatomy it points at. The leader is
      // what ties them together, and it is drawn rather than implied because at a
      // glance a floating string belongs to whatever is nearest.
      const tx = at.x + 14;
      const ty = at.y - 12;
      this.svg.appendChild(el('line', {
        class: cls, ...own, x1: at.x, y1: at.y, x2: tx - 2, y2: ty + 3,
      }));
      // A LEGEND ON THE IMAGE, NOT A PARAGRAPH.
      //
      // `#label` flips a label that runs off the right edge to the other side, which is
      // the right answer for a measurement's value -- those are short. A note is the
      // reader's own prose and has no length limit, so flipping only moves the overflow:
      // a long note crossed the whole frame, over the anatomy it was written about.
      //
      // Truncated HERE and nowhere else: the panel shows the note whole, its cell wraps,
      // and its tooltip carries the full text. Nothing is lost -- the image simply stops
      // being where a paragraph is read.
      const LEGEND = 36;
      const short = label && label.length > LEGEND
        ? `${label.slice(0, LEGEND - 1).trimEnd()}…`
        : label;
      this.#label(short, { x: tx, y: ty }, isPreview);
      return;
    }

    if (m.kind === 'length' || m.kind === 'angle') {
      const points = m.points.map(toScreen).filter(Boolean);
      if (points.length < 2) return;
      for (let i = 0; i < points.length - 1; i++) {
        this.svg.appendChild(el('line', {
          class: cls, ...own, x1: points[i].x, y1: points[i].y,
          x2: points[i + 1].x, y2: points[i + 1].y,
        }));
      }
      // THE HANDLES WERE DECORATION. Three-pixel circles on a layer with
      // `pointer-events: none`, so the one affordance that says "this can be moved" could
      // not be moved. They now carry which measurement and which point they are, and grow
      // when the measurement is selected -- a 3px target is under half what WCAG 2.2
      // SC 2.5.8 asks for and well under what a hand on a mouse can hit.
      points.forEach((p, i) => {
        this.svg.appendChild(el('circle', {
          class: isSelected ? 'annot-handle annot-handle-on' : 'annot-handle',
          ...own, 'data-h': String(i),
          cx: p.x, cy: p.y, r: isSelected ? 5 : 3.5,
        }));
      });
      this.#label(label, points[points.length - 1], isPreview);
      return;
    }

    // A FREEHAND REGION IS A PATH, AND IT HAS NO BOX. The branch below reads
    // `m.box.x0` on its first line, so a polygon reaching it throws inside the render
    // loop and takes every later annotation on the panel down with it.
    if (m.kind === 'roi' && m.shape === 'polygon') {
      const pts = (m.points || []).map(toScreen).filter(Boolean);
      if (pts.length < 3) return;
      this.svg.appendChild(el('polygon', {
        class: cls, ...own,
        points: pts.map((p) => `${p.x},${p.y}`).join(' '),
      }));
      // NO PER-VERTEX HANDLES. A traced outline has hundreds of them; drawing a grab
      // target on each would cover the anatomy it encloses and give the hit-test a
      // hundred overlapping targets a hand cannot choose between. A freehand region is
      // moved and deleted as a whole, and retraced when it is wrong.
      const top = pts.reduce((b, p) => (p.y < b.y ? p : b), pts[0]);
      this.#label(label, { x: top.x, y: top.y }, isPreview);
      return;
    }

    if (m.kind === 'roi') {
      const a = toScreen({ x: m.box.x0, y: m.box.y0 });
      const b = toScreen({ x: m.box.x1, y: m.box.y1 });
      if (!a || !b) return;
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      // THE SHAPE DRAWN IS THE SHAPE MEASURED. `regionStatistics` samples a rectangle's
      // corners and an ellipse's does not, so drawing one while measuring the other would
      // put a number beside a region that did not produce it.
      if (m.shape === 'rectangle') {
        this.svg.appendChild(el('rect', {
          class: cls, ...own,
          x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
          width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y),
        }));
      } else {
        this.svg.appendChild(el('ellipse', {
          class: cls, ...own, cx, cy,
          rx: Math.abs(b.x - a.x) / 2, ry: Math.abs(b.y - a.y) / 2,
        }));
      }
      // An ROI is dragged by its corners, which is where the reader already expects to
      // find them from every other rectangle they have ever resized.
      if (!isPreview) {
        [[a, '0'], [b, '1']].forEach(([corner, idx]) => {
          this.svg.appendChild(el('circle', {
            class: isSelected ? 'annot-handle annot-handle-on' : 'annot-handle',
            ...own, 'data-h': idx,
            cx: corner.x, cy: corner.y, r: isSelected ? 5 : 3.5,
          }));
        });
      }
      this.#label(label, { x: Math.max(a.x, b.x), y: Math.min(a.y, b.y) }, isPreview);
    }
  }

  /**
   * Place a label beside its measurement, INSIDE the panel.
   *
   * Every label was offset `+8, -6` unconditionally, and for an ROI the anchor is its
   * TOP-RIGHT corner -- so a region drawn in the right third of a half-width panel, which
   * is where the anatomy is rather than where the layout is convenient, had most of
   * `-612 ± 138 HU · 4.20 cm²` clipped by the viewBox. A measurement whose value is
   * off-screen is not a measurement.
   *
   * CLAMPED AFTER THE TEXT IS IN THE DOM, so the real advance width is used. Estimating it
   * from character count clips the long ROI lines and shoves the short ones off the shape
   * they belong to -- and the text is the reader's own label, so its width is not
   * predictable.
   */
  #label(text, at, isPreview) {
    if (!text || !at) return;
    const node = el('text', {
      class: isPreview ? 'annot-label annot-preview' : 'annot-label',
      x: at.x + 8, y: at.y - 6,
    });
    node.textContent = text;
    this.svg.appendChild(node);

    const extent = this.size;
    if (!extent || !extent.width || !extent.height) return;
    let box;
    try {
      box = node.getBBox();
    } catch {
      // getBBox throws on a node that is not rendered yet in some engines; an unclamped
      // label is what the reader had before, so leaving it is the honest fallback.
      return;
    }
    const PAD = 4;
    // FLIP TO THE OTHER SIDE rather than merely nudging: a label pushed left until it fits
    // would sit ON its own shape, and a caliper you cannot see is worse than one whose
    // label sits to its left.
    if (box.x + box.width > extent.width - PAD) {
      node.setAttribute('x', String(Math.max(PAD, at.x - 8 - box.width)));
    }
    if (box.y < PAD) node.setAttribute('y', String(at.y + box.height + 6));
    // AND OFF THE BOTTOM, by however much it actually overflows. `y` on an SVG <text> is
    // the BASELINE, not the top of the box, so the correction is a delta applied to the
    // attribute rather than an absolute position computed from the box.
    const after = node.getBBox();
    const overflow = (after.y + after.height) - (extent.height - PAD);
    if (overflow > 0) {
      node.setAttribute('y', String(Number(node.getAttribute('y')) - overflow));
    }
  }

  destroy() {
    this.svg.remove();
  }
}
