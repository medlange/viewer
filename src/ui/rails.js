// SPDX-License-Identifier: Apache-2.0
/* =====================================================================================
 * The side rails: drag them wider, hide them, and move a panel between them.
 *
 * WHY THIS IS A MODULE AND NOT A FEW LINES IN THE SHELL
 * ------------------------------------------------------
 * Three behaviours share one hard constraint, and the constraint is the reason they
 * belong together: the image panels are WebGL canvases whose BACKING STORE must track
 * their CSS size. A splitter drag, a rail collapse and a panel move all change that CSS
 * box without firing a `resize` event, and `window.addEventListener('resize', drawAll)`
 * is the only resize path this surface had. Any of the three, done naively, leaves the
 * canvas rendering at its pre-drag size: the picture stretches, the scale bar lies, and
 * a measurement taken afterwards is taken on a transform that no longer matches.
 *
 * So every path that changes a rail's width ends in `onResize()`. That is this module's
 * whole contract with the shell, and it is why `onResize` is a required argument rather
 * than something helpful this file imports for itself.
 *
 * IT MUST NOT IMPORT THE SHELL. `viewer/tests/test_architecture.py` globs
 * `src/ui/*.js` and fails any that reaches back into `app.js`; the shell passes what this
 * module needs. That is not ceremony -- a UI module that imports the shell cannot be
 * reasoned about without reading the shell, and the shell is 2800 lines.
 *
 * WHAT MUST NOT BE HIDEABLE
 * --------------------------
 * The footer. `MOS-SAFE-001` requires the positioning statement in the web UI footer and
 * `MOS-UI-008` binds it to a PERSISTENTLY REACHABLE one, so a rail toggle that could take
 * it off screen would be a way to configure away a required marking. The footer is not a
 * rail and this module never touches it; stated here because the next person to add a
 * "hide everything" mode needs to meet this sentence before they write it.
 *
 * A SEGMENTATION ON SCREEN BLOCKS HIDING THE RIGHT RAIL, through `blockedReason`. The
 * right rail is where a generated SEG says which algorithm produced it; hiding it leaves
 * a coloured overlay on the anatomy with nothing on the surface saying where it came
 * from. The shell decides that, not this file -- this file only asks and reports.
 * ===================================================================================== */

/* THE ONLY IMPORT, AND IT IS NOT THE SHELL. `src/core/i18n.js`, the same way
   `study-panel.js` and `dialogs.js` reach it. These four controls carried their names as
   English literals, so the rails read "Hide the study rail" inside a Russian interface --
   in the tooltip AND in the accessible name, which is the copy a screen-reader user has
   instead of the glyph. */
import { t, onLanguageChange } from '../core/i18n.js';
// THE SET'S CHEVRON, so the mark on this control and the one on the section heading
// 12px away are the same glyph at the same stroke width. They were a 5x5 rotated
// border and a 12px SVG, and a reader called the pair a strange arrow.
import { icon } from './icons.js';

/** Per READER, not per study. `session-store.js` is keyed by StudyInstanceUID because a
 *  measurement belongs to a study; a rail width belongs to the person. */
const KEY = 'medos.viewer.rails';
const VERSION = 1;

/** The custom properties each rail is sized by, and the bounds it is clamped to. */
const RAILS = {
  left: { prop: '--w-rail', min: '--w-rail-min', max: '--w-rail-max' },
  right: { prop: '--w-aside', min: '--w-aside-min', max: '--w-aside-max' },
};

let state = { widths: {}, hidden: {}, placement: {} };
let host = null;
let notifyResize = () => {};
let notifySettled = () => {};
let askBlocked = () => null;

function usable() {
  try {
    const probe = `${KEY}.probe`;
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return true;
  } catch {
    // A private window, or site data blocked. Rails still work; they just do not persist.
    return false;
  }
}

function load() {
  if (!usable()) return;
  try {
    const held = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!held || held.version !== VERSION) return;
    state = {
      widths: held.widths && typeof held.widths === 'object' ? held.widths : {},
      hidden: held.hidden && typeof held.hidden === 'object' ? held.hidden : {},
      placement: held.placement && typeof held.placement === 'object' ? held.placement : {},
    };
  } catch {
    // Corrupt is the same as absent. A layout is a convenience and must never be the
    // reason a reading surface fails to open.
  }
}

function save() {
  if (!usable()) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ version: VERSION, ...state }));
  } catch { /* quota, or a private window mid-session */ }
}

function pxOf(name, fallback) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

function railEl(name) {
  return host ? host.querySelector(`[data-rail="${name}"]`) : null;
}

/** Write the width to the CUSTOM PROPERTY, never to the element.
 *
 *  `.side` is `flex: 0 0 var(--w-rail)`. An inline `style.width` would be overridden by
 *  the flex-basis and the rail would not move, which looks like the drag not working
 *  rather than like the wrong property being written. */
