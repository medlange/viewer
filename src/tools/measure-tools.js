/* =====================================================================================
 * The measurement tools: a caliper, an angle, and an elliptical and a rectangular ROI.
 *
 * The count belongs in this line because it is the first thing read about the file,
 * and it said "a caliper and an elliptical ROI" while four tools were registered below.
 *
 * THE CONSTRAINT THAT SHAPES THIS FILE
 * --------------------------------------
 * `MOS-UI-207`: the default mouse bindings -- left window/level, middle pan, right zoom,
 * wheel through the stack -- "MUST be active the moment the case opens, without the reader
 * selecting a mode, choosing a tool or opening a menu. A surface on which window/level is a
 * tool the reader must first pick is a surface in which the single most frequent action in
 * thoracic reading costs two clicks, and the reader will notice within the first case."
 *
 * So a measurement tool is NOT a mode the viewer sits in. Selecting one arms it for ONE
 * measurement; on completion the surface returns to navigation by itself. That is RadiAnt's
 * behaviour and it is what keeps the default bindings the default. Escape disarms without
 * measuring. Middle and right drag keep working while a tool is armed, because pan and zoom
 * are how a reader positions the thing they are about to measure.
 *
 * WHAT A TOOL PRODUCES
 * ---------------------
 * A number, and the provenance to say what it is a number OF -- plane, slice index, source
 * SOP instance UID, the pixel spacing used. Never a label map. `MOS-UI-204` and
 * `MOS-UI-010` forbid contour drawing, scribble and mask editing; the distinction is not
 * the shape a reader drags but what comes out of it, and what comes out of these is a
 * scalar computed by `image/measure.js` from the stored array.
 *
 * THE ANCHOR IS A PIXEL, NOT A POINT ON SCREEN
 * ----------------------------------------------
 * Every drag endpoint is converted through `transform.screenToImage` at the moment it is
 * captured, so a measurement survives a zoom, a pan and a window change unchanged -- it is
 * attached to the image, not to the viewport. A tool that stored screen coordinates would
 * produce a caliper that slid across the anatomy when the reader zoomed, and whose number
 * stayed the same while the line moved.
 *
 * Spec: MOS-UI-207, MOS-UI-204, MOS-UI-010, MOS-IMG-039, MOS-IMG-041.
 * ===================================================================================== */

import {
  angle, describeMeasurement, length, polygonStatistics, regionStatistics,
} from '../image/measure.js';
import { KINDS, register } from '../core/registry.js';
import { pixelAt } from '../render/transform.js';

/**
 * A drag-defined measurement: press, drag, release.
 *
 * Shared by both tools because the INTERACTION is identical and only the arithmetic at the
 * end differs. Writing it twice would be two places for the anchor handling to drift, and
 * the symptom of drift here is a measurement anchored somewhere the reader did not press.
 */
function dragTool({ id, title, icon, key, kind, order, compute, describe }) {
  return register({
    id,
    kind: KINDS.TOOL,
    title,
    // Carried through the factory. It was destructured away here, so the two tools
    // built by `dragTool` declared a glyph and shipped without one -- a field set at
    // the call site and dropped in the callee, which reads as a typo at neither end.
    icon,
    key,
    // A THIRD KIND NEEDED A THIRD ORDER. `kind === 'length' ? 10 : 20` gave every tool
    // that was not a caliper the same position, so the second ROI tool's place in the
    // toolbar depended on which happened to register first.
    order: order ?? (kind === 'length' ? 10 : 20),

    /**
     * @returns {{onDown, onMove, onUp, onCancel}} handlers the shell installs while armed
     */
    handlers(panel, location, commit, setPreview) {
      let anchor = null;

      return {
        onDown(event) {
          if (event.button !== 0) return false;      // middle and right stay pan and zoom
          anchor = pixelAt(panel, event);
          return anchor !== null;
        },

        onMove(event) {
          if (!anchor) return false;
          const now = pixelAt(panel, event);
          if (!now) return true;                      // dragged off the image: keep the anchor
          setPreview(describe(panel.frame, anchor, now, location, true));
          return true;
        },

        onUp(event) {
          if (!anchor) return false;
          const end = pixelAt(panel, event);
          setPreview(null);
          const start = anchor;
          anchor = null;
          if (!end) return true;
          // A DEGENERATE DRAG IS NOT A MEASUREMENT. A click with no movement would produce
          // a 0.0 mm caliper or a zero-pixel ROI whose mean is NaN, and a panel row reading
          // "NaN HU" is worse than no row: it looks like a measurement that failed rather
          // than one that was never made.
          if (Math.abs(end.x - start.x) < 1 && Math.abs(end.y - start.y) < 1) return true;
          commit(describe(panel.frame, start, end, location, false));
          return true;
        },

        onCancel() {
          anchor = null;
          setPreview(null);
        },
      };
    },

    compute,
  });
}

