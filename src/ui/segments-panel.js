/* =====================================================================================
 * The segments panel: what the AI produced, and how sure the platform is that it lines up.
 *
 * THIS IS THE FIRST PANEL ON THE REGISTRY, AND IT IS A PROOF RATHER THAN A PORT
 * ------------------------------------------------------------------------------
 * `src/core/registry.js` and `src/core/state.js` are only worth their lines if a real panel
 * can live on them without app.js reaching in. This one does: it is handed an element,
 * subscribes to the state it needs, and is never called by anything. Converting the rest
 * one at a time is then a sequence of small verifiable steps instead of a rewrite -- which
 * matters, because the viewer WORKS today and a big-bang refactor of a working clinical
 * surface is how it stops.
 *
 * WHAT IT RENDERS THAT A SEGMENTATION VIEWER USUALLY DOES NOT
 * ------------------------------------------------------------
 * The alignment provenance. `src/image/seg.js` matches SEG frames to slices by
 * `ReferencedSOPInstanceUID` first and by patient position second, and COUNTS BOTH plus the
 * frames it could not place. A viewer that draws the overlay and says nothing has told the
 * reader that the mask is correct; this one says how the correspondence was established and
 * how many frames failed it.
 *
 * That is not decoration. `MOS-SAFE-069` has a reviewer record a `ResultReview` with
 * `action: MODIFIED` when they disagree with a generated SEG, and a reviewer cannot
 * sensibly disagree with a mask whose alignment they cannot see. An overlay quietly missing
 * forty frames looks like a model that under-segmented, and the two need different actions.
 *
 * NO EDITING, AND THE FILE SAYS SO WHERE SOMEBODY WOULD ADD IT
 * --------------------------------------------------------------
 * `MOS-UI-204` and `MOS-UI-010`: no brush, no eraser, no scissors, no region grow, no
 * threshold primitive, no label-map interpolation, no segmentation undo stack. A segment
 * row here toggles VISIBILITY and nothing else. "Writing it here is forbidden regardless of
 * how small the first version looks, because the second version is a segmentation editor."
 *
 * Spec: MOS-SAFE-069, MOS-UI-010, MOS-UI-204, MOS-IMG-066.
 * ===================================================================================== */

import { KINDS, register } from '../core/registry.js';
import { activePanel, subscribeTo } from '../core/state.js';

/** Segment colours, matching the shader's `SEGMENT_COLOURS`. Index 0 is never drawn. */
const SWATCHES = ['', '#e63d3d', '#38c759', '#4f8ffa', '#fabf2e', '#c259e6', '#33d1d1', '#fa8533'];

function escape(s) {
  return String(s).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

/**
 * How the overlay was aligned, in a sentence a reader can act on.
 *
 * Three different states, deliberately worded differently: a clean match, a match that
 * needed the positional fallback, and an incomplete one. `MOS-CORE-004`'s vocabulary rules
 * bind UI strings, and "aligned" alone would say the same thing about all three.
 */
function alignmentNote(seg) {
  if (!seg) return null;
  const { reference = 0, position = 0 } = seg.matchedBy || {};
  const unmatched = seg.unmatched || 0;
  if (unmatched) {
    return {
      kind: 'warn',
      text: `${unmatched} frame(s) matched no slice and are not drawn — this overlay is `
        + `incomplete, which is not the same as the model finding nothing there`,
    };
  }
  if (position && !reference) {
    return {
      kind: 'warn',
      text: `aligned by patient position only (${position} frames) — the segmentation names `
        + `no source instance, so the correspondence is geometric rather than identified`,
    };
  }
  return {
    kind: 'ok',
    text: `aligned: ${reference} by SOP reference, ${position} by position, 0 unmatched`,
  };
}

function render(root) {
  const panel = activePanel();
  const seg = panel && panel.seg;

  if (!seg) {
    root.innerHTML = '<li class="muted">none on this panel</li>';
    return;
  }

  const note = alignmentNote(seg);
  const rows = seg.segments.map((s) => {
    const colour = SWATCHES[Math.min(s.number, SWATCHES.length - 1)];
    // ALGORITHM TYPE IS SHOWN because MOS-SAFE-012's adjacency set requires an AI-derived
    // finding to be identified as one wherever it appears. AUTOMATIC is not the same claim
    // as SEMIAUTOMATIC, and a reader accepting a mask should see which they are accepting.
    return `<li><span class="swatch" style="background:${colour}"></span>`
      // THE LABEL IS AN ELEMENT, so the rule meant for it can reach it. It was a bare
      // text node, and `.segments li > span:nth-child(2)` therefore selected the
      // ALGORITHM mark instead -- the AI-provenance fact was the thing that stretched
      // and the label was the thing that got squeezed, which is backwards.
      + `<span class="seg-label" title="${escape(s.label)}">${escape(s.label)}</span>`
      + `<span class="muted">${escape(s.algorithm)}</span></li>`;
  });

  root.innerHTML = rows.join('')
    + `<li class="tiny ${note.kind === 'warn' ? 'warn-text' : 'muted'}">${escape(note.text)}</li>`;
}

export default register({
  id: 'medos.segments',
  kind: KINDS.PANEL,
  title: 'Segments',
  order: 20,
  // WHICH RAIL, declared rather than implied by where its markup was pasted. This
  // panel's section exists in index.html so its empty state is on screen before the
  // first subscription fires; `slot` is what the shell would use to build one.
  slot: 'right',

  /**
   * Mount into `root`. Returns its own teardown, so a layout change cannot leave a
   * subscriber attached to a detached element -- the leak that turns a long reading
   * session into a page that repaints panels nobody can see.
   */
  mount(root) {
    render(root);
    return subscribeTo(['panels', 'active'], () => render(root));
  },

  /** Exposed for the test; rendering logic worth asserting on directly. */
  _alignmentNote: alignmentNote,
});