function applyWidth(name, px) {
  const rail = RAILS[name];
  if (!rail) return;
  const lo = pxOf(rail.min, 140);
  const hi = pxOf(rail.max, 480);
  const clamped = Math.max(lo, Math.min(hi, px));
  document.documentElement.style.setProperty(rail.prop, `${Math.round(clamped)}px`);
  state.widths[name] = Math.round(clamped);
}

function applyHidden(name) {
  const isHidden = Boolean(state.hidden[name]);
  const el = railEl(name);
  if (el) el.hidden = isHidden;
  const handle = host && host.querySelector(`[data-splits="${name}"]`);
  // THE HANDLE GOES WITH THE RAIL. A splitter for a hidden rail is a 4px strip that
  // resizes nothing, and dragging it would set a width the reader cannot see.
  if (handle) handle.hidden = isHidden;
  // AND A WAY BACK STAYS ON SCREEN.
  //
  // Collapsing was reachable only from `[` and `]`, which are not in the key list either
  // -- so the rail could be closed by a reader who then had nothing to reopen it with.
  // The strip is 18px: enough to hold a target, narrow enough that reclaiming the space
  // is still the point.
  const strip = host && host.querySelector(`[data-restores="${name}"]`);
  if (strip) strip.hidden = !isHidden;
  const toggle = host && host.querySelector(`[data-collapses="${name}"]`);
  if (toggle) toggle.setAttribute('aria-expanded', String(!isHidden));
}

/**
 * Give each rail a visible way to close and to come back.
 *
 * Built here rather than written into `index.html` because a rail that the shell creates
 * needs one too, and because the strip only makes sense beside a rail this module knows
 * how to restore.
 */
function buildRailControls() {
  if (!host) return;
  for (const name of Object.keys(RAILS)) {
    const el = railEl(name);
    if (!el || host.querySelector(`[data-restores="${name}"]`)) continue;
    const side = name === 'left' ? 'right' : 'left';

    const strip = document.createElement('button');
    strip.type = 'button';
    strip.className = 'rail-restore';
    strip.dataset.restores = name;
    strip.hidden = !state.hidden[name];
    strip.dataset.i18nKey = name === 'left' ? 'rail.showLeft' : 'rail.showRight';
    strip.dataset.i18nEn = name === 'left'
      ? 'Show the study rail' : 'Show the measurements rail';
    strip.innerHTML = `<span aria-hidden="true">${icon('chevron')}</span>`;
    strip.onclick = () => toggleRail(name, false);
    if (name === 'left') el.before(strip); else el.after(strip);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = `rail-collapse rail-collapse-${side}`;
    toggle.dataset.collapses = name;
    toggle.dataset.i18nKey = name === 'left' ? 'rail.hideLeft' : 'rail.hideRight';
    toggle.dataset.i18nEn = name === 'left'
      ? 'Hide the study rail' : 'Hide the measurements rail';
    toggle.setAttribute('aria-expanded', String(!state.hidden[name]));
    toggle.innerHTML = `<span aria-hidden="true">${icon('chevron')}</span>`;
    toggle.onclick = () => toggleRail(name, true);
    el.prepend(toggle);
  }
  labelRailControls();
}

/**
 * Put the current language on the four rail controls, tooltip and accessible name alike.
 *
 * SEPARATE FROM BUILDING THEM, and called again on every language change, because these
 * nodes are created after `paintChrome` has already swept the document: a label written
 * once at build time is correct until the reader changes language and then silently is
 * not. The English stays on the node in `data-i18n-en` so a table missing the key falls
 * back to a sentence rather than to `rail.hideLeft`.
 */
function labelRailControls() {
  if (!host) return;
  for (const node of host.querySelectorAll('[data-i18n-key]')) {
    const text = t(node.dataset.i18nKey, node.dataset.i18nEn || '');
    node.title = text;
    node.setAttribute('aria-label', text);
  }
}
onLanguageChange(labelRailControls);

/**
 * Show or hide one rail.
 *
 * A HIDDEN RAIL IS HIDDEN, NOT NARROW. Dragging a rail to zero would leave no handle to
 * drag back, so the splitter clamps at `--w-rail-min` and the keyboard is the only route
 * to nothing. The two are different states on purpose: a reader who collapsed a rail gets
 * its width back when they reopen it.
 */
export function toggleRail(name, force) {
  if (!RAILS[name]) return null;
  const next = force === undefined ? !state.hidden[name] : Boolean(force);
  if (next) {
    const reason = askBlocked(name);
    if (reason) return reason;
  }
  state.hidden[name] = next;
  applyHidden(name);
  save();
  notifyResize();
  notifySettled();
  return null;
}

