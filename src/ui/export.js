// SPDX-License-Identifier: Apache-2.0
/* =====================================================================================
 * Getting a picture out of this viewer.
 *
 * NOTHING COULD LEAVE. No capture, no clipboard, no print, no key images -- and it was
 * structurally blocked rather than merely absent: the WebGL context is created with
 * `preserveDrawingBuffer: false` (viewport.js), so by the time anything asks the canvas
 * for its pixels the compositor has already taken them and `toDataURL` answers with a
 * fully black image. MEASURED, on a thorax CT with the picture plainly on screen: the data
 * URL came back 31,798 bytes -- which looks like content until you decode it and count,
 * and then it is 0 non-black pixels across 52,000 sampled and a single grey band.
 *
 * THE FIX IS NOT `preserveDrawingBuffer: true`. That makes every frame keep a copy of
 * itself for the lifetime of the context, on four contexts in a 2x2, to serve a button
 * pressed once an hour. The buffer is only lost at the END of the task that drew it, so a
 * render and a read IN ONE TASK both see it. `capturePanel` renders and reads with nothing
 * awaited in between, which is why it is written as one unbroken synchronous run and why
 * an `await` moved into the middle of it would break it silently.
 *
 * WHAT AN EXPORT IS, AND WHAT IT IS NOT. It is a composed picture: the image, the reader's
 * annotations over it, and a caption saying what it is. It is NOT a screenshot of this
 * surface -- the HUD is DOM and reproducing it pixel for pixel would need a DOM rasteriser,
 * which is a dependency and a SOUP item under IEC 62304 8.1.2 for the sake of copying a
 * layout we already know. The caption is drawn deliberately, so what it says is decided
 * here rather than inherited from wherever the HUD happened to put things.
 *
 * ONE DRAWING IMPLEMENTATION. The annotations are rasterised from the live SVG rather than
 * redrawn into the 2D context, because a second implementation of "how a caliper looks" is
 * two things that have to agree and eventually will not. What the SVG loses when it leaves
 * the document is its stylesheet, so the computed style of each element is inlined into a
 * clone first -- one extra step, against one extra copy of the drawing logic.
 *
 * IDENTIFIERS TRAVEL WITH IT. `volume.js` already warns that a series which may carry
 * burned-in identifiers takes them into "any screenshot or export of this view", and a
 * caption naming the patient is that warning made literal. `withIdentity: false` produces
 * a capture with the study named and the patient not, which is what a figure for a paper
 * needs; the caller decides, and the caption says which was chosen so an image cannot be
 * mistaken for the other kind later.
 *
 * Spec: MOS-SAFE-001 (the statement travels), MOS-DATA-040, MOS-UI-008.
 * ===================================================================================== */

/** The statement MOS-UI-008 binds, carried into every exported picture. */
const STATEMENT = 'RESEARCH USE ONLY — NOT FOR DIAGNOSTIC USE. NOT FOR CLINICAL DECISION MAKING.';

/** Properties an annotation needs in order to look like itself outside the document. */
const INLINE = [
  'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray',
  'font-family', 'font-size', 'font-weight', 'letter-spacing', 'opacity', 'visibility',
];

/**
 * A copy of `svg` that carries its own appearance.
 *
 * An SVG loaded through `<img>` is an isolated document: it cannot see this page's
 * stylesheet, so every class-driven rule evaporates and the annotations rasterise as black
 * on black. Copying the COMPUTED style means what is exported is what was on screen,
 * including any rule added later that nobody remembered to list here -- the list is of
 * PROPERTIES, not of selectors.
 */
function selfContained(svg) {
  const clone = svg.cloneNode(true);
  const from = svg.querySelectorAll('*');
  const to = clone.querySelectorAll('*');
  for (let i = 0; i < from.length; i++) {
    const computed = getComputedStyle(from[i]);
    let css = '';
    for (const prop of INLINE) {
      const value = computed.getPropertyValue(prop);
      if (value) css += `${prop}:${value};`;
    }
    to[i].setAttribute('style', css);
  }
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  return clone;
}