/** Length: the caliper. Millimetres, from the frame's own spacing. */
export const lengthTool = dragTool({
  id: 'medos.length',
  title: 'Length',
  // The glyph this tool wears in the header toolbar, named from `src/ui/icons.js`.
  // DECLARED HERE, beside the tool, so a contribution carries its own presentation
  // and the shell does not grow a table of ids it has to be kept in step with.
  icon: 'length',
  key: 'm',
  kind: 'length',
  compute: length,
  describe(frame, a, b, location, isPreview) {
    const value = length(frame, a, b);
    const m = describeMeasurement('length', frame, location, value);
    return { ...m, kind: 'length', points: [a, b], preview: isPreview };
  },
});

/** Elliptical ROI with HU statistics -- the tool MOS-UI-200's table names by example. */
export const ellipseTool = dragTool({
  id: 'medos.roi-ellipse',
  title: 'ROI',
  // The glyph this tool wears in the header toolbar, named from `src/ui/icons.js`.
  // DECLARED HERE, beside the tool, so a contribution carries its own presentation
  // and the shell does not grow a table of ids it has to be kept in step with.
  icon: 'roi',
  key: 'r',
  kind: 'roi',
  compute: regionStatistics,
  describe(frame, a, b, location, isPreview) {
    const box = { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
    const value = regionStatistics(frame, box, 'ellipse');
    const m = describeMeasurement('roi', frame, location, value);
    // THE SHAPE IS RECORDED, not assumed. `remeasure` reads `m.shape` when the reader
    // drags a corner, and a record that did not carry it would silently become an ellipse
    // the first time it was edited.
    return { ...m, kind: 'roi', shape: 'ellipse', box, preview: isPreview };
  },
});

/**
 * One freehand record, built from the vertices traced so far.
 *
 * Separate from the tool because the tool builds one on every throttled preview and
 * once more on release, and a second copy of the field list is a second place for the
 * shape tag to go missing -- which is exactly the defect `remeasure` had.
 */
function describeFreehand(frame, pts, location, value, isPreview) {
  const points = pts.map((p) => ({ x: p.x, y: p.y }));
  const m = describeMeasurement('roi', frame, location, value);
  return { ...m, kind: 'roi', shape: 'polygon', points, preview: isPreview };
}

/**
 * Text note: a reader-typed string anchored to a point in the image.
 *
 * WHY THIS IS PERMITTED. `MOS-UI-010a` clause 5 (specification 0.3.0): a typed string
 * MAY be anchored to an image coordinate and MAY carry a leader line; it MUST NOT be
 * rasterised into the pixels, MUST NOT be burned into an export except as an overlay
 * drawn at export time, and MUST carry `clinical_use: research_only`. All three are
 * properties of how it is STORED and DRAWN, not of the gesture: the note lives on the
 * measurement list as text and a point, the annotation layer draws it into SVG above
 * the canvas, and `describeMeasurement` stamps the marking on every record it builds.
 *
 * IT IS NOT AN ANNOTATION IN THE `AnnotationSet` SENSE and cannot become one. There is
 * no region, no mask and no segment -- a string and an (x, y). `MOS-CORE-045` forbids
 * building a tool that PRODUCES an `AnnotationSet`, and a sentence cannot be trained on.
 *
 * THE TEXT IS NOT TYPED HERE. The tool places the anchor and commits a note with an
 * empty string; the shell opens an inline editor over the canvas, because the tool
 * module owns no DOM and should not start. `app.js` already owns the canvas and
 * already has this exact editor for naming a measurement.
 */
export const noteTool = register({
  id: 'medos.note',
  kind: KINDS.TOOL,
  title: 'Text note',
  hint: 'write on the image: click to place it, type, Enter',
  icon: 'note',
  key: 't',
  order: 40,
  handlers(panel, location, commit) {
    return {
      onDown(event) {
        if (event.button !== 0) return false;
        const at = pixelAt(panel, event);
        if (!at) return false;
        // A NOTE IS PLACED ON PRESS, not on release. There is nothing to drag, and
        // waiting for the release would mean a reader who moved the mouse a pixel
        // between press and release got nothing.
        const m = describeMeasurement('note', panel.frame, location, null);
        commit({ ...m, kind: 'note', points: [{ x: at.x, y: at.y }], text: '' });
        return true;
      },
      onMove() { return false; },
      onUp() { return true; },
      onCancel() { /* nothing is held between press and release */ },
    };
  },
});

/**
 * Freehand ROI: trace a closed region and measure the pixels inside it.
 *
 * WHY THIS IS A MEASUREMENT AND NOT A DRAWING TOOL, which is a question this file is
 * obliged to answer rather than assume. `MOS-CORE-045` forbids BUILDING an annotation
 * authoring tool and `MOS-UI-010` names contour-drawing in its ban. At specification
 * 0.3.0 `MOS-UI-010a` bounds both on the OUTPUT -- the spec's own `MOS-UI-200` already
 * says "An ROI-and-measurement toolset cannot produce a label map, so the tool cannot
 * be the producer of an `AnnotationSet`" -- and lists five clauses. This tool satisfies
 * them by construction: `polygonStatistics` can return nothing but counts and moments,
 * the vertices exist so a dragged shape can be re-measured and are never exported as a
 * contour, there is no SEG writer, no brush and no eraser anywhere in the module, and
 * every record carries `clinical_use: research_only` from `describeMeasurement`.
 *
 * IT DOES NOT FIT `dragTool`, which passes two points to `describe`. A trace is a
 * PATH -- the whole content of the gesture is the points in between, which two corners
 * cannot carry. The interaction is the same press/drag/release, so the handler protocol
 * is identical; only what is accumulated differs.
 *
 * THE STATISTICS ARE THROTTLED WHILE TRACING, and this is not premature. A point-in-
 * polygon test runs over the bounding box once per vertex: a 100x100 px region with 150
 * vertices is 1.5 million operations, and at pointer-move rate that is the frame budget
 * several times over. Recomputing every eighth vertex -- about 12 px of travel -- keeps
 * the number live to the eye and the trace smooth under the hand. The release always
 * computes, so the committed number is never a throttled one.
 */
export const freehandTool = register({
  id: 'medos.roi-freehand',
  kind: KINDS.TOOL,
  title: 'Freehand ROI',
  hint: 'the pen: trace a region by hand and it is MEASURED, not drawn. To write on the image, use the text note.',
  icon: 'roiFree',
  key: 'd',
  order: 28,
  handlers(panel, location, commit, setPreview) {
    let pts = null;
    let value = null;
    let since = 0;

    // VERTICES ARE DECIMATED AT THE SOURCE. A pointer at 120 Hz over a slow hand emits
    // dozens of events within one pixel; keeping them all would put thousands of
    // coincident vertices in the record, make every re-measure quadratic, and change
    // nothing on screen. 1.5 px is below what a reader can aim and above the jitter.
    const MIN_STEP = 1.5;

    return {
      onDown(event) {
        if (event.button !== 0) return false;
        const at = pixelAt(panel, event);
        if (!at) return false;
        pts = [at];
        value = null;
        since = 0;
        return true;
      },

      onMove(event) {
        if (!pts) return false;
        const now = pixelAt(panel, event);
        if (!now) return true;                    // off the image: keep the trace
        const last = pts[pts.length - 1];
        if (Math.hypot(now.x - last.x, now.y - last.y) < MIN_STEP) return true;
        pts.push(now);
        since += 1;
        // Early on the bounding box is a few pixels across and the test is free, so
        // the number appears immediately rather than after the eighth vertex.
        if (pts.length < 12 || since >= 8) {
          value = polygonStatistics(panel.frame, pts);
          since = 0;
        }
        if (value) setPreview(describeFreehand(panel.frame, pts, location, value, true));
        return true;
      },

      onUp() {
        const traced = pts;
        pts = null;
        setPreview(null);
        // THREE VERTICES OR IT IS NOT A REGION. A click that never moved, or a twitch
        // of two points, encloses nothing; committing it would put a row on the panel
        // reading `no pixels enclosed` that the reader never asked for.
        if (!traced || traced.length < 3) return true;
        // ALWAYS COMPUTED HERE, never the throttled value: the committed number is the
        // one the reader will write down.
        const final = polygonStatistics(panel.frame, traced);
        if (!final.count) return true;
        commit(describeFreehand(panel.frame, traced, location, final, false));
        return true;
      },

      onCancel() {
        pts = null;
        value = null;
        setPreview(null);
      },
    };
  },

  compute: polygonStatistics,
});

/**
 * Rectangular ROI.
 *
 * `regionStatistics` HAS TAKEN A `shape` SINCE IT WAS WRITTEN. Its signature is
 * `(frame, box, shape = 'ellipse')`, its JSDoc types the parameter `'ellipse'|'rectangle'`,
 * and the pixel loop already reads it -- `if (shape === 'ellipse' && !insideEllipse(...))
 * continue`. The only caller passed the string `'ellipse'`, so the rectangle branch was
 * implemented, documented, and unreachable.
 *
 * IT IS NOT A DUPLICATE OF THE ELLIPSE. A rectangle samples the corners an ellipse
 * excludes, which is what a reader wants when the region IS rectangular -- a slab of
 * muscle, a strip of cortex, a phantom insert -- and using an ellipse for those either
 * misses the corners or includes what is outside them. The statistics differ, so the
 * choice is a measurement decision and not a drawing preference.
 */
export const rectangleTool = dragTool({
  id: 'medos.roi-rect',
  title: 'Rectangle ROI',
  icon: 'roiRect',
  key: 'e',
  kind: 'roi',
  order: 25,
  compute: regionStatistics,
  describe(frame, a, b, location, isPreview) {
    const box = { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
    const value = regionStatistics(frame, box, 'rectangle');
    const m = describeMeasurement('roi', frame, location, value);
    return { ...m, kind: 'roi', shape: 'rectangle', box, preview: isPreview };
  },
});


/**
 * Angle: three points, not a drag.
 *
 * WHY THIS IS NOT `dragTool`. A caliper and an ROI are both two corners of one gesture, so
 * they share an interaction and differ only in the arithmetic at the end. An angle is three
 * points with a distinguished middle one, and there is no two-corner gesture that names a
 * vertex. Forcing it into a drag would mean inferring the vertex from the order of two
 * points, which is exactly the kind of guess that reads correctly on the first study and
 * wrongly on the one where the reader started from the other ray.
 *
 * So: click, click, click. The second click is the vertex, the third commits. The shell
 * disarms a tool when it commits, so holding the partial state here is the whole of it --
 * and `onCancel` clears it, which is what the Escape key and re-arming both reach.
 *
 * THE ARITHMETIC IS IN PATIENT SPACE and was written before this tool existed. `angle()`
 * computes on the millimetre vectors rather than the pixel ones, because on an anisotropic
 * frame the two differ: 45 degrees in pixels is not 45 degrees in the patient when the
 * spacing is 0.7 by 2.0 mm, and the pixel answer is the one that looks right on screen.
 * That function had no caller for as long as it has existed, and the annotation layer and
 * the measurements panel have both carried an `angle` branch that nothing could reach.
 */
export const angleTool = register({
  id: 'medos.angle',
  kind: KINDS.TOOL,
  title: 'Angle',
  // The glyph this tool wears in the header toolbar, named from `src/ui/icons.js`.
  // DECLARED HERE, beside the tool, so a contribution carries its own presentation
  // and the shell does not grow a table of ids it has to be kept in step with.
  icon: 'angle',
  key: 'g',
  order: 15,

  handlers(panel, location, commit, setPreview) {
    /** The points collected so far: [ray A], then [ray A, vertex]. */
    let taken = [];

    const describe = (points, isPreview) => {
      // Two points is not an angle yet -- it is the first ray, drawn so the reader can see
      // where they have anchored. `angle()` needs all three, so the value is null until
      // then and `formatValue` renders the partial shape without a number.
      const value = points.length === 3
        ? angle(panel.frame, points[0], points[1], points[2])
        : null;
      const m = describeMeasurement('angle', panel.frame, location, value);
      return { ...m, kind: 'angle', points, preview: isPreview };
    };

    return {
      onDown(event) {
        if (event.button !== 0) return false;      // middle and right stay pan and zoom
        const at = pixelAt(panel, event);
        if (!at) return false;

        // A SECOND CLICK ON THE SAME PIXEL IS NOT A SECOND POINT. Two coincident points
        // give a zero-length ray, and `angle()` returns NaN for it -- a row reading
        // "NaN degrees" looks like a measurement that failed rather than one never made.
        const last = taken[taken.length - 1];
        if (last && Math.abs(at.x - last.x) < 1 && Math.abs(at.y - last.y) < 1) return true;

        taken = [...taken, at];
        if (taken.length < 3) {
          setPreview(describe(taken, true));
          return true;
        }
        setPreview(null);
        const points = taken;
        taken = [];
        commit(describe(points, false));
        return true;
      },

      onMove(event) {
        if (!taken.length) return false;
        const now = pixelAt(panel, event);
        if (!now) return true;                     // moved off the image: keep the points
        setPreview(describe([...taken, now], true));
        return true;
      },

      // The gesture is click-to-place, so the release carries no information. Swallowed
      // rather than ignored, because returning false here would let the shell treat the
      // same press as the start of a pan.
      onUp() {
        return taken.length > 0;
      },

      onCancel() {
        taken = [];
        setPreview(null);
      },
    };
  },

  compute: angle,
});