/** Which rail a panel currently sits in, or null when the shell has not placed it. */
export function railOf(panelId) {
  return state.placement[panelId] || null;
}

/**
 * Move a panel's section into the other rail.
 *
 * THE SECTION MOVES, NOT THE PANEL. Every registered panel mounts into a host element and
 * re-renders from state; moving the host's SECTION in the DOM leaves the host, its
 * subscription and its rendered contents untouched. Re-mounting would drop the panel's
 * teardown on the floor and subscribe it twice.
 */
export function movePanel(panelId, railName) {
  if (!RAILS[railName] || !host) return false;
  const section = host.querySelector(`[data-panel-id="${panelId}"]`);
  const target = railEl(railName);
  if (!section || !target) return false;
  target.appendChild(section);
  state.placement[panelId] = railName;
  save();
  notifyResize();
  notifySettled();
  return true;
}

/**
 * Wire the splitters and restore what this reader last chose.
 *
 * @param {object} o
 * @param {HTMLElement} o.root            the element holding the rails and splitters
 * @param {() => void} o.onResize         REQUIRED. Every width change ends here; see the
 *                                        header. Called once per animation frame while
 *                                        dragging, not once per pointer event.
 * @param {() => void} [o.onSettled]      after the gesture, for anything that reads a
 *                                        final size (the zoom buttons print a percentage)
 * @param {(rail: string) => (string|null)} [o.blockedReason]
 *                                        the shell's veto on hiding a rail, with its
 *                                        reason; returning a string refuses the hide
 */
export function initRails({ root, onResize, onSettled, blockedReason }) {
  if (!root) return;
  if (typeof onResize !== 'function') {
    // Loud, because the failure this prevents is silent: the rails would work and the
    // picture inside them would render at the wrong size.
    throw new Error('initRails needs onResize; a rail that resizes without redrawing '
      + 'leaves the canvas backing store at its old size');
  }
  host = root;
  notifyResize = onResize;
  notifySettled = typeof onSettled === 'function' ? onSettled : () => {};
  askBlocked = typeof blockedReason === 'function' ? blockedReason : () => null;

  load();
  // The controls first, so `applyHidden` has a restore strip to show.
  buildRailControls();
  for (const name of Object.keys(RAILS)) {
    if (Number.isFinite(state.widths[name])) applyWidth(name, state.widths[name]);
    applyHidden(name);
  }
  // Panels the reader moved, put back where they left them. Done after the widths so a
  // moved panel lands in a rail that is already its remembered size.
  for (const [panelId, railName] of Object.entries(state.placement)) {
    const section = host.querySelector(`[data-panel-id="${panelId}"]`);
    const target = railEl(railName);
    if (section && target && section.parentElement !== target) target.appendChild(section);
  }

  for (const handle of host.querySelectorAll('[data-splits]')) {
    const name = handle.dataset.splits;
    if (!RAILS[name]) continue;
    let frame = 0;
    let pending = null;

    const flush = () => {
      frame = 0;
      if (pending === null) return;
      applyWidth(name, pending);
      pending = null;
      notifyResize();
    };

    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const rail = railEl(name);
      if (!rail) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('dragging');
      document.body.classList.add('rail-dragging');
      const box = rail.getBoundingClientRect();
      // The edge that does NOT move: the left rail grows to the right, the right rail
      // grows to the left. Measuring from the fixed edge means the width follows the
      // pointer exactly rather than drifting by wherever in the handle the press landed.
      const anchor = name === 'left' ? box.left : box.right;

      const onMove = (ev) => {
        pending = name === 'left' ? ev.clientX - anchor : anchor - ev.clientX;
        // ONE REDRAW PER FRAME, not one per pointer event. A pointer emits well over a
        // hundred events a second and each redraw here is a full WebGL pass on every
        // panel; without this the drag stutters, and the stutter reads as a rendering
        // bug rather than as an event-rate one.
        if (!frame) frame = requestAnimationFrame(flush);
      };
      const onUp = (ev) => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        try { handle.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
        handle.classList.remove('dragging');
        document.body.classList.remove('rail-dragging');
        if (frame) { cancelAnimationFrame(frame); flush(); }
        save();
        notifySettled();
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });

    // A SPLITTER IS A CONTROL, so it answers the keyboard. `role="separator"` with a
    // tabindex that could not be moved from the keyboard would be a lie told to a screen
    // reader, and 16px a press is the step a reader can aim without watching the number.
    handle.addEventListener('keydown', (e) => {
      const rail = RAILS[name];
      const current = pxOf(rail.prop, 200);
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const delta = e.key === 'ArrowRight' ? 16 : -16;
        applyWidth(name, name === 'left' ? current + delta : current - delta);
        save();
        notifyResize();
        notifySettled();
      }
    });
  }
}