/**
 * One line of caption, broken to the width the picture actually has.
 *
 * WHY THIS EXISTS. `fillText` neither wraps nor clips: it draws from the x it is given and
 * whatever runs past the canvas is simply not in the file. Measured on a 2x2 at a 1024px
 * window -- a 283px capture -- the MOS-SAFE-001 statement needs 463px, so 44 of its 77
 * characters were exported and `NOT FOR CLINICAL DECISION MAKING.` was not. The
 * requirement says verbatim, and the half that went is the half about clinical decisions.
 *
 * WORDS FIRST, THEN CHARACTERS. A caption line can be a patient name or a protocol
 * description with no spaces in it at all; breaking only on spaces would put that back
 * over the edge. A word that cannot fit on its own line is broken where it reaches the
 * edge, which is ugly and legible, in that order of priority.
 */
function wrapToWidth(ctx, text, maxWidth) {
  const out = [];
  let line = '';
  const flush = () => { if (line) { out.push(line); line = ''; } };
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    const joined = line ? `${line} ${word}` : word;
    if (ctx.measureText(joined).width <= maxWidth) { line = joined; continue; }
    flush();
    if (ctx.measureText(word).width <= maxWidth) { line = word; continue; }
    let rest = word;
    while (rest && ctx.measureText(rest).width > maxWidth) {
      let cut = rest.length;
      while (cut > 1 && ctx.measureText(rest.slice(0, cut)).width > maxWidth) cut--;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  }
  flush();
  return out.length ? out : [''];
}

/** The caption's lines, in the order they are drawn. */
function captionLines(meta, withIdentity) {
  const lines = [];
  if (withIdentity) {
    lines.push([meta.patientName, meta.patientId].filter(Boolean).join('   '));
  }
  lines.push([meta.studyDate, meta.studyDescription].filter(Boolean).join('   ·   '));
  lines.push([meta.seriesDescription, meta.position, meta.window]
    .filter(Boolean).join('   ·   '));
  return lines.filter((l) => l && l.trim());
}

