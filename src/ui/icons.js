// SPDX-License-Identifier: Apache-2.0
/* =====================================================================================
 * The icon set: stroke paths on a 20x20 grid.
 *
 * INLINE, NOT A FONT AND NOT A SPRITE. An icon font is a third-party binary and a SOUP
 * item under IEC 62304 8.1.2 for the sake of eleven glyphs; a sprite sheet is a second
 * request that can fail independently of the page and leaves a toolbar of empty squares
 * when it does. These are ~200 bytes each and cannot fail separately from the code that
 * draws them.
 *
 * STROKE, NOT FILL, at 1.7 on a 19px box: a filled glyph at this size fills in and becomes
 * a blob on the dark chrome, and every one of these has to be distinguishable at a glance
 * from two feet away.
 *
 * Drawn to the shapes in the "MedOS Clinical Surfaces" design canvas. Where a shape is the
 * conventional one for the action -- a magnifier for zoom, a four-way arrow for pan -- it
 * is conventional on purpose: a reader arriving from another viewer should not have to
 * learn this toolbar, and originality here costs them time for nothing.
 * ===================================================================================== */

/** @type {Record<string, string>} path data for a 20x20 viewBox. */
export const ICONS = Object.freeze({
  length: '<path d="M3 13.5l10.5-10.5 3.5 3.5L6.5 17z"/>'
    + '<path d="M6.4 10.1l1.4 1.4M8.8 7.7l1.4 1.4M11.2 5.3l1.4 1.4"/>',
  angle: '<path d="M4 16h12"/><path d="M4 16L13 4"/>'
    + '<path d="M9.5 16a6 6 0 00-1.6-4"/>',
  eye: '<path d="M1.6 10s3-5.2 8.4-5.2S18.4 10 18.4 10s-3 5.2-8.4 5.2S1.6 10 1.6 10z"/>'
    + '<circle cx="10" cy="10" r="2.4"/>',
  eyeOff: '<path d="M1.6 10s3-5.2 8.4-5.2S18.4 10 18.4 10s-3 5.2-8.4 5.2S1.6 10 1.6 10z"/>'
    + '<path d="M4 16L16 4"/>',
  // A RIM, A HUB AND EIGHT TEETH THROUGH THE RIM. This was a hub and eight detached
  // spokes, which is a sun: what makes a gear a gear is the ring the teeth sit on, and
  // there was no ring. The teeth now start ON the rim (r=5.8) and run out to r=8.
  gear: '<circle cx="10" cy="10" r="5.8"/>'
    + '<circle cx="10" cy="10" r="2.2"/>'
    + '<path d="M10 4.2V2M10 15.8V18M15.8 10H18M4.2 10H2"/>'
    + '<path d="M14.1 5.9L15.7 4.3M5.9 14.1L4.3 15.7M14.1 14.1L15.7 15.7M5.9 5.9L4.3 4.3"/>',
  chevron: '<path d="M6 8l4 4 4-4"/>',
  // THREE DOTS, AT THE STROKE WIDTH THE REST OF THE SET USES. A circle of r 0.9 under
  // a 1.7 stroke reads as a dot rather than a ring, which is what this has to be.
  more: '<circle cx="4.8" cy="10" r="0.9"/><circle cx="10" cy="10" r="0.9"/>'
    + '<circle cx="15.2" cy="10" r="0.9"/>',
  calendar: '<rect x="3" y="4.5" width="14" height="12" rx="1.5"/>'
    + '<path d="M3 8.5h14M7 2.5v4M13 2.5v4"/>',
  note: '<path d="M4.5 5.5h11M4.5 9h11M4.5 12.5h7"/>'
    + '<path d="M13.4 15.6l3.1-3.1 1.4 1.4-3.1 3.1-1.8.4z"/>',
  roiFree: '<path d="M6.2 13.8c-2.4-1.6-2.6-5 .2-6.6 2.3-1.3 4-.2 5.6.6 1.8.9 3.6.3 4.4 1.6 1 1.7-.4 3.6-2 4.4-2.4 1.2-5.6 1.4-8.2 0z"/>',
  roiRect: '<rect x="3.2" y="5.4" width="13.6" height="9.2" rx="1"/>'
    + '<path d="M10 8.2v3.6M8.2 10h3.6"/>',
  roi: '<ellipse cx="10" cy="10" rx="7" ry="5.4"/>'
    + '<path d="M10 7.4v5.2M7.4 10h5.2"/>',
  zoom: '<circle cx="9" cy="9" r="5.6"/><path d="M13 13l4.2 4.2M6.6 9h4.8M9 6.6v4.8"/>',
  pan: '<path d="M10 3.2v13.6M3.2 10h13.6"/>'
    + '<path d="M7.4 6.1L10 3.5l2.6 2.6M7.4 13.9L10 16.5l2.6-2.6'
    + 'M6.1 7.4L3.5 10l2.6 2.6M13.9 7.4L16.5 10l-2.6 2.6"/>',
  window: '<circle cx="10" cy="10" r="6.4"/>'
    + '<path d="M10 3.6a6.4 6.4 0 010 12.8z" fill="currentColor" stroke="none"/>',
  layout: '<rect x="2.6" y="3.6" width="14.8" height="12.8" rx="1.5"/>'
    + '<path d="M10 3.6v12.8"/>',
  crosshair: '<path d="M10 2.8v14.4M2.8 10h14.4"/><circle cx="10" cy="10" r="2.4"/>',
  reset: '<path d="M16.4 10a6.4 6.4 0 11-2-4.6"/><path d="M16.4 2.8v3.6h-3.6"/>',
  link: '<path d="M8.2 12a3.6 3.6 0 010-5.1l1.9-1.9a3.6 3.6 0 015.1 5.1l-1 1"/>'
    + '<path d="M11.8 8a3.6 3.6 0 010 5.1l-1.9 1.9a3.6 3.6 0 01-5.1-5.1l1-1"/>',
  overlay: '<rect x="3.2" y="3.2" width="13.6" height="13.6" rx="1.5"/>'
    + '<path d="M6.6 10.4l2.6 2.6 4.4-6"/>',
  invert: '<circle cx="10" cy="10" r="6.8"/>'
    + '<path d="M10 3.2a6.8 6.8 0 010 13.6z" fill="currentColor" stroke="none"/>',
  cine: '<path d="M6.4 4.6l9 5.4-9 5.4z"/>',
  pause: '<path d="M7.2 4.8v10.4M12.8 4.8v10.4"/>',
  align: '<path d="M3.4 10h13.2"/><path d="M6.6 6.6L3.4 10l3.2 3.4"/>'
    + '<path d="M13.4 6.6L16.6 10l-3.2 3.4"/>',
  contrast: '<path d="M4 14.5l4.5-9 4.5 9"/><path d="M5.8 11h5.4"/>'
    + '<path d="M14.2 5.5v9"/>',
  rotate: '<path d="M4.4 8.2A6.2 6.2 0 1110 16.4"/><path d="M8 4.2L4.4 8.2l4 3.2"/>',
  flipH: '<path d="M10 3v14"/><path d="M7.4 6.2L3.4 10l4 3.8z"/>'
    + '<path d="M12.6 6.2L16.6 10l-4 3.8z"/>',
  flipV: '<path d="M3 10h14"/><path d="M6.2 7.4L10 3.4l3.8 4z"/>'
    + '<path d="M6.2 12.6L10 16.6l3.8-4z"/>',
  capture: '<rect x="2.6" y="5.4" width="14.8" height="10.2" rx="2"/>'
    + '<circle cx="10" cy="10.5" r="3.1"/><path d="M7.2 5.4l1.1-1.8h3.4l1.1 1.8"/>',
  table: '<rect x="3" y="4" width="14" height="12" rx="1.4"/>'
    + '<path d="M3 8h14M8 8v8"/>',
  fit: '<rect x="3" y="4.6" width="14" height="10.8" rx="1.4"/>'
    + '<path d="M6.4 8.2V7h1.4M13.6 8.2V7h-1.4M6.4 11.8V13h1.4M13.6 11.8V13h-1.4"/>',
});

/**
 * One icon as SVG markup.
 *
 * `aria-hidden`, always: the BUTTON carries the name. An icon that announces itself beside
 * a button that also announces itself is read twice by a screen reader, and the second
 * reading is the one that is wrong when the label and the glyph drift apart.
 */
export function icon(name) {
  const d = ICONS[name];
  if (!d) return '';
  return `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" `
    + `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
}