/**
 * Compose one panel into a canvas: the image, its annotations, and a caption.
 *
 * SYNCHRONOUS UNTIL THE PIXELS ARE READ. Everything from `viewport.render()` to
 * `toDataURL()` runs in one task on purpose -- see the header. The `await` below is after
 * the read, waiting only on the annotation raster.
 *
 * @param {object} panel         the panel to capture
 * @param {object} meta          what the caption should say
 * @param {boolean} withIdentity whether the patient is named on the picture
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function capturePanel(panel, meta, withIdentity = true) {
  if (!panel || !panel.canvas || !panel.viewport) return null;

  // --- one task, no awaits ------------------------------------------------------------
  panel.viewport.render();
  const imageURL = panel.canvas.toDataURL('image/png');
  // ------------------------------------------------------------------------------------

  const w = panel.canvas.width;
  const h = panel.canvas.height;
  const lines = captionLines(meta, withIdentity);
  const pad = 14;
  const lineHeight = 19;
  const statementLineHeight = 15;

  // THE BAND IS AS TALL AS WHAT GOES IN IT, which it was not: the height was computed from
  // the NUMBER OF STRINGS and each string was assumed to be one line. A string wider than
  // the picture is more than one line, and the one that is required to be verbatim is the
  // widest of them.
  const measure = document.createElement('canvas').getContext('2d');
  // WHAT IS ACTUALLY THERE, WITH NO FLOOR UNDER IT. This was `Math.max(40, ...)`, and a
  // floor breaks the invariant the wrapping exists to keep: text starts at `pad` and is
  // broken to `room`, so `pad + room` must not exceed the canvas. At any width below 68px
  // the floor put the last glyphs back outside the picture -- the defect, restored by the
  // guard against it. A capture narrower than its own padding has no room for a caption,
  // and `wrapToWidth` returns one glyph per line rather than looping.
  const room = Math.max(0, w - pad * 2);
  const fontFor = (i) => `${i === 0 && withIdentity ? '600 14px' : '400 13px'} `
    + 'system-ui, sans-serif';
  const wrapped = lines.map((line, i) => {
    measure.font = fontFor(i);
    return wrapToWidth(measure, line, room);
  });
  const withheldLines = [];
  if (!withIdentity) {
    measure.font = '400 12px system-ui, sans-serif';
    withheldLines.push(...wrapToWidth(
      measure, 'patient identifiers withheld from this capture', room));
  }
  measure.font = '600 11px system-ui, sans-serif';
  const statementLines = wrapToWidth(measure, STATEMENT, room);

  const captionRows = wrapped.reduce((n, l) => n + l.length, 0) + withheldLines.length;
  const captionHeight = pad + captionRows * lineHeight + 8
    + statementLines.length * statementLineHeight + pad;

  const out = document.createElement('canvas');
  out.width = w;
  out.height = h + captionHeight;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, out.width, out.height);

  const image = new Image();
  image.src = imageURL;
  await image.decode();
  ctx.drawImage(image, 0, 0, w, h);

  // The annotations, from the live layer, over the image they were drawn on.
  if (panel.annotations && panel.annotations.svg) {
    const clone = selfContained(panel.annotations.svg);
    clone.setAttribute('width', String(w));
    clone.setAttribute('height', String(h));
    const markup = new XMLSerializer().serializeToString(clone);
    const overlay = new Image();
    overlay.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
    try {
      await overlay.decode();
      ctx.drawImage(overlay, 0, 0, w, h);
    } catch {
      // A layer that will not rasterise costs the annotations, not the capture. Better a
      // picture of the anatomy with a caption than no picture at all -- and the caller is
      // told, so this is never silent.
      // WRAPPED LIKE EVERY OTHER STRING HERE. It is 47 characters at 13px -- wider than
      // a small panel -- and it was the one line in this file still drawn in a single
      // `fillText`, i.e. the one that could still run off the picture.
      ctx.fillStyle = '#d0a52a';
      ctx.font = '13px system-ui, sans-serif';
      const refusal = wrapToWidth(ctx, 'annotations could not be drawn into this capture',
        Math.max(0, w - pad * 2));
      let ry = h - pad - (refusal.length - 1) * 16;
      for (const row of refusal) { ctx.fillText(row, pad, ry); ry += 16; }
    }
  }

  // --- the caption --------------------------------------------------------------------
  let y = h + pad + 13;
  ctx.fillStyle = '#070d1a';
  ctx.fillRect(0, h, out.width, captionHeight);
  ctx.textBaseline = 'alphabetic';

  wrapped.forEach((rows, i) => {
    ctx.fillStyle = i === 0 && withIdentity ? '#e8edf5' : '#c3d2e6';
    ctx.font = fontFor(i);
    for (const row of rows) { ctx.fillText(row, pad, y); y += lineHeight; }
  });

  if (!withIdentity) {
    ctx.fillStyle = '#8fa3c0';
    ctx.font = '400 12px system-ui, sans-serif';
    for (const row of withheldLines) { ctx.fillText(row, pad, y); y += lineHeight; }
  }

  // MOS-SAFE-001, verbatim, on the picture rather than beside it. An exported image is
  // separated from this surface the moment it is saved, and a statement that stayed in the
  // footer would be a statement about a window nobody exporting it still has open.
  ctx.fillStyle = '#d0a52a';
  ctx.font = '600 11px system-ui, sans-serif';
  // FROM THE BOTTOM UP, so the last line of the statement keeps the padding it had and the
  // band above it holds however many lines the width forced.
  let sy = h + captionHeight - pad - (statementLines.length - 1) * statementLineHeight;
  for (const row of statementLines) { ctx.fillText(row, pad, sy); sy += statementLineHeight; }

  return out;
}

/** Offer a canvas as a file. */
export function downloadCanvas(canvas, filename) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      if (!blob) { resolve(false); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      // Revoked on the next turn of the loop: a click is dispatched synchronously but the
      // download is started by the browser afterwards, and revoking in the same task can
      // cancel it before it begins.
      setTimeout(() => URL.revokeObjectURL(url), 0);
      resolve(true);
    }, 'image/png');
  });
}

/**
 * The reader's measurements as CSV.
 *
 * ONE ROW PER MEASUREMENT, WITH ITS PROVENANCE. A number on its own is not a
 * measurement -- the spacing it was computed against, whether that spacing was stated by
 * the header, whether the pixels were a projection and which instance they came from are
 * what make it checkable by somebody who was not there. All of it is already frozen into
 * the record; this writes it out rather than deciding any of it again.
 */
/**
 * The number a row is about, and the unit it is in.
 *
 * NOT ONE RULE FOR ALL THREE KINDS, because the three kinds do not store the same shape
 * and do not share a unit. The first version of this writer took
 * `typeof m.value === 'object' ? m.value.mean : m.value` and `m.valueUnit || 'mm'`, and
 * against a real caliper it produced an EMPTY value and the unit `HU`:
 *
 *   - a length's value is `{mm, px}`, not a number, so `.mean` was undefined;
 *   - `valueUnit` is the unit of the PIXEL DATA -- HU on a CT -- which is the right label
 *     for an ROI's mean and nonsense beside a distance.
 *
 * A column headed `unit` reading `HU` next to a caliper is not a formatting slip: it is
 * the file saying the wrong thing about the number beside it, to whoever opens it later
 * without the viewer to check against.
 *
 * WHEN THE SPACING WAS NEVER STATED the distance is reported in PIXELS and said so, which
 * is what `distanceText` does on screen. Reporting millimetres computed against a
 * substituted [1, 1] would put a number in a column headed `mm` that no scanner produced.
 */
function figure(m) {
  if (m.kind === 'length') {
    const stated = m.spacingStated !== false;
    const v = m.value || {};
    return stated ? [v.mm, 'mm'] : [v.px, 'px'];
  }
  if (m.kind === 'angle') {
    // An angle keeps its unit whatever the spacing did, but it is only the PATIENT's angle
    // when the spacing was stated -- `angleText` says so on screen and the column does here.
    return [m.value, m.spacingStated === false ? 'deg (pixel grid)' : 'deg'];
  }
  if (m.kind === 'note') {
    // The text in the value column and no unit, because a sentence has none. A note
    // travels in the same CSV as the measurements because it is the reader's record
    // of the same reading session, and separating them would lose which slice it sat on.
    return [m.text || '', ''];
  }
  if (m.kind === 'roi') {
    const v = m.value || {};
    return [v.mean, m.valueUnit || ''];
  }
  return [m.value, m.valueUnit || ''];
}

export function measurementsCSV(measurements) {
  const cols = [
    // SHAPE IS A MEASUREMENT DECISION, NOT A DRAWING PREFERENCE, so it belongs in the
    // export. An ellipse excludes the corners a rectangle samples and a traced polygon
    // encloses neither; three ROIs on one lesion give three different means, and a
    // spreadsheet that recorded only the number could not say why they differed.
    'id', 'kind', 'shape', 'label', 'value', 'unit', 'plane', 'slice', 'seriesUID',
    'sopInstanceUID', 'pixelSpacingRow', 'pixelSpacingCol', 'spacingStated', 'projection',
  ];
  const quote = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = measurements.map((m) => [
    m.id,
    m.kind,
    // Empty for a length and an angle, which have no shape to record.
    m.shape || '',
    m.label || '',
    ...figure(m),
    // The NAME, falling back to the address. A spreadsheet is read by a person, and
    // 'axial' against a sagittal acquisition is wrong on paper too.
    m.planeName || m.plane,
    m.sliceIndex + 1,
    m.seriesUID || '',
    m.sopInstanceUID || '',
    m.pixelSpacing ? m.pixelSpacing[0] : '',
    m.pixelSpacing ? m.pixelSpacing[1] : '',
    m.spacingStated === undefined ? '' : m.spacingStated,
    m.projection ? 'yes' : 'no',
  ].map(quote).join(','));
  return [cols.join(','), ...rows].join('\n');
}

/** Offer text as a file. */
export function downloadText(text, filename, type = 'text/csv') {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
