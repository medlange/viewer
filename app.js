/* =====================================================================================
 * The MedicalOS Viewer application shell.
 *
 * It wires modules that each refuse rather than approximate:
 *   dicom/dicomweb.js  the only route to pixels, through the Gateway, uncompressed, streamed
 *   dicom/parse.js     Explicit VR LE only; every other syntax is named and refused
 *   image/volume.js    slices sorted by patient-space position, never InstanceNumber
 *   image/seg.js       SEG frames aligned by ReferencedSOPInstanceUID, never frame order
 *   image/mpr.js       axial / coronal / sagittal from one acquired stack
 *   image/sync.js      cross-panel linking, by patient position where that is meaningful
 *
 * N PANELS, ONE ACTIVE
 * ---------------------
 * Each panel owns a canvas, a WebGL2 context and a `Viewport`; four contexts for a 2x2 is
 * well inside every browser's limit. Panels are independent except where the link toggles
 * say otherwise, and the ACTIVE panel is the one the keyboard and the series list act on --
 * clicking a panel makes it active, which is the interaction a RadiAnt reader already has.
 *
 * Spec: MOS-UI-002 (no PACS credential), MOS-UI-005 (surface header), MOS-UI-008 (footer),
 * MOS-UI-200 (RadiAnt ergonomics), MOS-UI-207 (mouse bindings), MOS-UI-204 (no editing),
 * MOS-UI-009a (MOS-UI-009 was withdrawn at specification 0.3.0; MOS-UI-009a states
 * what a first-party viewer is held to instead -- see docs/spec/19-operator-surfaces.md
 * §19.1.2 and register entry 103).
 * ===================================================================================== */

import { DicomWebClient } from './src/dicom/dicomweb.js';
import { DicomRefusal } from './src/dicom/parse.js';
import { buildStack } from './src/image/volume.js';
import { decodeSegmentation } from './src/image/seg.js';
import { resampleOnto } from './src/image/fusion.js';
import { readStructuredReport } from './src/image/sr.js';
import {
  PLANES, planeDepth, planeStepMm, planeAnatomy, reconstructionRefusal, rescaleVariesOver, reslice,
  slabHalf,
} from './src/image/mpr.js';
import { isOblique, obliqueName, obliqueParts } from './src/image/oblique.js';
import { ABSENT, LINK, describeLink, followIndex, linkBadge }
  from './src/image/sync.js';
import { Viewport } from './src/render/viewport.js';
import {
  NO_TRANSFORM, flippedHorizontally, flippedVertically, imageToScreen, isTransformed,
  rotatedRight, scaleBarOf, screenToImage, viewOf, zoomForOneToOne,
} from './src/render/transform.js';
import { referenceLine } from './src/image/reference.js';
import { resolutionNote, withUnit } from './src/image/units.js';
// ONE RENDERING OF A DICOM DATE for every surface that shows one: the
// worklist, the banner, the study rail and the study panel. The panel had its
// own, and the same study read `02-Jun-2016` in two places and `2016-06-02` in
// a third on one screen.
import { studyDate } from './src/dicom/dates.js';
import { edgeLetters, screenEdges } from './src/image/orientation.js';
import { AnnotationLayer } from './src/render/annotations.js';
import { KINDS, contributions } from './src/core/registry.js';
import './src/tools/measure-tools.js';   // registers the caliper and the ROI
import './src/ui/measurements-panel.js'; // registers the measurements panel
import './src/ui/segments-panel.js';    // registers the segments panel
// NO MARKUP IN index.html. It declares its slot and the shell builds its section --
// which is the whole point: a panel is a registration and an import, not an HTML edit.
import './src/ui/study-panel.js';       // registers the study panel
import { openAbout, openPreferences } from './src/ui/dialogs.js';
import { startI18n, onLanguageChange, t } from './src/core/i18n.js';
import { get as getState, set as setState, subscribeTo } from './src/core/state.js';
import { icon } from './src/ui/icons.js';
import { remeasure } from './src/image/measure.js';
import { pixelAt } from './src/render/transform.js';
import {
  crosshairOn, cursorAt, indexForCursor, slideCursor,
} from './src/image/sync.js';
import {
  capturePanel, downloadCanvas, downloadText, measurementsCSV,
} from './src/ui/export.js';
import { recall, remember } from './src/core/session-store.js';
import { initRails, movePanel, railOf, toggleRail } from './src/ui/rails.js';


/* ----------------------------------------------------------------------------------
 * WHERE THE PIXELS COME FROM, AS CONFIGURATION RATHER THAN AS A SHAPE THIS VIEWER KNOWS
 *
 * This read `/dicomweb/${TENANT}` with the tenant taken from the query string, and both
 * halves of that are MedicalOS conventions rather than DICOMweb ones. PS3.18 defines the
 * service paths under a root and says nothing about what precedes it; a tenant segment is
 * the Gateway's way of making `MOS-DATA-009` checkable, and a viewer that requires one
 * cannot be pointed at an Orthanc, a dcm4chee or any other conformant origin.
 *
 * So the root is now asked for, with the plain `/dicomweb` as the default that any
 * DICOMweb origin answers. MedicalOS supplies the tenant-segmented one through
 * `window.VIEWER_CONFIG`, which is the whole of what makes this surface MedicalOS's
 * clinician viewer rather than a viewer.
 *
 * THE QUERY STRING STILL WINS, because it is how a reader reaches a second tenant without
 * a second deployment, and because that behaviour predates this seam and removing it would
 * break links people hold.
 */
const CONFIG = (typeof window !== 'undefined' && window.VIEWER_CONFIG) || {};

const TENANT = new URLSearchParams(location.search).get('tenant') || CONFIG.tenant || '';

/** `/dicomweb`, or whatever an extension points this at -- with the tenant if there is one. */
function dicomWebRoot() {
  const base = String(CONFIG.dicomWebRoot || '/dicomweb').replace(/\/+$/, '');
  return TENANT ? `${base}/${TENANT}` : base;
}

const client = new DicomWebClient({
  root: dicomWebRoot(),
  surfaceHeader: CONFIG.surfaceHeader,
  surface: CONFIG.surface,
});

/**
 * A HOST'S NAME FOR THIS SURFACE, if it has given one.
 *
 * The title and the heading shipped as `MedicalOS` and `MedicalOS Viewer`, which is a
 * claim about whose software this is -- wrong the moment it is pointed at anything else.
 * What ships now is what this software is when nobody has named it, and a host overrides.
 *
 * NOT THROUGH `sub_filter` LIKE THE FOOTER STATEMENT, and the difference is the point: a
 * name is a name, and showing the default one for a frame before the module runs costs
 * nothing. The footer statement is a required safety marking, so it is in the bytes the
 * origin sends rather than in anything that has to run.
 */
function applyProductName() {
  const name = CONFIG.productName;
  if (!name) return;
  document.title = String(name);
  const h1 = document.getElementById('product-name');
  if (h1) h1.textContent = String(name);
}
applyProductName();

const $ = (id) => document.getElementById(id);
const el = {
  dialogs: $('dialogs'), gear: $('t-gear'), chromeMenu: $('chrome-menu'),
  studies: $('studies'), studyList: $('study-list'), viewer: $('viewer'),
  series: $('series'), segments: $('segments'), measurements: $('measurements'),
  priors: $('priors'), priorsSection: $('priors-section'),
  protocol: $('protocol'), protocolSection: $('protocol-section'),
  grid: $('grid'), back: $('back'), notice: $('notice'),
  presets: $('presets'), planes: $('planes'), layouts: $('layouts'), links: $('links'),
  slab: $('slab'), orient: $('orient'), zooms: $('zooms'),
  oblique: $('oblique'),
  tools: $('tools-group'),
  invert: $('t-invert'), overlay: $('t-overlay'), cine: $('t-cine'), reset: $('t-reset'),
  help: $('help'),
  who: $('who'), whoName: $('who-name'), whoMeta: $('who-meta'),

  footTech: $('foot-tech'),
  barTools: $('bar-tools'), barVerbs: $('bar-verbs'), barToggles: $('bar-toggles'),
  barMore: $('bar-more'), barMoreMenu: $('bar-more-menu'),
  wlCount: $('wl-count'), wlPage: $('wl-page'), wlPrev: $('wl-prev'),
  wlNext: $('wl-next'), wlClear: $('wl-clear'),
  fName: $('f-name'), fId: $('f-id'), fFrom: $('f-from'), fTo: $('f-to'),
  fDesc: $('f-desc'), fMod: $('f-mod'), fAcc: $('f-acc'),
};

/**
 * The non-image modalities this viewer ACTUALLY CONSUMES.
 *
 * Declared once because two places read it and they had drifted: `loadDerived` below
 * handles SEG and SR, and the series list told the reader that ANY non-image series "is
 * layered onto the image panels instead". A clinic MR corpus carried 22 GSPS presentation
 * states, and clicking one of those said the saved window and the referring radiologist's
 * annotations were already on screen. They were not, and nothing on the surface said so --
 * which is worse than showing nothing, because a reader who is told a presentation state
 * is applied will read the image as presented.
 *
 * ADDING SUPPORT FOR A MODALITY MEANS ADDING IT HERE, and the message follows. That is the
 * point of the constant: the claim cannot outlive the code that made it true.
 */
const DERIVED_MODALITIES = ['SEG', 'SR'];

/**
 * (0008,0020) as a reader reads it.
 *
 * A DA is eight digits. The study list printed them raw -- `20031104` -- which is not a
 * date to anyone, and with no sort and no time two studies from the same day were both
 * indistinguishable and unorderable. The month is spelled rather than numbered because
 * 03-11-2004 means two different days on two sides of an ocean and a reading surface does
 * not get to be ambiguous about which.
 */
/** DICOM JSON: first value of a tag, or a fallback. */
const dv = (obj, tag, fallback = '') => {
  const v = obj?.[tag]?.Value?.[0];
  if (v === undefined || v === null) return fallback;
  return typeof v === 'object' ? (v.Alphabetic ?? fallback) : v;
};

/* ----------------------------------------------------------------------------------
 * state
 * -------------------------------------------------------------------------------- */

let panels = [];
let active = 0;
/** The grid's shape, so the picker opens on the cell the reader is already in. */
let layoutCols = 1;
let layoutRows = 1;
/**
 * The study the reader arrived at from the worklist.
 *
 * NOT "the study the surface is showing" any more -- a panel answers that, one panel at a
 * time, through `panel.studyUID`. This is narrower and still needed: it is what a prior is
 * a prior TO, it is what the back button returns from, and it is the study whose
 * measurements are recalled on arrival. A prior loaded into a panel does not move it.
 */
let studyUID = null;

/**
 * What follows what.
 *
 * Scroll is on by default because it is the reason to open two panels at all. Window and
 * zoom are OFF by default because two series with different acquisitions legitimately want
 * different windows, and forcing one is the kind of helpful default a reader has to undo on
 * every case.
 */
const link = { scroll: true, window: false, zoomPan: false };

/**
 * Which load owns which panel. A load whose controller has been replaced drops its results
 * rather than writing a panel -- without it, switching series mid-stream lets an abandoned
 * load paint its anatomy under the one the reader asked for.
 */
let loadToken = 0;
const inFlight = new Map();

/**
 * The selection lives in the store; these read it.
 *
 * `state.selectedMeasurement` is the one place it is written, so the measurements panel
 * and the annotation layer cannot disagree about which shape is selected. The shell
 * subscribes below rather than redrawing at each call site, which means a selection made
 * anywhere -- a panel row, a shape, a delete that clears it -- reaches every overlay by
 * the same path.
 */
const selectedId = () => getState().selectedMeasurement;

/** The handle drag in progress: which measurement, which point, and on which panel. */
let handleDrag = null;

let cineTimer = null;

/**
 * What this viewer READ, which is not the same claim as what the archive holds.
 *
 * `parse.js` refuses every syntax but Explicit VR LE by name, and the Gateway transcodes
 * on the way out -- so this is true of the bytes that arrived here and says nothing about
 * how the study is stored. It read `Explicit VR LE · uncompressed · no codec` as a
 * standing header pill, which is a stronger claim in a more prominent place than the
 * thing it knows. (0028,2110) LossyImageCompression is still not read; when it is, this
 * is where it belongs, because lossy-compressed-then-transcoded is exactly the case the
 * present wording would hide.
 */
let transferSyntax = '';

/**
 * The armed measurement tool, or null for navigation.
 *
 * MOS-UI-207: the default bindings are live "the moment the case opens, without the reader
 * selecting a mode". So this is null almost always, a tool arms it for ONE measurement, and
 * completing or cancelling returns it to null. A viewer that SAT in a measurement mode
 * would make window/level -- the most frequent action in thoracic reading -- cost two
 * clicks, which that requirement says the reader notices within the first case.
 */
let armed = null;

/**
 * Reader measurements live in `core/state.js`, not here.
 *
 * They are read by the measurements panel, which is a registered contribution and never
 * calls back into this module -- the seam src/core/registry.js exists for. `preview` stays
 * local because it is a property of the drag in progress, not of the case.
 */
let preview = null;

/**
 * Whether reference lines are drawn. On by default in a multi-panel layout, because the
 * reason to open two panels is to relate them and a locator the reader has to switch on is
 * a locator they will not have on when they need it.
 */
let showReferences = true;

/**
 * Say something to a screen reader, and to nothing else.
 *
 * THIS SURFACE HAD NO LIVE REGION ANYWHERE. A refusal, a filter result count, a
 * measurement appearing -- every one of them was a visible event and a silent one, which
 * is WCAG 4.1.3 exactly. `index.html` now carries two regions that exist from first paint
 * and are never `hidden`, because a region created or unhidden in the same task that
 * fills it is missed by several readers.
 *
 * THE TEXT IS CLEARED BEFORE IT IS WRITTEN. A live region set to the string it already
 * holds announces nothing, so moving one slice and back again would go unspoken.
 *
 * AND IT IS DEBOUNCED. A held arrow key steps the stack as fast as it can draw; speaking
 * every step would make the viewer unusable with a reader running, and speaking none of
 * them leaves the key with no feedback. 120 ms says where the reader STOPPED.
 */
let announceTimer = null;
function announce(message, urgent = false) {
  const region = document.getElementById(urgent ? 'live-alert' : 'live-polite');
  if (!region || !message) return;
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => {
    region.textContent = '';
    requestAnimationFrame(() => { region.textContent = message; });
  }, urgent ? 0 : 120);
}

function notice(message, kind = 'warn') {
  if (!message) { el.notice.hidden = true; return; }
  el.notice.hidden = false;
  el.notice.className = `notice ${kind}`;
  el.notice.textContent = message;
  // AND SAID, not only shown. Every refusal this viewer makes lands here, and a reader
  // who cannot see the box was told nothing at all. A refusal interrupts; an `info`
  // waits for a pause.
  announce(message, kind !== 'info');
}

/* ----------------------------------------------------------------------------------
 * presets (MOS-UI-208: a named file carrying the SOURCE of each value)
 * -------------------------------------------------------------------------------- */

let PRESETS = [{ name: 'Default', key: '1', center: null, width: null, source: 'acquisition' }];

async function loadPresets() {
  try {
    const res = await fetch('./presets.json');
    if (!res.ok) throw new Error(String(res.status));
    PRESETS = (await res.json()).presets;
  } catch (err) {
    notice(`presets.json did not load (${err.message}); only the acquisition window is available.`);
  }
}

/* ----------------------------------------------------------------------------------
 * hanging protocols -- how a case is laid out on arrival, and what that is CALLED
 *
 * The argument for building this, and the argument that 19.4.4 does not reach this
 * surface, are both in `protocols.json`'s own header rather than repeated here.
 * -------------------------------------------------------------------------------- */

/** The fallback that ships in the code, so a case still opens when the file does not
 *  load. One panel is the honest arrangement when nothing is known about the study. */
let PROTOCOLS = [{
  id: 'single-series', name: 'One series, one panel', when: {}, layout: { rows: 1, cols: 1 },
}];

/** Which protocol arranged the screen, and whether the reader has taken it over. */
let protocolInForce = null;
let protocolOverridden = false;

async function loadProtocols() {
  try {
    const res = await fetch('./protocols.json');
    if (!res.ok) throw new Error(String(res.status));
    const held = (await res.json()).protocols;
    // A TABLE WHOSE LAST RULE CAN FAIL ARRANGES NOTHING AND SAYS IT ARRANGED SOMETHING.
    // The file declares a catch-all; if the one that loaded does not, the built-in
    // fallback is appended rather than trusted to be unnecessary.
    if (!Array.isArray(held) || !held.length) throw new Error('no protocols in the file');
    PROTOCOLS = held.some((p) => p && p.when && Object.keys(p.when).length === 0)
      ? held
      : [...held, ...PROTOCOLS];
  } catch (err) {
    notice(`protocols.json did not load (${err.message}); every case opens in one panel.`);
  }
}

/**
 * The first protocol whose conditions the study meets.
 *
 * AN UNKNOWN CONDITION DOES NOT MATCH. A rule asking something this function cannot
 * answer is skipped, not granted: a typo in `when` would otherwise turn its rule into a
 * catch-all sitting above the real ones, and the first study to open would be arranged by
 * a mistake that looks exactly like a decision.
 */
function chooseProtocol(rows, { priorOpen = false } = {}) {
  const images = rows.filter((s) => ['CT', 'MR', 'PT'].includes(dv(s, '00080060')));
  const modalities = new Set(images.map((s) => String(dv(s, '00080060', ''))));
  const answers = {
    priorOpen: (want) => want === priorOpen,
    modality: (want) => modalities.size === 1 && modalities.has(String(want)),
    minImageSeries: (want) => images.length >= Number(want),
    maxImageSeries: (want) => images.length <= Number(want),
  };
  return PROTOCOLS.find((p) => {
    if (!p || !p.when || !p.layout) return false;
    return Object.entries(p.when).every(([key, want]) => (
      Object.prototype.hasOwnProperty.call(answers, key) && answers[key](want)
    ));
  }) || null;
}

/** Say which protocol arranged this screen, in the rail, where it cannot be clipped. */
function renderProtocolName() {
  if (!el.protocol) return;
  if (!protocolInForce) { el.protocolSection.hidden = true; return; }
  el.protocolSection.hidden = false;
  const name = escape(String(protocolInForce.name || protocolInForce.id));
  el.protocol.innerHTML = protocolOverridden
    ? `<span class="protocol-name was">${name}</span>`
      + `<span class="protocol-over">${escape(t('layout.overridden', 'overridden'))}</span>`
    : `<span class="protocol-name">${name}</span>`;
}

/* ----------------------------------------------------------------------------------
 * panels
 * -------------------------------------------------------------------------------- */

function makePanel(i) {
  const node = document.createElement('div');
  node.className = 'vp';
  node.dataset.panel = String(i);
  // THE PICTURE IS A PLACE THE KEYBOARD CAN STAND.
  //
  // Every binding this viewer has for the image -- the arrows, the plane letters, the
  // window presets -- listened on `window`, so they fired no matter what had focus and
  // the panel itself was not a control at all: no `tabindex`, no role, no name. That is
  // both halves of the problem. It made the shortcuts fire while the reader was typing
  // (fixed above) AND left the primary content of the application unreachable and
  // unannounced. `aria-label` is written on every draw, from the same numbers the HUD
  // prints.
  node.tabIndex = 0;
  node.setAttribute('role', 'group');
  node.setAttribute('aria-label', 'Image panel');
  node.innerHTML = `
    <canvas role="img" aria-label="No series loaded"></canvas>
    <div class="hud hud-tl"></div>
    <div class="hud hud-tr"></div>
    <div class="hud hud-bl"></div>
    <div class="hud hud-br"></div>
    <!-- Edge MIDPOINTS, not corners. A letter at a corner belongs to two edges and says
         which way neither of them points. These four are the only thing on screen that
         distinguishes the patient's left from their right. -->
    <div class="hud hud-edge hud-top"></div>
    <div class="hud hud-edge hud-bottom"></div>
    <div class="hud hud-edge hud-left"></div>
    <div class="hud hud-edge hud-right"></div>
    <!-- The scale bar. A drawn length beats a number because the reader sizes a finding by
         comparing it to the bar, not by reading it. -->
    <div class="hud scale"><div class="scale-line"></div><span class="scale-mm"></span></div>
    <div class="link-badge" hidden></div>
    <div class="scrollbar"><div class="thumb"></div></div>
    <div class="empty">click a series</div>`;

  const canvas = node.querySelector('canvas');
  const panel = {
    node, canvas, viewport: null, stack: null, index: 0, plane: PLANES.AXIAL,
    seg: null, frame: null, seriesUID: null, label: '', _drag: null,
    // PER PANEL, not global. A 2x2 showing an axial MIP beside a plain coronal is the
    // normal way to read one, and a single shared thickness would put every panel into
    // projection at once -- including the one the reader kept as the slice-by-slice
    // reference to check the MIP against.
    slab: null,
    hud: {
      tl: node.querySelector('.hud-tl'), tr: node.querySelector('.hud-tr'),
      bl: node.querySelector('.hud-bl'), br: node.querySelector('.hud-br'),
      edges: {
        top: node.querySelector('.hud-top'), bottom: node.querySelector('.hud-bottom'),
        left: node.querySelector('.hud-left'), right: node.querySelector('.hud-right'),
      },
      scale: node.querySelector('.scale'),
      scaleLine: node.querySelector('.scale-line'),
      scaleMm: node.querySelector('.scale-mm'),
      badge: node.querySelector('.link-badge'),
      thumb: node.querySelector('.thumb'), bar: node.querySelector('.scrollbar'),
      empty: node.querySelector('.empty'),
    },
  };

  try { panel.viewport = new Viewport(canvas); }
  catch (err) { notice(describe(err), 'err'); }
  panel.annotations = new AnnotationLayer(node);

  /* A LOST CONTEXT IS A PICTURE THAT LEFT WITHOUT SAYING SO.
   *
   * Observed on this build: `gl.isContextLost()` was true on one panel while its HUD went
   * on naming the series, the patient, the window, the slice and the orientation, with the
   * scale bar still drawn under them. The anatomy was gone. Nothing listened for the
   * event, so nothing said anything.
   *
   * THIS IS ORDINARY, NOT EXOTIC. A browser takes a context away for reasons that have
   * nothing to do with this surface -- a driver reset, a laptop switching GPUs, the system
   * reclaiming resources, or simply too many live contexts. This viewer opens ONE PER
   * PANEL, four in a 2x2, and builds new ones on every layout change.
   *
   * `preventDefault()` is not decoration: the event's default action makes the loss
   * permanent, and `webglcontextrestored` never fires without it. */
  // WHAT A PANEL IS ACROSS A CONTEXT, captured while the old viewport is still here. The
  // list is `setLayout`'s, for the same reason: a fresh `Viewport` has no window and
  // `draw` reads one -- measured, `TypeError: Cannot read properties of undefined
  // (reading 'center')` on the first frame after a restore. None of these live in the
  // context; they are plain fields on an object the lost context never owned.
  let acrossTheLoss = null;
  canvas.addEventListener('webglcontextlost', (e) => {
    // A RETIRED PANEL'S LOSS IS THIS VIEWER'S OWN DOING AND IS NOT NEWS. `setLayout`
    // releases each outgoing panel's context deliberately (`Viewport.dispose`), and the
    // event for that arrives asynchronously, after the node has left the grid. Without
    // this line a 2x2 -> 1x1 would raise four alarms about a picture nobody lost and
    // would call `preventDefault`, which asks the browser to keep the context RESTORABLE
    // -- the exact opposite of giving it back.
    if (panel.retired) return;
    e.preventDefault();
    acrossTheLoss = panel.viewport && panel.viewport.window ? {
      window: { ...panel.viewport.window },
      zoom: panel.viewport.zoom,
      pan: [...panel.viewport.pan],
      transform: panel.viewport.transform,
      oneToOne: panel.viewport.oneToOne,
      invert: panel.viewport.invert,
      overlayAlpha: panel.viewport.overlayAlpha,
    } : null;
    panel.frame = null;
    // NOTHING DRAWS WHILE THERE IS NOTHING TO DRAW WITH. The reader goes on turning the
    // wheel and pressing keys between the loss and the restore, and every one of those
    // calls reached `draw`, which reached a dead context.
    panel.contextLost = true;
    blankHud(panel);
    panel.hud.empty.textContent = 'The browser took this panel\'s graphics context away. '
      + 'The picture is gone and its labels with it; both come back when the context does.';
    panel.hud.empty.hidden = false;
    notice('A panel lost its graphics context and has been blanked rather than left '
      + 'captioned. Nothing on it describes an image any more.', 'err');
  });

  /* The shaders, the textures and the buffers belonged to the context that went, so the
   * viewport is built again rather than reused. No request is made: `setLayout` says what
   * survives a context -- "the stack, the index, the plane, the segmentation" -- and that
   * is everything `draw` needs. */
  canvas.addEventListener('webglcontextrestored', () => {
    // Nothing is rebuilt onto a panel that has left the grid -- that would open a fresh
    // context for a canvas nobody can see, which is the leak this retirement exists to
    // close. A `preventDefault`-less loss should never be restored, and this is the belt
    // to that braces.
    if (panel.retired) return;
    try { panel.viewport = new Viewport(canvas); }
    catch (err) { notice(describe(err), 'err'); return; }
    if (acrossTheLoss) {
      panel.viewport.setWindow(acrossTheLoss.window.center, acrossTheLoss.window.width);
      Object.assign(panel.viewport, {
        zoom: acrossTheLoss.zoom,
        pan: acrossTheLoss.pan,
        transform: acrossTheLoss.transform,
        oneToOne: acrossTheLoss.oneToOne,
        invert: acrossTheLoss.invert,
        overlayAlpha: acrossTheLoss.overlayAlpha,
      });
    }
    // AND THE TOGGLES ARE RE-DERIVED FROM THE VIEWPORT THAT CAME BACK, not left lit from
    // the one that went.
    syncToggles();
    panel.contextLost = false;
    panel.hud.empty.hidden = true;
    // AND THE ALARM GOES WITH THE CONDITION -- but it says only what happened. A panel
    // holding no series is not redrawn, and the first version of this line told the reader
    // it had been.
    if (panel.stack) {
      draw(panel);
      notice('The graphics context came back and the panel was redrawn from the series it '
        + 'already held.', 'info');
    } else {
      notice('The graphics context came back. The panel was holding no series, so there '
        + 'is nothing to redraw.', 'info');
    }
  });

  attachPanelInteraction(panel, i);
  // The annotation layer takes its own pointer events on the shapes only, so this and the
  // canvas handler above cannot contend: a hit lands here, a miss never reaches here.
  bindAnnotationEditing(panel);
  return panel;
}

/**
 * Lay out `cols` x `rows` panels, carrying over what is already loaded.
 *
 * Panels are rebuilt rather than reparented because a WebGL context is bound to its canvas.
 * What survives is the DATA -- the stack, the index, the plane, the segmentation -- which is
 * why a layout change costs no network.
 */
function setLayout(cols, rows, { by = 'reader' } = {}) {
  // WHO ARRANGED THIS SCREEN. A protocol names itself in the rail, and the moment the
  // reader picks a layout the name stops describing what they are looking at. Saying
  // "overridden" rather than clearing the name keeps the answer to "why did it open like
  // that" on screen, which is the question the name exists for.
  if (by === 'reader' && protocolInForce && !protocolOverridden) {
    protocolOverridden = true;
    renderProtocolName();
  }
  const want = cols * rows;
  // WHAT A PANEL IS, carried across the rebuild. Anything missing from this list is reset
  // to a fresh panel's default while the toolbar goes on describing the old one: `slab`
  // and the view transform were both absent, so a reader in a 20 mm MIP who pressed 2x2
  // got an unprojected slice under a lit MIP button, and a flipped panel came back
  // unflipped with the orientation letters still permuted for the flip.
  const carried = panels.map((p) => ({
    stack: p.stack, index: p.index, plane: p.plane, seg: p.seg,
    // `studyUID` TRAVELS WITH THE SERIES OR THE COMPARISON DISSOLVES ON A LAYOUT CHANGE.
    // A reader with a current study beside its prior who presses 2x2 would otherwise get
    // two panels still showing the two studies' pixels and both claiming, to every part of
    // the chrome that asks, to be showing whatever the ACTIVE panel holds.
    seriesUID: p.seriesUID, studyUID: p.studyUID, label: p.label, slab: p.slab,
    window: p.viewport ? { ...p.viewport.window } : null,
    // INVERT AND THE OVERLAY'S ALPHA BELONG HERE TOO, and their absence was older than
    // this list's comment: a fresh `Viewport` starts `invert = false, overlayAlpha =
    // 0.45`, so a layout change gave back a panel whose polarity and overlay differed
    // from what the reader set while the toolbar went on lighting the old answer.
    view: p.viewport
      ? {
        zoom: p.viewport.zoom,
        pan: [...p.viewport.pan],
        transform: p.viewport.transform,
        oneToOne: p.viewport.oneToOne,
        invert: p.viewport.invert,
        overlayAlpha: p.viewport.overlayAlpha,
      }
      : null,
  }));

  // GIVE THE OLD CONTEXTS BACK BEFORE DROPPING THE NODES THAT HOLD THEM.
  //
  // `innerHTML = ''` releases a WebGL context only when the canvas is collected, and the
  // browser caps live contexts long before that happens. Measured on this viewer with the
  // layout buttons alone -- no study, no series, no network: six 2x2 <-> 1x1 cycles left
  // 31 contexts created against ONE canvas on screen, pinned at Chrome's ceiling of 16
  // alive, with 15 of them FORCE-LOST by the browser to make room. A forced loss fires
  // `webglcontextlost` on whichever panel owned it, so the layout button was manufacturing
  // the exact failure the handler above exists to report.
  //
  // `retired` first, then `dispose`: the loss event arrives asynchronously and would
  // otherwise be read as news. See `Viewport.dispose`.
  for (const p of panels) {
    p.retired = true;
    if (p.viewport) p.viewport.dispose();
  }

  el.grid.innerHTML = '';
  // THE SHAPE, not just the count. `panels.length` says six; it does not say whether
  // that is 3x2 or 2x3, and the picker has to open on the cell the reader is actually in.
  layoutCols = cols;
  layoutRows = rows;
  el.grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  el.grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
  panels = [];

  for (let i = 0; i < want; i++) {
    const p = makePanel(i);
    const old = carried[i];
    if (old && old.stack) {
      Object.assign(p, {
        stack: old.stack, index: old.index, plane: old.plane, seg: old.seg,
        seriesUID: old.seriesUID, studyUID: old.studyUID, label: old.label, slab: old.slab,
      });
      if (old.window && p.viewport) p.viewport.setWindow(old.window.center, old.window.width);
      if (old.view && p.viewport) Object.assign(p.viewport, old.view);
    }
    panels.push(p);
    el.grid.appendChild(p.node);
  }

  active = Math.min(active, panels.length - 1);
  for (const b of el.layouts.children) b.classList.toggle('on', b.dataset.layout === `${cols}x${rows}`);
  markActive();
  drawAll();
  // AFTER the draw, because every one of these reads `p.frame` -- which `draw` is what
  // sets. `markActive` only re-marks the plane and invert buttons; the slab, orientation
  // and zoom strips were never rebuilt at all, so they kept whatever they said before the
  // layout changed under them.
  buildSlabButtons();
  buildOrientButtons();
  buildZoomButtons();
  markSeriesAssignment();
  publishPanels('layout');
}

/**
 * Publish the shell's panel array and active index into shared state.
 *
 * WHY THIS HAD TO EXIST BEFORE ANY PANEL COULD BE BELIEVED
 * ----------------------------------------------------------
 * `panels` and `active` are declared here as module locals, and `core/state.js` declares
 * keys of the SAME NAMES. For three commits nothing connected them: no `set({panels})` was
 * ever called, so `segments-panel.js` -- which subscribes to exactly those keys -- would
 * have rendered once at mount, when state.panels was still [], and never again. Its header
 * asserts that a real panel "can live on them without app.js reaching in". It could not:
 * the state it watched was never written, and the module was never even imported.
 *
 * That is the `readout()` defect one level up -- a definition and a call site that nothing
 * ties together -- which is the precise thing `state.js` was introduced to make impossible.
 * Introducing a mechanism is not adopting it, and a header comment is not a measurement.
 *
 * THE COPY IS LOAD-BEARING. `set()` skips a key whose value is identical by reference, and
 * the panel objects are mutated in place (panel.seg, panel.index, panel.plane). Passing
 * `panels` itself would be a silent no-op on every call after the first -- the same dead
 * subscription wearing a different hat. A new array identity per publish is cheap, the
 * array holds at most nine panels, and it is what makes the notification honest.
 */
function publishPanels(origin) {
  setState({ panels: [...panels], active }, origin);
}

function markActive() {
  panels.forEach((p, i) => p.node.classList.toggle('active', i === active && panels.length > 1));
  syncToolbarToActive();
}

function setActive(i) {
  if (i === active) return;
  active = i;
  markActive();
  buildPlaneButtons();
  buildSlabButtons();
  buildOrientButtons();
  buildZoomButtons();
  buildObliqueButtons();
  // AN ARMED TOOL BELONGS TO A PANEL. Its handlers close over the one that was active when
  // it was armed, so after this point `pixelAt(panel, event)` would resolve a click on the
  // NEW panel against the OLD panel's viewport, and `draw` -- which shows the preview on
  // whichever panel is active -- would draw a half-placed measurement over a different
  // series entirely. Re-arming rebinds the handlers and discards the partial state, which
  // leaves the tool armed where the reader is now working.
  if (armed) armTool(armed.tool);
  renderFooterTech(panels[active]);
  // AND THE CHROME FOLLOWS THE PANEL. The banner names a patient and a study; the left
  // rail lists one study's series. Clicking from a current study to its prior changes
  // which study those two are about, and a banner left behind is not a stale label -- it
  // is the wrong study's identifiers over the right study's picture.
  syncChromeToActiveStudy();
  syncToggles();
  publishPanels('set-active');
}

/* ----------------------------------------------------------------------------------
 * drawing
 * -------------------------------------------------------------------------------- */

/**
 * Every other panel's plane, as a line across THIS panel's image.
 *
 * AT MODULE SCOPE, not inside `draw`, and that is not tidying. It was declared inside
 * `draw` -- at column zero, which reads like a top-level function and is not one -- so it
 * was visible to exactly one caller. `drawOverlays` needs it too: a reference line is a
 * statement about a panel OTHER than the one it is drawn on, so it goes stale when that
 * other panel moves, and refreshing it must not mean re-running `reslice` on a volume that
 * did not change. The first attempt at that called this from module scope and threw
 * `ReferenceError: referencesOnto is not defined` on every plane change.
 */
function referencesOnto(target, targetFrame) {
  if (!showReferences || panels.length < 2) return [];
  const lines = [];
  for (const other of panels) {
    if (other === target || !other.stack || !other.frame) continue;
    const line = referenceLine(other.frame, targetFrame);
    // THE SOURCE PLANE, NAMED. This was `other.plane` -- the address -- so on a spine MR
    // every sagittal carried a dashed line labelled 'axial' pointing at a panel whose own
    // HUD said 'as encoded'. Two labels for one panel, disagreeing, three inches apart.
    // Falls back to the address only when the geometry cannot name it, which is the one
    // case where an address is more informative than nothing.
    const word = planeWording(other.stack, other.plane) || other.plane;
    if (line) lines.push({ ...line, label: word });
  }
  return lines;
}

function draw(p) {
  if (!p.stack || !p.viewport) { p.hud.empty.hidden = false; return; }

  // A PANEL WITH NO CONTEXT HAS NOTHING TO DRAW WITH, and the wheel does not know that.
  //
  // BEFORE THE LINE BELOW, NOT AFTER IT. `p.hud.empty.hidden = true` used to run first, so
  // the next redraw of a panel whose context had gone -- one wheel notch, one window
  // resize through `drawAll`, one measurement added, or the next cine tick 60 ms later --
  // took down the only sentence on the panel saying why it was blank, and then returned
  // without drawing. What was left was a black rectangle with no picture, no caption and
  // no reason.
  if (p.contextLost) return;

  p.hud.empty.hidden = true;

  const depth = planeDepth(p.stack, p.plane);
  p.index = Math.max(0, Math.min(depth - 1, p.index));

  // A REFUSAL MUST NOT LEAVE THE LAST PICTURE ON SCREEN. Every reachable refusal is
  // guarded before the control that would reach it, so this should never fire -- but
  // `draw` had no try at all, and an uncaught throw here leaves the canvas holding the
  // PREVIOUS plane's pixels while the HUD, the letters and the toolbar all describe the
  // new one. A picture of one plane labelled as another is the worst shape a refusal can
  // fail in, and "should never fire" is what was said about the two guards that were
  // missing.
  let frame;
  try {
    frame = reslice(p.stack, p.plane, p.index, p.seg, p.slab);
  } catch (err) {
    p.frame = null;
    p.viewport.setFrame(null);
    // AND EVERYTHING THE HUD SAID ABOUT THE FRAME THAT IS NOT THERE. This path cleared the
    // picture and left the caption: measured, a refused projection kept the new series'
    // name in the label corner and the `PROJECTION` chip beside it, over a black canvas.
    blankHud(p);
    p.hud.empty.textContent = String(err.message || err);
    p.hud.empty.hidden = false;
    notice(String(err.message || err), 'err');
    return;
  }
  p.frame = frame;

  // ONE layout read for everything below that needs the panel's size. Two calls to
  // getBoundingClientRect in one draw is two chances to be answered from different
  // layouts, and the scale bar, the annotations and the zoom must agree about how wide
  // the picture is or a caliper stops matching the bar beside it.
  const rect = p.canvas.getBoundingClientRect();

  // 1:1 IS RE-DERIVED HERE, from the size the panel actually has this frame -- BEFORE the
  // render and before the readout, so the picture and the percentage beside it are the
  // same zoom. Computed after either, the HUD reported 100% over a picture drawn at 56%.
  //
  // The refusal is re-derived with it: switching from an axial to a coronal changes the
  // pixel spacing, and a mode that survived that would be claiming one image pixel per
  // screen pixel on a plane where that cannot be true in both directions.
  if (p.viewport.oneToOne) {
    // `deviceSize()`, not `canvas.width`. The backing store is resized inside render(),
    // which runs BELOW this, so on a resize frame `canvas.width` is still the previous
    // size -- 1280 while the panel is already 1920 -- and the zoom came out 1.5x too
    // large with the control still lit.
    const exact = zoomForOneToOne(frame, { width: rect.width, height: rect.height },
      p.viewport.deviceSize(), viewOf(p.viewport));
    if (exact) p.viewport.zoom = exact;
    else p.viewport.oneToOne = false;
  }

  p.viewport.setFrame(frame);
  if (p.seg) {
    p.viewport.setOverlay(frame.overlay || new Uint8Array(frame.rows * frame.columns),
      frame.columns, frame.rows);
  } else {
    p.viewport.setOverlay(null);
  }
  // BEFORE THE RENDER AND BEFORE THE HUD. `applyFusion` fills `p._fusionSampled`, which
  // `fusionMark` reads to say what fraction of this frame the overlaid series reaches --
  // so calling it after the caption would caption the PREVIOUS slice's coverage.
  if (p.fusion) applyFusion(p, frame);
  else p.viewport.setFusion(null);
  p.viewport.render();

  const mm = planeStepMm(p.stack, p.plane);
  // A ONE-FRAME SERIES HAS NO SLICE PITCH TO PRINT. `spacingOf` stands 1 mm in so the
  // arithmetic stays finite; printing it as "1.00 mm" states a distance nothing
  // measured, on the same line as one that was.
  const stepText = p.plane === PLANES.AXIAL && p.stack.hasSliceSpacing === false
    ? 'slice pitch not recorded'
    : `${mm.toFixed(2)} mm`;

  p.hud.tl.innerHTML = p.label + studyMark(p) + fusionMark(p, frame);
  p.hud.tr.textContent = `W ${Math.round(p.viewport.window.width)}  L ${Math.round(p.viewport.window.center)}`;
  // A PROJECTION IS NOT A SLICE, and the difference is invisible in the picture.
  //
  // A 26 mm MIP of this project's phantom shows a nodule that the slice under the cursor
  // does not contain. Every number the reader takes off it -- the slice position, an ROI
  // mean, a density they compare against a threshold -- is about a ray rather than about
  // that plane. The counter is therefore REPLACED rather than appended to: "20 / 64" is a
  // true statement about a slice and a false one about a slab, so while a slab is on, the
  // panel does not offer it.
  // An overlay is NOT projected with the pixels (see `reslice`): the contour belongs to one
  // plane and the greys belong to the whole slab, so a contour that does not sit on the
  // density it appears to outline is the expected result rather than a mis-registration.
  // Said here, beside the picture, and not on every measurement row.
  //
  // Only while the overlay is actually DRAWN. `reslice` records that a segmentation exists
  // beside the projection; whether the reader can see it is this surface's business, and a
  // caveat about a contour that is hidden sends them looking for one that is not there.
  const overlayNote = frame.projection && frame.projection.overlayIsCentrePlane
    && p.viewport.overlayAlpha > 0
    ? '   ·   overlay: centre plane only' : '';
  // AND WHAT THE PLANE RESOLVES, when that is not what it is drawn at. Empty on every
  // named plane, so this line is unchanged everywhere it was already right.
  const resolved = resolutionNote(frame);
  // NAMED FROM THE GEOMETRY, and OMITTED rather than guessed. A slice counter with no
  // plane word in front of it tells the reader less; one with the wrong word tells them
  // something false, and the orientation letters two corners away will contradict it.
  const word = planeWording(p.stack, p.plane);
  const planeWord = word ? `${word}  ` : '';
  p.hud.br.textContent = frame.projection
    ? `${planeWord}${frame.projection.mode} over ${frame.projection.mm.toFixed(1)} mm `
      + `(${frame.projection.slices} slices, centred ${p.index + 1} / ${depth})`
      + `${overlayNote}${resolved}   ·   ${Math.round(p.viewport.zoom * 100)}%`
    : `${planeWord}${p.index + 1} / ${depth}   ·   ${stepText}${resolved}   ·   ${Math.round(p.viewport.zoom * 100)}%`;
  // And a standing marker, because the bottom-right line is where a reader looks for the
  // slice number rather than for a warning about what the picture is.
  p.hud.tl.classList.toggle('projecting', Boolean(frame.projection));

  /*
   * WHAT THE CANVAS IS, IN WORDS.
   *
   * The primary content of this application was a canvas with no name, no role and no
   * fallback text, so a screen reader announced NOTHING for the whole of it -- WCAG
   * 1.1.1, on the one element the entire surface exists to show.
   *
   * IT DOES NOT DESCRIBE THE IMAGE, and must not. A sentence about what is visible in
   * the pixels would be a finding, and MOS-UI-204 forbids this surface to author one.
   * What it says is WHICH PICTURE THIS IS: the series, the plane and where in the stack
   * the reader is standing -- the same three facts the HUD prints, read off the same
   * variables, so the two cannot drift apart.
   *
   * `p.label` is HTML (it carries the patient's second line), so the tags come out; the
   * text inside them is the archive's own and is not translated.
   */
  const spoken = [
    // `p.label` is two lines of HTML -- the series description, a <br>, the patient's
    // name. A tag becomes a comma rather than a space, or the two run together into one
    // phrase: "... one 8 mm nodule PHANTOM^SYNTHETIC^NOT^A^PATIENT".
    String(p.label).replace(/<[^>]*>/g, ', ').replace(/\s+/g, ' ')
      .replace(/(,\s*)+/g, ', ').replace(/^[,\s]+|[,\s]+$/g, ''),
    word,
    `${p.index + 1} / ${depth}`,
  ].filter(Boolean).join(', ');
  p.canvas.setAttribute('aria-label', spoken);
  p.node.setAttribute('aria-label', spoken);

  // SAID OUT LOUD ONLY WHILE THE KEYBOARD IS DRIVING THIS PANEL. Announcing every wheel
  // notch would drown a reader; announcing nothing leaves an arrow key with no feedback.
  if (p.node.contains(document.activeElement)) announce(spoken);

  // WHICH WAY THE PATIENT IS. Derived from this frame's own (0020,0037), so a coronal
  // reports the coronal's edges rather than the source axial's -- `reconstructedGeometry`
  // supplies the reconstructed plane's orientation for exactly this reason.
  //
  // When the header does not state one, the absence is SHOWN. A blank edge is
  // indistinguishable from a viewer that has no markers, which is what this one was until
  // now; `orientation not recorded` sends the reader to the header instead.
  const letters = screenEdges(edgeLetters(frame), p.viewport.transform);
  for (const side of ['top', 'bottom', 'left', 'right']) {
    const node = p.hud.edges[side];
    // The sentence goes on ONE edge. Four copies of "orientation not recorded" around the
    // picture is a wall of text saying one thing; the other three stay empty, which is
    // what they honestly are.
    node.textContent = letters ? letters[side] : (side === 'top' ? 'orientation not recorded' : '');
    node.classList.toggle('unknown', !letters);
  }

/**
 * Where every OTHER panel's current slice cuts this one.
 *
 * Only across panels, never within one: a plane does not usefully reference itself, and an
 * axial referencing its own axial is a line along nothing.
 *
 * `referenceLine` returns null unless the two frames share a (0020,0052) Frame of Reference
 * UID, so two series from different acquisitions simply produce no lines rather than
 * plausible ones in the wrong place. That silence is the correct output, and it is why the
 * toggle below reports how many panels are comparable instead of assuming they all are.
 */

  // THE SCALE BAR, from the same geometry the caliper uses. Hidden rather than guessed at
  // when the canvas is mid-layout and has no fit -- a bar drawn from a fallback is still a
  // statement about size, and the reader uses it to size a finding they will report.
  const bar = scaleBarOf(frame, { width: rect.width, height: rect.height }, viewOf(p.viewport));
  // A FRAME THAT NEVER STATED (0028,0030) GETS THE SENTENCE, not a blank corner. Hiding the
  // bar would make "this series did not say how big its pixels are" look identical to
  // "this viewer has no scale bar" -- the same reason an absent orientation is rendered
  // rather than omitted.
  const noScale = frame.hasPixelSpacing === false;
  p.hud.scale.hidden = !bar && !noScale;
  p.hud.scale.classList.toggle('unknown', noScale);
  if (bar) {
    p.hud.scaleLine.style.width = `${bar.px.toFixed(1)}px`;
    p.hud.scaleMm.textContent = bar.mm < 1 ? `${bar.mm} mm` : `${bar.mm.toFixed(0)} mm`;
  } else if (noScale) {
    p.hud.scaleLine.style.width = '0px';
    p.hud.scaleMm.textContent = 'pixel spacing not recorded';
  }

  // The annotation layer is redrawn from the SAME frame and view the image just used,
  // so a caliper cannot lag the slice it belongs to by a frame.
  if (p.annotations) {
    p.annotations.render(
      drawableMeasurements(), p === panels[active] ? preview : null, frame,
      { width: rect.width, height: rect.height },
      viewOf(p.viewport),
      { plane: p.plane, index: p.index, seriesUID: p.seriesUID },
      referencesOnto(p, frame),
      selectedId(),
      crosshairFor(p, frame),
    );
  }

  // The footer describes what is ON SCREEN, so it is written by the draw that produced it
  // and only for the panel the reader is working in.
  if (p === panels[active]) renderFooterTech(p);

  const track = p.hud.bar.clientHeight;
  const h = Math.max(12, track / depth);
  p.hud.thumb.style.height = `${h}px`;
  p.hud.thumb.style.top = `${(p.index / Math.max(depth - 1, 1)) * (track - h)}px`;
}

/**
 * The link badge and the mode behind it, written together or not at all.
 *
 * THEY WERE WRITTEN IN THREE PLACES AND THE MODE IN ONE. `propagate` set both; `setCursor`
 * -- the manual Align path -- wrote the badge and left `_linkMode` holding whatever the
 * last propagation had decided; `setIndex` hides the badge on the panel being scrolled and
 * left the mode standing. So the thing `crosshairFor` suppresses and the thing the reader
 * is shown could disagree, which is exactly what the comment there said could not happen.
 */
function showLink(p, mode, info) {
  const badge = linkBadge(mode);
  p._linkMode = badge ? mode : null;
  p.hud.badge.hidden = !badge;
  if (!badge) return;
  p.hud.badge.textContent = badge.text;
  p.hud.badge.className = `link-badge ${badge.kind}`;
  p.hud.badge.title = describeLink(mode, info || {});
}

function hideLink(p) {
  p._linkMode = null;
  p.hud.badge.hidden = true;
}

/**
 * The crosshair for this panel, minus an absence the badge beside it already states.
 *
 * TWO REASONS COME BACK FROM `crosshairOn`, AND ONLY ONE OF THEM IS A DUPLICATE.
 * `ABSENT.FRAME_OF_REFERENCE` is the same fact as the `not linked` badge, whose own
 * tooltip says it at greater length; `ABSENT.NO_PIXEL_SPACING` is not, and nothing else on
 * the panel reports it.
 *
 * THE BADGE READING `none` IS NOT THE TEST, and using it as one was wrong. `LINK.NONE`
 * covers four situations and two of them -- slices along different axes, no usable step --
 * arise between series that DO share a coordinate system, where an absent crosshair is
 * absent for the OTHER reason. Suppressing there would replace a true explanation with a
 * true explanation of something else.
 *
 * So the duplicate is dropped and the other is kept. `sync.js` writes that absence is
 * REPORTED rather than returned as null, because a missing crosshair is indistinguishable
 * from a viewer that has not drawn one -- that argument is satisfied here by the badge,
 * which is on screen, says the same thing, and does not lie across the scale bar to do it.
 */
function crosshairFor(p, frame) {
  const cross = crosshairOn(p.stack, frame, p.plane, getState().cursor);
  if (!cross || !cross.absent) return cross;
  if (cross.because !== ABSENT.FRAME_OF_REFERENCE) return cross;
  // AND ONLY WHEN THE BADGE IS ACTUALLY ON SCREEN SAYING IT. `_linkMode` is non-null only
  // while a badge is shown, because `showLink`/`hideLink` write the two together -- which
  // they did not until a review found three badge writers and one mode writer.
  const badge = linkBadge(p._linkMode);
  return badge && badge.kind === 'none' ? null : cross;
}

function drawAll() { for (const p of panels) draw(p); }

/* ----------------------------------------------------------------------------------
 * the link
 * -------------------------------------------------------------------------------- */

/**
 * Move `source` to `index`, then move every other loaded panel to follow it.
 *
 * `sync.js` decides HOW each target follows and hands back the mode. The badge reports it,
 * because "linked by patient position" and "linked by proportion" are different promises and
 * one lock icon for both would overstate the weaker one.
 */
/**
 * Re-render one panel's annotation layer without rebuilding its image.
 *
 * WHY THIS IS SEPARATE FROM `draw`. A reference line is a statement about ANOTHER panel --
 * where that panel's plane cuts this one -- so it goes stale whenever the other panel
 * moves, and this panel has no reason of its own to redraw. `draw` would also re-run
 * `reslice`, which on a coronal of a 320-slice volume is real work to redo for a line that
 * moved a few pixels.
 *
 * `p.frame` is the frame the image on screen was built from, so the overlay stays in
 * lockstep with the pixels underneath it rather than being drawn against a newer geometry
 * than the picture it sits on.
 */
/**
 * Empty a panel: no series, no picture, no badge, no annotations.
 *
 * WHY A STUDY NEEDS THIS. `openStudy` fills one panel per IMAGE SERIES and leaves the rest
 * alone, so opening a single-series study into a 1x2 layout left the second panel showing
 * whatever it held before -- a series from the PREVIOUS STUDY, under the new study's series
 * list, with the previous study's link badge still beside it.
 *
 * MEASURED, opening a real LCTSC thorax CT while the demo phantom was still on screen:
 *
 *     panel A   CT114545:RespCT 3.0 B30f 50% Ex     LCTSC-Test-S1-102     148 slices
 *     panel B   Synthetic thorax, companion         PHANTOM^SYNTHETIC      40 slices
 *     badge     "position-linked"  -  "linked by patient position (nearest slice 1.0 mm away)"
 *
 * Two different patients side by side, one of them from a study the reader had navigated
 * away from, carrying the strongest correspondence claim this surface can make. The badge
 * was stale rather than wrong -- `followIndex` answers "different frame of reference" the
 * moment anything recomputes it -- which is worse, because nothing recomputes it until the
 * reader scrolls, and by then they have already read it.
 */
/**
 * Everything the HUD says about a picture, taken back.
 *
 * TWO PATHS LEAD HERE AND BOTH USED TO DO THIS BY HAND. `clearPanel` emptied the four
 * corners when a study left a panel unfilled; the refusal handler in `draw` emptied
 * nothing at all. The second one is the one that showed: a panel whose `reslice` was
 * refused kept the NEW series' name in the label corner, over a canvas with no frame.
 *
 * THE PROJECTION CHIP IS A CLASS, NOT TEXT, which is why emptying the corner never took it
 * with it: `.hud-tl.projecting::after` draws it from the element itself. Measured -- a
 * panel carrying a 20 mm slab, handed a series whose slice spacing is not uniform, showed
 * `projection_needs_uniform_spacing: ...` in the middle and `PROJECTION` beside a series
 * name, with nothing drawn. A standing claim about a picture that is not there.
 *
 * The comment over that handler already had the rule -- "A REFUSAL MUST NOT LEAVE THE LAST
 * PICTURE ON SCREEN" -- and a caption is the other half of the picture.
 */
function blankHud(p) {
  p.hud.tl.innerHTML = '';
  p.hud.tl.classList.remove('projecting');
  p.hud.tr.textContent = '';
  p.hud.bl.textContent = '';
  p.hud.br.textContent = '';
  p.hud.scale.hidden = true;
  hideLink(p);
  for (const side of Object.keys(p.hud.edges)) p.hud.edges[side].textContent = '';
  // AND THE OVERLAY, because a caliper drawn over a frame that was refused is a
  // measurement floating on nothing. The next successful draw puts them back.
  if (p.annotations) p.annotations.clear();
  // AND THE ONE A READER NEVER SEES. `draw` writes the canvas's accessible name from the
  // same numbers the HUD prints, so a screen reader went on announcing the series, the
  // plane and the slice of a picture that had been taken down.
  if (p.canvas) p.canvas.setAttribute('aria-label', 'No series loaded');
  // AND THE FOOTER, which describes the ACTIVE panel: `renderFooterTech` is called at the
  // end of `draw`, which a refusal and a lost context both return before reaching.
  if (p === panels[active] && el.footTech) el.footTech.textContent = '';
}

function clearPanel(p, why) {
  const pending = inFlight.get(p);
  if (pending) { pending.abort(); inFlight.delete(p); }
  p.stack = null;
  p.frame = null;
  // THE LINK IS A FACT ABOUT THIS PAIR ON THIS SERIES, and both are going.
  p._linkMode = null;
  p.seg = null;
  // AND THE SERIES LAID OVER IT. A cleared panel that kept its fusion would hold a
  // retrieved volume and a resampling of a frame that no longer exists, and the next
  // draw would caption the new series with the old one's coverage.
  p.fusion = null;
  p._fusionAt = null;
  p._fusionSampled = null;
  p._fusionError = null;
  p.seriesUID = null;
  // AND WHICH STUDY IT WAS. A cleared panel that still names a study is worse than one
  // that names none: the rail, the banner and an exported caption all ask the active panel
  // this question, and an empty panel answering with the study it used to hold is how a
  // prior's identifiers end up over a current study's picture.
  p.studyUID = null;
  p.label = '';
  p.index = 0;
  p.slab = null;
  p._anchor = null;
  if (p.viewport) p.viewport.setFrame(null);
  // THE LABELS TOO, and this is the half that was missed the first time. `draw` writes the
  // series name, the window, the slice counter, the orientation letters and the scale bar,
  // and `draw` returns early for a panel with no stack -- so clearing the STATE left every
  // one of those still reading the study the reader had navigated away from. The picture
  // went black and the caption stayed, which is a caption for a picture that is not there.
  blankHud(p);

  p.hud.empty.textContent = why;
  p.hud.empty.hidden = false;
}

/**
 * The measurements the IMAGE may draw, which is not the same list as the panel shows.
 *
 * ONE DEFINITION, because there are two render call sites and the first fix only changed
 * one of them: `drawOverlays` filtered, the draw-that-follows-the-image did not, and a
 * hidden measurement reappeared the moment anything redrew the frame. A reader hid a
 * caliper, drew the next one, and the hidden one came back.
 *
 * Hiding is a property of the READER'S VIEW: `getState().measurements` stays whole, so the
 * panel still lists a hidden measurement and the CSV still exports it. It was still taken.
 */
function drawableMeasurements() {
  const hidden = new Set(getState().hiddenMeasurements || []);
  return hidden.size ? getState().measurements.filter((m) => !hidden.has(m.id))
    : getState().measurements;
}

function drawOverlays(p) {
  if (!p.annotations || !p.frame || !p.stack) return;
  const rect = p.canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  p.annotations.render(
    drawableMeasurements(),
    p === panels[active] ? preview : null, p.frame,
    { width: rect.width, height: rect.height },
    viewOf(p.viewport),
    { plane: p.plane, index: p.index, seriesUID: p.seriesUID },
    referencesOnto(p, p.frame),
    selectedId(),
    crosshairFor(p, p.frame),
  );
}

function setIndex(source, index, propagate = true) {
  // A PARTIAL MEASUREMENT DOES NOT SURVIVE THE SLICE MOVING UNDER IT.
  //
  // `angleTool` is the first gesture in this viewer that spans arbitrary time: three
  // discrete clicks with the tool armed throughout, so scrolling between them is an
  // ordinary thing to do rather than a contrivance. Nothing stopped it. The points already
  // placed stayed, the preview kept drawing them over the NEW slice -- `annotations.js`
  // filters committed measurements by slice and draws the preview unfiltered -- and the
  // reader placed the vertex against anatomy the first ray was never measured on. An angle
  // is a planar measurement of one slice; three points spread over two slices are not a
  // worse measurement, they are not a measurement.
  //
  // So the partial state is discarded and the tool stays armed, which leaves the reader
  // able to start again on the slice they are now looking at. The live address above then
  // files whatever they draw where they drew it.
  if (armed && armed.panel === source && index !== source.index) {
    armed.handlers.onCancel();
    preview = null;
  }
  source.index = index;
  draw(source);

  // SCROLLING SLIDES THE CURSOR ALONG THIS PLANE'S NORMAL and leaves the other two axes
  // alone. Rebuilding it from the new slice's ORIGIN would drag it sideways as well -- an
  // origin is a corner of the image, not where the reader is looking -- so it moves by the
  // ordinate difference, which is exact and accumulates nothing.
  if (source.stack && source.frame) {
    const slid = slideCursor(getState().cursor, source.stack, source.plane, index, source.frame);
    if (slid && slid !== getState().cursor) setState({ cursor: slid }, 'cursor');
  }
  // The panel being scrolled is the REFERENCE, not a follower: it carries no badge. Without
  // this it keeps whatever badge it was given while some other panel was active.
  hideLink(source);

  // EVERY OTHER PANEL'S REFERENCE LINE JUST MOVED, whether or not that panel follows this
  // one. A panel was redrawn only when it CHANGED SLICE, so a panel that cannot follow --
  // an axial beside a coronal, which do not link because neither is a slice of the other --
  // was never redrawn at all and never drew a reference line in its life. That is the
  // locator `followIndex`'s own refusal points the reader at: "neither one of them is a
  // slice of the other -- the reference line shows where they cross". It was a promise the
  // surface did not keep.
  //
  // NOT GATED ON `link.scroll`. That switch is about whether panels FOLLOW each other; a
  // reference line is geometry, and where two planes cross does not depend on a preference.
  for (const t of panels) if (t !== source && t.stack) drawOverlays(t);

  if (!propagate || !link.scroll || !source.stack) return;

  for (const t of panels) {
    if (t === source || !t.stack) continue;
    const anchor = t._anchor && t._anchor.from === source ? t._anchor : null;
    const r = followIndex(source.stack, source.index, source.plane, t.stack, t.plane, anchor);

    // A NULL index means the panel MUST NOT MOVE. The first version mapped the two stacks
    // proportionally here, which asserts they cover the same extent -- false for a chest CT
    // beside a chest-and-abdomen CT, and invisible once both panels are scrolling.
    if (r.index !== null) { t.index = r.index; draw(t); }

    // THE MODE IS A FACT ABOUT THE PAIR, kept on the panel rather than read back out of
    // the badge. `crosshairFor` needs it during `draw(t)` above, which runs BEFORE the
    // badge below is written -- asking the DOM there is asking about the previous frame.
    showLink(t, r.mode, r);
    // THE PANEL THAT MUST NOT MOVE IS THE ONE NOBODY REDRAWS. `r.index === null` means
    // exactly that -- do not scroll this one -- so the `draw(t)` above is skipped, and the
    // overlay it drew before the link was ever evaluated stays on screen. Its pixels have
    // not changed and are not redrawn; this is the SVG layer only.
    if (r.index === null) drawOverlays(t);
  }

  // AND THIS PANEL'S OWN, because the followers have moved since it was drawn: a coronal
  // that followed to a new row crosses this axial somewhere new, and the line saying where
  // was drawn before the move.
  drawOverlays(source);
}

/**
 * The reader's own assertion of correspondence.
 *
 * RadiAnt's manual synchronisation: scroll the panels to the same anatomy, then say "here".
 * Its authority is the reader, not a header -- which is exactly why it is a button they
 * press rather than something the platform infers, and why the badge it produces reads
 * "the platform did not verify this correspondence".
 */
function alignPanels() {
  const source = panels[active];
  if (!source || !source.stack) return;
  let n = 0;
  for (const t of panels) {
    if (t === source || !t.stack) continue;
    t._anchor = { from: source, source: source.index, target: t.index };
    n++;
  }
  notice(n ? `aligned ${n} panel(s) at the current slice; they now follow by that offset` : '');
  setIndex(source, source.index);
}

function applyWindowFrom(source) {
  if (!link.window) return;
  for (const t of panels) {
    if (t === source || !t.stack || !t.viewport) continue;
    t.viewport.setWindow(source.viewport.window.center, source.viewport.window.width);
    draw(t);
  }
}

function applyViewFrom(source) {
  if (!link.zoomPan) return;
  for (const t of panels) {
    if (t === source || !t.stack || !t.viewport) continue;
    t.viewport.zoom = source.viewport.zoom;
    t.viewport.pan = [...source.viewport.pan];
    // AND THE MODE, or the copy does not survive the draw. `draw` re-derives 1:1 from the
    // target's own geometry, so a linked panel still in that mode overwrote the zoom it
    // was just handed and went on showing a different magnification -- while the control
    // said the panels were linked. Linking means the panels show the same zoom; a target
    // that keeps deriving its own is not linked to anything.
    t.viewport.oneToOne = false;
    draw(t);
  }
}

/* ----------------------------------------------------------------------------------
 * study list
 * -------------------------------------------------------------------------------- */

/** How many rows a page of the worklist holds. */
const WORKLIST_PAGE = 50;

/** Where in the result set the worklist is, and how it is ordered. */
let worklistOffset = 0;
let worklistSort = { by: 'date', desc: true };
let worklistRows = [];
let worklistMore = false;
let worklistQuery = 0;

/** The study the reader last opened, so coming back lands on it rather than on row one. */
let worklistSeen = '';

// WHICH STUDIES ARE OPEN, AND WHAT THEIR SERIES QUERY RETURNED.
//
// Expansion state is the READER'S, not the archive's: it survives a re-sort and a
// re-filter of the rows already on screen, and it is dropped when the query changes,
// because a study that is no longer in the result set has no row to expand.
//
// `seriesByStudy` is a cache with a purpose beyond speed: `openStudy` reads it, so
// expanding a study and then opening it costs ONE series query rather than two, and
// the sub-table the reader just read is the same list the viewer opens from.
const worklistExpanded = new Set();
const seriesByStudy = new Map();
const SERIES_CACHE_MAX = 200;

/**
 * The series of one study, in the order a reader expects them.
 *
 * BY SeriesNumber, which is what a series IS ordered by. This used to sort on (0020,1209),
 * the INSTANCE COUNT, so the thin axial came before the scout and the order changed with
 * reconstruction thickness.
 *
 * It lives here, as a function of a study UID, because the surface now holds more than one
 * study at a time. `seriesIndex` was a single module variable written by `openStudy`, and
 * every reader of it -- the rail, the banner, the auto-layout, the capture caption, the
 * CSV -- was therefore asking about "the study", singular. With a prior open beside a
 * current study that question has two answers and the caller has to say which it means.
 */
function studyRows(uid) {
  if (!uid) return [];
  const held = seriesByStudy.get(uid);
  if (!held || held.state !== 'ready' || !held.rows) return [];
  return held.rows.slice().sort((a, b) => {
    const na = Number(dv(a, '00200011', Number.MAX_SAFE_INTEGER));
    const nb = Number(dv(b, '00200011', Number.MAX_SAFE_INTEGER));
    if (na !== nb) return na - nb;
    return String(dv(a, '0020000E')).localeCompare(String(dv(b, '0020000E')));
  });
}

/* ----------------------------------------------------------------------------------
 * fusion -- a second acquisition laid over the one on screen
 *
 * The resampling, and the argument for doing it here where `seg.js` refuses to, are in
 * `src/image/fusion.js`. This half is about WHICH series and WHAT IT SAYS.
 * -------------------------------------------------------------------------------- */

/** How much of the fused series shows at its brightest. A ceiling, not the drawn alpha. */
const FUSION_ALPHA = 0.7;

/**
 * The one series that can be laid over this panel, or why there is not one.
 *
 * A DIFFERENT MODALITY, SHARING A FRAME OF REFERENCE. Those two conditions are the whole
 * rule and neither is arbitrary: laying a series over ITSELF, or over the other
 * reconstruction of its own acquisition, is a picture of nothing; and two series that do
 * not assert a shared coordinate system cannot be positioned on each other at all.
 *
 * AMBIGUITY IS REFUSED RATHER THAN RESOLVED. With two candidates this could pick the
 * first, and would be picking WHICH MEASUREMENT the reader is shown by sort order. The
 * refusal names them instead.
 */
function fusionCandidate(p) {
  if (!p || !p.stack || !p.studyUID) return { error: 'fusion_no_target' };
  const here = String(p.stack.frameOfReferenceUID || '');
  const mine = String(p.stack.modality || '');
  const rows = studyRows(p.studyUID).filter((s) => {
    const uid = dv(s, '0020000E');
    if (uid === p.seriesUID) return false;
    return ['CT', 'MR', 'PT'].includes(dv(s, '00080060'))
      && String(dv(s, '00080060', '')) !== mine;
  });
  if (!rows.length) {
    return {
      error: 'fusion_none',
      message: t('fusion.none',
        'This study carries no other series of a different modality to lay over this one.'),
    };
  }
  if (rows.length > 1) {
    return {
      error: 'fusion_ambiguous',
      message: t('fusion.ambiguous',
        'More than one series could be laid over this panel: {names}. Open the one you '
        + 'want in another panel and fuse from there, rather than having sort order '
        + 'decide which measurement you are shown.')
        .replace('{names}', rows.map((s) => dv(s, '0008103E', '?')).join(', ')),
    };
  }
  return { row: rows[0], seriesUID: dv(rows[0], '0020000E'), here };
}

/**
 * Turn fusion on or off for the active panel.
 *
 * THE SECOND SERIES IS RETRIEVED, which is why this is async and why it says so: a reader
 * pressing F on a 32-slice PET waits for a retrieval, and a button that appears to do
 * nothing for two seconds is a button they press again.
 */
async function setFusion(on) {
  const p = panels[active];
  if (!p) return;
  if (!on) {
    p.fusion = null;
    p._fusionAt = null;
    if (p.viewport) p.viewport.setFusion(null);
    draw(p);
    syncToggles();
    return;
  }

  const pick = fusionCandidate(p);
  if (pick.error) {
    notice(pick.message || t('fusion.unavailable',
      'There is nothing to lay over this panel.'), 'err');
    syncToggles();
    return;
  }

  notice(t('fusion.loading', 'Retrieving the series to lay over…'), 'info');
  let stack;
  try {
    const { instances } = await client.retrieveSeries(p.studyUID, pick.seriesUID);
    stack = buildStack(instances);
  } catch (err) {
    notice(describe(err), 'err');
    syncToggles();
    return;
  }

  p.fusion = {
    stack,
    seriesUID: pick.seriesUID,
    label: String(dv(pick.row, '0008103E', pick.seriesUID)),
    modality: String(dv(pick.row, '00080060', '')),
  };
  p._fusionAt = null;
  notice('');
  draw(p);
  syncToggles();
}

/**
 * Resample the fused series onto the frame now on screen, and hand it to the viewport.
 *
 * CACHED ON THE ADDRESS OF THE FRAME. The resampling is 143360 trilinear samples on a
 * 320x448 CT, which is a few milliseconds -- cheap once and not cheap on every window
 * drag, and a window drag changes no geometry at all.
 */
function applyFusion(p, frame) {
  if (!p.fusion || !frame) return null;
  const at = `${p.plane}|${p.index}|${p.slab ? p.slab.mm : 0}|${frame.columns}x${frame.rows}`;
  if (p._fusionAt !== at) {
    try {
      p._fusionSampled = resampleOnto(p.fusion.stack, frame);
      p._fusionAt = at;
      p._fusionError = null;
    } catch (err) {
      p._fusionSampled = null;
      p._fusionAt = at;
      p._fusionError = describe(err);
    }
  }
  if (!p._fusionSampled) return null;
  p.viewport.setFusion(p._fusionSampled, p.fusion.stack.defaultWindow, FUSION_ALPHA);
  return p._fusionSampled;
}

/**
 * What the panel says when a second acquisition is drawn through it.
 *
 * IT SAYS THREE THINGS AND EACH ONE IS A DEBT BEING PAID.
 *
 *   WHICH SERIES, because a coloured picture whose source is not named is a picture the
 *   reader cannot check. It is the same reason the panel label names the series at all.
 *
 *   THAT THE VALUES ARE RESAMPLED. `seg.js` REFUSES to resample and says why -- "moving
 *   boundaries without saying so". This module does resample, because PET and CT are
 *   never on one grid and refusing would be refusing the modality pair; the price of
 *   doing it is saying it, in the place the reader is looking.
 *
 *   THAT THE NUMBERS UNDERNEATH ARE STILL THE BASE SERIES'. The cursor readout, every
 *   ROI and every caliper read `frame.pixels`, which is the acquisition this panel is OF.
 *   An ROI drawn over the uptake reports Hounsfield units of the CT beneath it, and
 *   NOTHING ABOUT THE PICTURE SUGGESTS THAT -- the bright thing the reader is measuring
 *   is the thing that is not being measured. That sentence is why this mark exists.
 */
function fusionMark(p, frame) {
  if (!p || !p.fusion) return '';
  if (p._fusionError) {
    return `<br><span class="hud-fusion err">${escape(p._fusionError)}</span>`;
  }
  const sampled = p._fusionSampled;
  if (!sampled) return '';
  const name = escape(`${p.fusion.modality} ${p.fusion.label}`.trim());
  // OUTSIDE THE OVERLAID VOLUME IS SAID AS A FRACTION rather than left to be inferred
  // from an absence of colour. A PET covers less of the patient than the CT it is fused
  // with, and "no uptake here" and "this series does not reach here" look identical.
  const covered = sampled.total ? Math.round((sampled.inside / sampled.total) * 100) : 0;
  const reach = covered >= 99 ? '' : ` · ${covered}%`;
  return `<br><span class="hud-fusion">${name}${escape(reach)} · `
    + `${escape(t('fusion.resampled', 'resampled, not measurable'))}</span>`;
}

/** The study the reader is working in: the one the ACTIVE panel is showing. */
function activeStudy() {
  return (panels[active] && panels[active].studyUID) || null;
}

/**
 * WHICH STUDY THIS PANEL IS, but only when the screen holds more than one.
 *
 * This is the same argument as the patient's name, run the other way. That name was taken
 * OUT of the panel label because one study opened into every panel and four identical
 * copies distinguished nothing. A prior makes panels able to differ -- and the moment two
 * panels can show two studies, a label that names only the series is the ambiguity that
 * removal was avoiding, in the one place a reader must not have it: comparing a lesion
 * across time, with nothing on either picture saying which time it is.
 *
 * SO IT APPEARS EXACTLY WHEN IT DISCRIMINATES. One study on screen: nothing, because the
 * banner already says which and repetition that cannot vary is what was removed. Two or
 * more: every panel carries its own study's date, including the current one -- marking
 * only the prior would leave the reader to infer that an unmarked panel is the current
 * study, which is a convention rather than a statement.
 *
 * THE DATE AND NOT "PRIOR"/"CURRENT". Those are roles, and a reader comparing three
 * studies has no use for two of them; the date is what the question is actually about.
 */
function studyMark(p) {
  if (!p || !p.studyUID) return '';
  const open = new Set(panels.map((q) => q.studyUID).filter(Boolean));
  if (open.size < 2) return '';
  const row = studyRows(p.studyUID)[0];
  const when = row ? studyDate(dv(row, '00080020', ''), dv(row, '00080030', '')) : '';
  if (!when) return '';
  return `<br><span class="hud-study">${escape(when)}</span>`;
}

/**
 * THE ONE THING A COMPARISON MUST NEVER GET WRONG.
 *
 * Two pictures side by side assert, by being side by side, that they are the same person.
 * Nothing else on the screen says it as loudly, and a reader comparing a nodule across two
 * studies is reading the DIFFERENCE -- which is exactly the signal a wrong pairing
 * manufactures out of nothing.
 *
 * So identity is checked on the PatientID the archive returned with the prior itself, not
 * on the id the picker was filtered by, because a filter is a request and a row is an
 * answer. QIDO matching is defined on the attribute, but an origin that matches loosely --
 * case, padding, a wildcard the caller did not intend -- returns rows the caller did not
 * ask for, and this function is what stands between that and the screen.
 *
 * NOT BY NAME, EVER. De-identified corpora routinely give many patients the same
 * `PatientName`; this archive holds nineteen studies under `anonim_patient` belonging to
 * different people. Name equality is not identity and pairing on it would be the defect
 * this function exists to prevent, dressed as a convenience.
 */
function samePatient(a, b) {
  const idOf = (row) => String(dv(row, '00100020', '')).trim();
  const one = idOf(a);
  return Boolean(one) && one === idOf(b);
}

/**
 * The same patient's other studies, newest first.
 *
 * Queried by PatientID rather than filtered out of the worklist the reader came through,
 * because that list is one page of a filtered, sorted query -- a prior older than the page
 * the reader happened to be on would simply not be there, and its absence would look like
 * the patient not having one.
 */
async function loadPriors(uid) {
  const rows = studyRows(uid);
  const current = rows[0];
  el.priorsSection.hidden = true;
  el.priors.innerHTML = '';
  if (!current) return;
  const patientId = String(dv(current, '00100020', '')).trim();
  if (!patientId) {
    // SAID, NOT SWALLOWED. A study with no PatientID cannot be paired with anything by the
    // only key that means identity, and a reader who sees no priors section would conclude
    // there are none rather than that the question could not be asked.
    el.priorsSection.hidden = false;
    el.priors.innerHTML = `<li class="muted">${escape(t('priors.noId',
      'This study carries no Patient ID, so its priors cannot be found by identity. '
      + 'Nothing is offered rather than offering a match made on the name.'))}</li>`;
    return;
  }

  let found;
  try {
    found = await client.studies({ filter: { PatientID: patientId }, limit: 50 });
  } catch (err) {
    el.priorsSection.hidden = false;
    el.priors.innerHTML = `<li class="muted">${escape(describe(err))}</li>`;
    return;
  }

  const priors = (found || [])
    .filter((s) => dv(s, '0020000D') !== uid && samePatient(current, s))
    .sort((a, b) => String(dv(b, '00080020', '')).localeCompare(String(dv(a, '00080020', ''))));

  if (!priors.length) return;   // no section rather than an empty one

  el.priorsSection.hidden = false;
  for (const s of priors) {
    const priorUID = dv(s, '0020000D');
    const li = document.createElement('li');
    li.className = 'series-item prior-item';
    li.dataset.study = priorUID;
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    const when = studyDate(dv(s, '00080020', ''), dv(s, '00080030', ''));
    const desc = String(dv(s, '00081030', '') || '');
    const mod = String(dv(s, '00080061', '') || dv(s, '00080060', '') || '');
    const count = dv(s, '00201208', '');
    // THE DATE IS THE DISCRIMINATING FACT in a list of one patient's studies, so it leads
    // and it is the only thing here set in the interface's own weight. The description is
    // frequently identical across a series of follow-ups -- eight of this archive's
    // studies are one patient's and six share a description -- and a list led by it reads
    // as six copies of one row.
    li.innerHTML = `<strong class="prior-when">${escape(when || '(no study date)')}</strong>`
      + `<span class="series-desc">${escape([mod, desc].filter(Boolean).join(' · '))}</span>`
      + `<span class="series-count">${escape(String(count || ''))}</span>`;
    li.setAttribute('aria-label', t('priors.open', 'Compare with the study of {d}')
      .replace('{d}', when || desc || priorUID));
    const go = () => comparePrior(priorUID, s);
    li.onclick = go;
    li.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
    };
    el.priors.appendChild(li);
  }
}

/**
 * Put a prior beside the study the reader is on, rather than instead of it.
 *
 * THE PANEL IT GOES INTO IS ONE NOT ALREADY HOLDING THE CURRENT STUDY, and if the layout
 * has no such panel the layout grows to make one. A comparison that replaced what it was
 * being compared with would be the behaviour this feature exists to remove.
 */
async function comparePrior(priorUID, priorRow) {
  const here = activeStudy();
  const currentRow = studyRows(here)[0];

  // FIRST ON THE ROW THE LIST WAS BUILT FROM, before a single byte is asked for. The
  // picker filtered by PatientID and a filter is a REQUEST; this row is the archive's
  // ANSWER. An answer that does not name this patient is refused here rather than after
  // its pixels have been retrieved -- the refusal is the same, and not fetching another
  // patient's images is better than fetching them and deciding not to draw them.
  const refuse = () => notice(t('priors.refused',
    'Refused: the study that came back names a different Patient ID than the one on '
    + 'screen. Two studies shown side by side assert they are the same person, and this '
    + 'pair does not.'), 'err');
  if (currentRow && priorRow && !samePatient(currentRow, priorRow)) { refuse(); return; }

  let rows;
  try { rows = await client.series(priorUID); }
  catch (err) { notice(describe(err), 'err'); return; }
  seriesByStudy.set(priorUID, { state: 'ready', rows: rows || [], message: '' });

  // IDENTITY IS RE-CHECKED ON THE SERIES ROWS, not only on the study row the list was
  // built from. Those are two separate answers from the archive and this is the one whose
  // pixels are about to be drawn; a surface that checks the row it is told about rather
  // than the row it is about to render has checked the wrong thing.
  const priorSeries = studyRows(priorUID);
  const mismatch = currentRow && priorSeries[0] && !samePatient(currentRow, priorSeries[0]);
  if (mismatch) { refuse(); return; }

  const images = priorSeries.filter((s) => ['CT', 'MR', 'PT'].includes(dv(s, '00080060')));
  if (!images.length) {
    notice(t('priors.noImages',
      'That study has no CT, MR or PT series to compare against.'), 'err');
    return;
  }

  // THE COMPARISON IS ITSELF A PROTOCOL, and it names itself like any other. Opening a
  // prior is the clearest case of the screen being arranged FOR the reader rather than
  // BY them, so it is the last place the arrangement should be anonymous.
  //
  // NAMED WHETHER OR NOT THE GRID HAS TO GROW. The first version only did this inside
  // `panels.length < 2`, so on a study the CT protocol had already opened into two panels
  // the name stayed "CT reconstructions, side by side" -- unstruck, and therefore claiming
  // to describe a screen that was now a current-and-prior comparison.
  //
  // AND NOT OVER THE READER. Once they have picked a layout themselves the name is struck
  // through and stays theirs; a protocol that reclaimed the screen after being overridden
  // would be answering "why does it look like this" with something that is not the reason.
  if (!protocolOverridden) {
    const pair = PROTOCOLS.find((p) => p.id === 'prior-comparison');
    if (pair) { protocolInForce = pair; renderProtocolName(); }
    if (panels.length < 2) {
      setLayout(pair ? pair.layout.cols : 2, pair ? pair.layout.rows : 1, { by: 'protocol' });
    }
  } else if (panels.length < 2) {
    setLayout(2, 1, { by: 'protocol' });
  }
  let target = panels.findIndex((p) => p.studyUID && p.studyUID !== here);
  if (target < 0) target = panels.findIndex((p) => !p.studyUID);
  if (target < 0) target = panels.length - 1;

  await loadSeriesInto(panels[target], target, priorUID, dv(images[0], '0020000E'), images[0]);
  setActive(target);
  syncChromeToActiveStudy();

  // AND WHAT THE READER TOOK ON THIS STUDY BEFORE. `recall` is keyed by study, so the
  // prior's own measurements come back with it and sit in the table beside the current
  // study's, each marked. Stamped with the study they were recalled UNDER rather than
  // trusted to carry it: a record written before a panel knew its study has no
  // `studyUID`, and an unstamped row is one that would mark itself as belonging to
  // whichever study the reader happens to be looking at.
  const heldOnPrior = recall(priorUID)
    .filter((m) => !getState().measurements.some((x) => x.id === m.id))
    .map((m) => ({ ...m, studyUID: priorUID }));
  if (heldOnPrior.length) {
    setState({ measurements: [...getState().measurements, ...heldOnPrior] }, 'prior');
  }
  // EVERY PANEL, not just the one that changed. `studyMark` is a fact about the SET of
  // studies on screen: the panel holding the current study said nothing while it was the
  // only study, and now has to say which one it is. A redraw of the new panel alone would
  // date the prior and leave the current study unmarked, which reads as "the unmarked one
  // is the one you were already looking at" -- a convention, where a date is a statement.
  drawAll();
  notice(t('priors.opened',
    'The prior is in the panel beside this one. Scroll linking between two studies cannot '
    + 'use patient position unless they share a frame of reference — each panel says which '
    + 'it is using.'), 'warn');
}

/**
 * Point the chrome at whatever the active panel is showing.
 *
 * The banner, the left rail and the footer each answer a question about ONE study, and
 * which study that is changes when the reader clicks a different panel. Before a prior
 * could be opened there was nothing for them to be wrong about; now there is, and the
 * failure would be silent -- a prior's picture under the current study's date.
 */
function syncChromeToActiveStudy() {
  const uid = activeStudy();
  const rows = studyRows(uid);
  if (rows.length) renderStudyIdentity(rows);
  renderSeriesList();
  setState({ series: rows }, 'active-study');
}

/**
 * A DA range from two date inputs.
 *
 * PS3.18 6.7.1.1: `YYYYMMDD-YYYYMMDD`, and an open end is a bare dash on the side that is
 * open. Returning '' for "neither given" matters -- a key set to an empty string is still
 * a key, and an origin is entitled to match nothing against it.
 */
function dateRange(from, to) {
  const clean = (v) => String(v || '').replace(/-/g, '').trim();
  const a = clean(from);
  const b = clean(to);
  if (a && b) return `${a}-${b}`;
  if (a) return `${a}-`;
  if (b) return `-${b}`;
  return '';
}

/**
 * What the filter row is asking the archive.
 *
 * WILDCARDS ARE ADDED HERE, not in the client: a reader typing three letters of a surname
 * means "starts with", and `PatientName=SMI` matches nobody. An accession is quoted exactly
 * as typed, because an accession is a whole identifier and a partial one is a mistake
 * rather than a search.
 */
function worklistFilter() {
  const star = (v) => { const t = String(v || '').trim(); return t ? `*${t}*` : ''; };
  return {
    PatientName: star(el.fName && el.fName.value),
    PatientID: star(el.fId && el.fId.value),
    StudyDescription: star(el.fDesc && el.fDesc.value),
    AccessionNumber: (el.fAcc && el.fAcc.value || '').trim(),
    ModalitiesInStudy: (el.fMod && el.fMod.value || '').trim(),
    StudyDate: dateRange(el.fFrom && el.fFrom.value, el.fTo && el.fTo.value),
  };
}

/** The value each sortable column sorts on. */
function worklistKey(row, by) {
  switch (by) {
    case 'name': return String(dv(row, '00100010', '')).toUpperCase();
    case 'id': return String(dv(row, '00100020', '')).toUpperCase();
    case 'date': return String(dv(row, '00080020', '')) + String(dv(row, '00080030', ''));
    case 'desc': return String(dv(row, '00081030', '')).toUpperCase();
    case 'acc': return String(dv(row, '00080050', '')).toUpperCase();
    case 'count': return Number(dv(row, '00201208', 0));
    default: return '';
  }
}

async function showStudies() {
  setCine(false);
  // No study is open, so there is nobody to name. An empty banner would read as a patient
  // with no name rather than as no study.
  if (el.who) el.who.hidden = true;
  if (el.footTech) el.footTech.textContent = '';
  // And closing the study gives those 190px back.
  fitToolbar();
  el.studyList.hidden = false;
  el.viewer.hidden = true;
  el.back.hidden = true;
  // WHICH SCREEN IS UP, said once, on the document. The study list is a CENTRED COLUMN and
  // the reading screen is edge-to-edge, so the chrome has to line up with one or the other
  // -- and CSS cannot ask which `<section>` is hidden without `:has()`, which this
  // deployment does not assume (see the note on `inert` in src/ui/dialogs.js).
  document.body.dataset.screen = 'worklist';
  // AND THE IMAGE TOOLBAR GOES WITH THE IMAGE.
  //
  // Nineteen of its twenty controls act on a picture, and on this screen there is none --
  // so a reader could arm the caliper, click, and watch nothing happen. An enabled button
  // that does nothing is indistinguishable from a broken one, which is exactly how it was
  // reported. Hidden rather than disabled: twenty greyed glyphs are twenty pieces of
  // furniture explaining that they are unavailable, on the screen whose whole job is the
  // list.
  if (el.barTools) el.barTools.hidden = true;
  await loadWorklist();
  // AND BACK TO WHERE THEY WERE, not to row one. `loadWorklist` empties the tbody, so
  // the scroll position collapses -- a reader working a 200-study list re-found their
  // place by reading patient names. Only on THIS path: `renderWorklist` also runs on
  // every keystroke in a filter, and scrolling the list under a typing reader is worse
  // than losing the place.
  const seen = el.studies.querySelector('.wl-seen');
  if (seen) seen.scrollIntoView({ block: 'center' });
}

/**
 * Fetch one page and render it.
 *
 * `worklistQuery` IS AN OWNERSHIP TOKEN, the same shape `loadSeriesInto` uses. Typing in a
 * filter fires a query per keystroke-burst and the archive answers in whatever order it
 * likes; without this, a slow answer to "SMI" can land after the fast answer to "SMITH"
 * and leave the table showing results for a query the box no longer contains.
 */
async function loadWorklist() {
  const mine = ++worklistQuery;
  try {
    const rows = await client.studies({
      filter: worklistFilter(), offset: worklistOffset, limit: WORKLIST_PAGE,
    });
    if (mine !== worklistQuery) return;
    worklistMore = rows.length > WORKLIST_PAGE;
    worklistRows = worklistMore ? rows.slice(0, WORKLIST_PAGE) : rows;
    renderWorklist();
  } catch (err) {
    if (mine !== worklistQuery) return;
    // THE SENTENCE FIRST, THE URL SECOND. `describe(err)` leads with the endpoint, so
    // the reader met a bare failing URL where a study list should be.
    el.studies.innerHTML = '<tr class="wl-note wl-note-err"><td colspan="8">'
      + escape(t('wl.unreachable', 'The archive could not be reached.'))
      + `<span class="wl-note-tech">${escape(describe(err))}</span>`
      + '</td></tr>';
    if (el.wlCount) el.wlCount.textContent = '';
    if (el.wlPage) el.wlPage.textContent = '';
  }
}

function renderWorklist() {
  const rows = [...worklistRows].sort((a, b) => {
    const ka = worklistKey(a, worklistSort.by);
    const kb = worklistKey(b, worklistSort.by);
    const d = ka < kb ? -1 : ka > kb ? 1 : 0;
    return worklistSort.desc ? -d : d;
  });

  el.studies.innerHTML = '';
  if (!rows.length) {
    const any = Object.values(worklistFilter()).some(Boolean);
    el.studies.innerHTML = '<tr class="wl-note"><td colspan="8">'
      + escape(any
        ? t('wl.noMatch', 'No study matches these filters.')
        : t('wl.archiveEmpty', 'The archive holds no studies.'))
      + '</td></tr>';
  }

  for (const row of rows) {
    const uid = dv(row, '0020000D');
    const mods = String(row['00080061']?.Value ?? '').replace(/,/g, ' \u00b7 ');
    const tr = document.createElement('tr');
    // THE NAME IS A BUTTON. A `<tr>` with a click handler is reachable by mouse and by
    // nothing else; `app.js` preventDefaults Tab once a study is open, so a keyboard
    // reader who cannot open a study from here cannot open one at all.
    const open = worklistExpanded.has(uid);
    tr.innerHTML = `
      <td class="wl-x"><button type="button" class="wl-expand"
        aria-expanded="${open}" aria-controls="wl-sub-${escape(uid)}"
        title="${escape(t('wl.seriesIn', 'Series in this study'))}"
        ><span class="sr-only">${escape(t('wl.seriesIn', 'Series in this study'))}</span>
        <span class="wl-expand-mark" aria-hidden="true">${icon('chevron')}</span>
      </button></td>
      <td><button type="button" class="wl-open">${escape(dv(row, '00100010', '(no name)'))}</button></td>
      <td class="tech wl-id" title="${escape(dv(row, '00100020', ''))}">${escape(dv(row, '00100020', ''))}</td>
      <td class="tech">${escape(studyDate(dv(row, '00080020', ''), dv(row, '00080030', '')))}</td>
      <td class="wl-desc" title="${escape(dv(row, '00081030', ''))}">${escape(dv(row, '00081030', ''))}</td>
      <td class="tags">${escape(mods)}</td>
      <td class="tech">${escape(dv(row, '00080050', ''))}</td>
      <td class="num tech">${escape(String(dv(row, '00201208', '')))}</td>`;
    tr.onclick = () => openStudy(uid);
    tr.classList.toggle('wl-seen', uid === worklistSeen);
    tr.querySelector('.wl-open').onclick = (e) => { e.stopPropagation(); openStudy(uid); };
    // THE CHEVRON DOES NOT OPEN THE STUDY. Expanding is how a reader decides WHICH
    // series they want; opening the study from the chevron would take that choice away
    // at the moment they were making it.
    tr.querySelector('.wl-expand').onclick = (e) => {
      e.stopPropagation();
      toggleStudySeries(uid);
    };
    el.studies.appendChild(tr);
    if (worklistExpanded.has(uid)) el.studies.appendChild(worklistSubRow(uid));
  }

  // WHAT THE COUNT CAN HONESTLY SAY. QIDO returns no total, so "5 studies" would be a
  // claim about the archive made from one page of it. It says what is shown, and whether
  // there is more.
  if (el.wlCount) {
    el.wlCount.textContent = rows.length
      ? `${rows.length} ${t('wl.shown', 'shown')}`
        + `${worklistMore || worklistOffset ? ` ${t('wl.ofMore', 'of more')}` : ''}`
      : '';
  }
  if (el.wlPage) {
    const first = worklistOffset + 1;
    el.wlPage.textContent = rows.length ? `${first}\u2013${worklistOffset + rows.length}` : '';
  }
  if (el.wlPrev) el.wlPrev.disabled = worklistOffset === 0;
  if (el.wlNext) el.wlNext.disabled = !worklistMore;

  for (const b of document.querySelectorAll('.wl-sort')) {
    const on = b.dataset.sort === worklistSort.by;
    b.classList.toggle('on', on);
    b.setAttribute('aria-sort', on ? (worklistSort.desc ? 'descending' : 'ascending') : 'none');
    // The arrow is drawn, not typed, so it does not depend on a glyph being present.
    b.dataset.dir = on ? (worklistSort.desc ? 'desc' : 'asc') : '';
  }
}

/** Wire the filter row, the sort headers and the pager. Called once. */
/**
 * The series of one study, drawn INSIDE the study list rather than after leaving it.
 *
 * A STUDY IS NOT A THING A READER OPENS. A series is. The flat list made every study a
 * single undifferentiated row, so choosing between `t2_tse_sag` and `t2_stir_sag` meant
 * opening the study, looking at the rail, and coming back if it was the wrong one. The
 * sub-table puts that choice where the decision is made.
 *
 * Three states, all of them said out loud: loading, ready, and failed. The failed case
 * names what went wrong -- a study whose series cannot be listed is a study the reader
 * should not silently see as empty.
 */
function worklistSubRow(uid) {
  const tr = document.createElement('tr');
  tr.className = 'wl-sub';
  tr.id = `wl-sub-${uid}`;
  const held = seriesByStudy.get(uid);

  if (!held || held.state === 'loading') {
    tr.innerHTML = '<td colspan="8" class="muted">Reading the series of this study\u2026</td>';
    return tr;
  }
  if (held.state === 'error') {
    tr.innerHTML = `<td colspan="8" class="err">${escape(held.message)}</td>`;
    return tr;
  }
  if (!held.rows.length) {
    tr.innerHTML = '<td colspan="8" class="muted">This study holds no series.</td>';
    return tr;
  }

  // SORTED BY SERIES NUMBER, which is the order the acquisition assigned and the order
  // every other viewer shows. A numeric sort, because '10' sorts before '2' as text.
  const rows = [...held.rows].sort((a, b) => (
    Number(dv(a, '00200011', 0)) - Number(dv(b, '00200011', 0))
  ));

  const body = rows.map((s) => {
    const su = dv(s, '0020000E', '');
    return `<tr data-series="${escape(su)}">`
      + `<td class="wl-sdesc">${escape(dv(s, '0008103E', '(no description)'))}</td>`
      + `<td class="num tech">${escape(String(dv(s, '00200011', '')))}</td>`
      + `<td class="tags">${escape(dv(s, '00080060', ''))}</td>`
      + `<td class="num tech">${escape(String(dv(s, '00201209', '')))}</td>`
      + '</tr>';
  }).join('');

  tr.innerHTML = `<td colspan="8"><table class="wl-series">`
    + '<thead><tr><th scope="col">Description</th><th scope="col">Series</th>'
    + `<th scope="col">${escape(t('wl.modality', 'Modality'))}</th>`
    + `<th scope="col">${escape(t('wl.instances', 'Instances'))}</th></tr></thead>`
    + `<tbody>${body}</tbody></table></td>`;

  // A SERIES ROW OPENS THE STUDY ON THAT SERIES. The reader picked it here; the viewer
  // should not then open something else and make them pick again.
  for (const row of tr.querySelectorAll('tbody tr[data-series]')) {
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    const go = (e) => { e.stopPropagation(); openStudy(uid, { focusSeries: row.dataset.series }); };
    row.onclick = go;
    row.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(e); } };
  }
  return tr;
}

/**
 * Open or close one study's series, fetching them once.
 *
 * COLLAPSING NEVER REFETCHES AND NEVER EVICTS: a reader who closes a row and opens it
 * again is answering a question they already asked, and asking the archive twice for the
 * same answer is how a study list becomes slower the longer it is used.
 */
async function toggleStudySeries(uid) {
  if (worklistExpanded.has(uid)) {
    worklistExpanded.delete(uid);
    renderWorklist();
    return;
  }
  worklistExpanded.add(uid);
  if (seriesByStudy.has(uid) && seriesByStudy.get(uid).state === 'ready') {
    renderWorklist();
    return;
  }
  seriesByStudy.set(uid, { state: 'loading', rows: [], message: '' });
  renderWorklist();
  try {
    const rows = await client.series(uid);
    seriesByStudy.set(uid, { state: 'ready', rows: rows || [], message: '' });
  } catch (err) {
    seriesByStudy.set(uid, { state: 'error', rows: [], message: describe(err) });
  }
  // BOUNDED, because a long session over a large archive would otherwise hold every
  // series list it ever showed. Oldest first -- a Map iterates in insertion order.
  while (seriesByStudy.size > SERIES_CACHE_MAX) {
    const oldest = seriesByStudy.keys().next().value;
    if (oldest === uid) break;
    seriesByStudy.delete(oldest);
  }
  // ONLY IF IT IS STILL OPEN. The reader may have collapsed it while the query ran.
  if (worklistExpanded.has(uid)) renderWorklist();
}
function bindWorklist() {
  // DEBOUNCED, because every keystroke is a round trip to the archive otherwise. 250ms is
  // under the threshold where a reader notices a pause and over the one where a typist
  // generates a query per letter.
  let timer = null;
  const refetch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { worklistOffset = 0; loadWorklist(); }, 250);
  };
  for (const node of [el.fName, el.fId, el.fDesc, el.fAcc]) {
    if (node) node.addEventListener('input', refetch);
  }
  for (const node of [el.fMod, el.fFrom, el.fTo]) {
    if (node) node.addEventListener('change', () => { worklistOffset = 0; loadWorklist(); });
  }
  if (el.wlClear) {
    el.wlClear.onclick = () => {
      for (const n of [el.fName, el.fId, el.fDesc, el.fAcc, el.fFrom, el.fTo]) if (n) n.value = '';
      if (el.fMod) el.fMod.value = '';
      worklistOffset = 0;
      loadWorklist();
    };
  }
  if (el.wlPrev) {
    el.wlPrev.onclick = () => {
      worklistOffset = Math.max(0, worklistOffset - WORKLIST_PAGE);
      loadWorklist();
    };
  }
  if (el.wlNext) {
    el.wlNext.onclick = () => { worklistOffset += WORKLIST_PAGE; loadWorklist(); };
  }
  for (const b of document.querySelectorAll('.wl-sort')) {
    // SORTS THE PAGE, NOT THE ARCHIVE. QIDO has no sort key, so this orders the rows that
    // came back and nothing else -- which is why the title says so rather than leaving a
    // reader to assume the first row is the earliest study in the archive.
    b.title = `Sort the studies shown by ${b.textContent.toLowerCase()}`;
    b.onclick = () => {
      if (worklistSort.by === b.dataset.sort) worklistSort.desc = !worklistSort.desc;
      else worklistSort = { by: b.dataset.sort, desc: b.dataset.sort === 'date' };
      renderWorklist();
    };
  }
}

/* ----------------------------------------------------------------------------------
 * study
 * -------------------------------------------------------------------------------- */

/**
 * Open a study, optionally on the series the reader picked out of the expanded row.
 *
 * `focusSeries` IS A PREFERENCE, NOT A FILTER. Every image series still loads and the
 * rail still lists them; the chosen one is simply first, so the panel the reader lands on
 * is the one they clicked. Passing a series that is not in this study, or is not an image
 * series, changes nothing rather than failing -- a stale deep link should open the study.
 */
async function openStudy(uid, { focusSeries = null } = {}) {
  // The toolbar returns with the picture it acts on.
  if (el.barTools) el.barTools.hidden = false;
  document.body.dataset.screen = 'reading';
  // A MEASUREMENT BELONGS TO A PATIENT, and nothing here scoped it to one.
  //
  // `state.measurements` is a single flat list that survived every navigation, so a caliper
  // drawn on one study stayed in the "Yours this session" table while the reader read the
  // next one. MEASURED: a 169.1 mm caliper placed on the demo phantom was still listed,
  // with its number, while `LCTSC-Test-S1-102` was open -- a different patient entirely.
  //
  // `elsewhere()` marked it "· another series", which is the most dangerous possible
  // wording for this: it describes an ordinary, safe, within-study situation, so a reader
  // who has seen that marking before has been taught to disregard it. Nothing said "another
  // patient", because nothing knew.
  //
  // They are dropped rather than kept-and-scoped because they were never persisted anyway
  // -- the heading says "this session, not saved" -- so scoping would preserve nothing a
  // reader could have relied on, while leaving the cross-patient path alive.
  if (studyUID && studyUID !== uid) {
    setState({ measurements: [], srMeasurements: [], cursor: null }, 'study');
    for (const p of panels) p._anchor = null;
  }
  studyUID = uid;
  worklistSeen = uid;

  // AND WHAT THIS STUDY HAD LAST TIME. Recalled AFTER the clear above and keyed by this
  // study's own UID, which the stored record repeats -- so a key edited by hand cannot put
  // one study's measurements onto another, which is the failure this project has already
  // had once.
  const held = recall(uid);
  if (held.length) {
    setState({ measurements: held, selectedMeasurement: null }, 'study');
  }
  el.studyList.hidden = true;
  el.viewer.hidden = false;
  el.back.hidden = false;
  el.series.innerHTML = '<li class="muted">Loading…</li>';
  notice('');

  if (!panels.length) setLayout(1, 1);

  // THE LIST THE READER JUST LOOKED AT, if they expanded this study in the worklist.
  // Opening a study after reading its series should not ask the archive the same
  // question a second time.
  let series;
  const cached = seriesByStudy.get(uid);
  if (cached && cached.state === 'ready' && cached.rows.length) series = cached.rows;
  try { if (!series) series = await client.series(uid); }
  catch (err) { notice(describe(err), 'err'); return; }

  // INTO THE CACHE FIRST, so `studyRows` can answer for this study from here on. The sort
  // moved into that function: it is a property of how a reader reads a series list, not of
  // this one code path, and two studies now need it independently.
  seriesByStudy.set(uid, { state: 'ready', rows: series || [], message: '' });
  const seriesIndex = studyRows(uid);
  renderStudyIdentity(seriesIndex);
  renderSeriesList(uid);
  // NOT AWAITED. The priors are a second question to the archive and the reader is waiting
  // for pixels from the first; a list of other studies is worth none of that latency. It
  // fills in beside the series when it arrives, and if it never does the section stays
  // hidden rather than holding a spinner open over nothing.
  loadPriors(uid).catch(() => {});
  // AND INTO THE STORE, because `state.series` has been declared and documented -- "the
  // study's series rows, as QIDO returned them" -- since the store existed, and nothing
  // ever wrote it. The shell kept `seriesIndex` as a module variable and the key stayed
  // empty, so a panel subscribing to it rendered once and froze. That is the defect
  // `state.js` was introduced to remove, surviving as an unwritten key.
  setState({ series: seriesIndex }, 'open-study');

  // A CASE OPENS LAID OUT, UNDER A PROTOCOL THAT HAS A NAME.
  //
  // This used to be two `if`s -- four image series gets 2x2, more than one gets 2x1 --
  // citing `MOS-UI-209` as though it applied. It does not: 19.4.4 is bound by
  // `MOS-UI-213` to OHIF configuration or an extension-package module, and both are gone.
  // `src/image/mpr.js` carries the same correction for `MOS-UI-211`, including the earlier
  // version of its own header that got this wrong. The substance is built anyway, in
  // `protocols.json`, which argues it in full; the requirement stays UNMET as written,
  // because it selects by a campaign's `capability_id` and there is no campaign here.
  //
  // WHAT THE TWO `if`s COULD NOT DO, beyond having no name: they could only ever grow the
  // grid. A reader who had just been in 3x3 on a multi-sequence MR opened a single-series
  // CT into nine panels, eight of them saying "this study has no further image series".
  let images = seriesIndex.filter((s) => ['CT', 'MR', 'PT'].includes(dv(s, '00080060')));
  // THE SERIES THE READER CLICKED GOES FIRST, and only that. It is not filtered to, because
  // the rest of the study did not stop existing because they picked one out of the list.
  if (focusSeries) {
    const picked = images.findIndex((s) => dv(s, '0020000E') === focusSeries);
    if (picked > 0) images = [images[picked], ...images.filter((_, i) => i !== picked)];
  }
  const chosen = chooseProtocol(seriesIndex);
  if (chosen) {
    protocolInForce = chosen;
    protocolOverridden = false;
    setLayout(chosen.layout.cols, chosen.layout.rows, { by: 'protocol' });
  }
  renderProtocolName();

  const take = Math.min(images.length, panels.length);
  // EVERY PANEL THIS STUDY DOES NOT FILL IS EMPTIED FIRST, and before the loads rather than
  // after them: `loadSeriesInto` paints progressively and yields, so a panel cleared
  // afterwards would show the previous study beside the new one for as long as the
  // retrieval takes -- which on a 148-slice series is exactly when the reader is looking.
  for (let i = take; i < panels.length; i++) {
    clearPanel(panels[i], 'This study has no further image series for this panel.');
  }
  for (let i = 0; i < take; i++) {
    await loadSeriesInto(panels[i], i, uid, dv(images[i], '0020000E'), images[i]);
  }
  // ONCE THE SET OF OPEN STUDIES HAS SETTLED. The loop above loads panels one at a time,
  // and `studyMark` asks a question about the whole set: while panel 0 was loading, panel
  // 1 still held the PREVIOUS study, so the set had two members and panel 0 was dated.
  // Panel 1 then loaded, the set became one study, and nothing redrew panel 0 -- leaving
  // a date on a screen with nothing to distinguish it from. MEASURED by going back to the
  // worklist and opening another patient: one panel marked, its neighbour not.
  //
  // The mark was never WRONG -- it reads `p.studyUID`, so it can only ever name its own
  // panel's study -- but "appears exactly when it discriminates" is the whole argument
  // for having it, and a mark that lingers is a mark a reader learns to ignore.
  drawAll();
  await loadDerived(uid, seriesIndex, loadToken);
}

/**
 * The chrome that says WHICH STUDY IS OPEN: the banner, and the rail's study block.
 *
 * Fed from the series-level query rather than the study list, because a reader can reach
 * the viewer without passing through the list and the banner has to be right either way.
 */
function renderStudyIdentity(rows) {
  const first = rows && rows[0];
  if (!first) return;
  const name = dv(first, '00100010', '');
  const id = dv(first, '00100020', '');
  const desc = dv(first, '00081030', '');
  const date = studyDate(dv(first, '00080020', ''), dv(first, '00080030', ''));
  const acc = dv(first, '00080050', '');
  const mods = [...new Set(rows.map((r) => dv(r, '00080060', '')).filter(Boolean))].join(' \u00b7 ');

  el.who.hidden = false;
  el.whoName.textContent = name || '(no patient name)';
  // The identifiers a reader matches against a worklist, in the order they read them.
  // NOT THE ID WHEN IT IS THE NAME. De-identified corpora routinely set PatientID and
  // PatientName to the same string, and a banner reading "LCTSC-Test-S1-102
  // LCTSC-Test-S1-102" teaches the reader that the second field is noise -- on the day it
  // is not, they will read past it.
  const shownId = id && id !== name ? id : '';
  el.whoMeta.textContent = [shownId, date, desc, acc && `Acc ${acc}`]
    .filter(Boolean).join('  \u00b7  ');
  // THE BANNER IS 190px THE TOOLBAR NO LONGER HAS. Opening a study is the single largest
  // change to the row's available width and fires no resize event.
  fitToolbar();

  // THE LEFT RAIL IS THE SERIES LIST AND NOTHING ELSE NOW. It used to repeat the study
  // date, the modality, the description and the series count -- all of which the `Study`
  // panel in the right rail already carries, with the id and the accession besides. Two
  // sections titled "Study", one per rail, printing the same tags.
  //
  // `mods` is still derived above: the series rows are read for the banner either way.
}

/**
 * What the pixels on screen actually are, in the footer.
 *
 * Read from the FRAME rather than from the header, so it describes what is rendered: a
 * reconstruction says the resliced size, and a series whose Modality LUT was not applied
 * does not get to print HU.
 */
function renderFooterTech(p) {
  if (!el.footTech) return;
  if (!p || !p.stack || !p.frame) { el.footTech.textContent = ''; return; }
  const f = p.frame;
  const bits = [
    `${p.stack.depth} images`,
    `${f.columns}\u00d7${f.rows}`,
    f.signed ? 'Int16' : 'Uint16',
  ];
  if (f.slope !== undefined && f.intercept !== undefined) {
    bits.push(`slope ${f.slope} intercept ${f.intercept}`);
  }
  if (f.valueUnit) bits.push(f.valueUnit);
  if (transferSyntax) bits.push(transferSyntax);
  el.footTech.textContent = bits.join(' \u00b7 ');
}

function renderSeriesList(uid = activeStudy()) {
  el.series.innerHTML = '';
  for (const s of studyRows(uid)) {
    const modality = dv(s, '00080060');
    const uid = dv(s, '0020000E');
    const li = document.createElement('li');
    li.className = 'series-item';
    li.dataset.series = uid;
    li.dataset.modality = modality;
    /*
     * A SERIES IS CHOSEN WITH THE KEYBOARD TOO, and until now it was not.
     *
     * This `<li>` carried an `onclick` and nothing else: no `tabindex`, no role, no
     * button inside it. Choosing WHICH series to read -- the first decision a reader
     * makes after opening a study -- was available to a pointer and to nothing else,
     * which is WCAG 2.1.1 at level A on a core function.
     *
     * The stylesheet had believed otherwise for some time: `.series-item:focus-visible`
     * has a focus ring, drawn for a state the element could never enter. A focus style on
     * an unfocusable element is the shape of this kind of bug -- someone thought about
     * the keyboard here and the attribute never followed.
     */
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    // A THUMBNAIL, then the modality, then the description and the count.
    //
    // The old row was three spans on one line with `nowrap` ellipsis in a 290px rail, so a
    // real protocol description -- "CT114545:RespCT 3.0 B30f 50% Ex" -- lost exactly the
    // part that tells two reconstructions of one acquisition apart. A picture identifies a
    // series faster than any amount of that text, which is why every product being
    // replaced here shows one.
    //
    // The canvas is filled later by `paintSeriesThumb` once the panel holding this series
    // has a frame. Until then it is black, which is what an undrawn image looks like --
    // not a grey block, which reads as a loaded image of nothing.
    const number = dv(s, '00200011', '');
    li.innerHTML = `<canvas class="series-thumb" width="96" height="78" aria-hidden="true"></canvas>
      <span class="series-row">
        <span class="series-dot mod-${escape(modality)}"></span>
        <span class="mod">${escape(modality)}</span>
        ${number === '' ? '' : `<span class="series-count">#${escape(String(number))}</span>`}
      </span>
      <span class="series-desc" title="${escape(dv(s, '0008103E', '(no description)'))}">${escape(dv(s, '0008103E', '(no description)'))}</span>
      <span class="series-count">${dv(s, '00201209', '?')} images</span>`;
    li.onclick = () => {
      if (!['CT', 'MR', 'PT'].includes(modality)) {
        // WHAT IS TRUE OF THIS MODALITY, not of non-image series in general.
        notice(DERIVED_MODALITIES.includes(modality)
          ? `${modality} is not an image series; it is layered onto the image panels instead.`
          : `${modality} is not an image series, and MedOS does not read it. Nothing it `
            + 'carries is on screen.');
        return;
      }
      loadSeriesInto(panels[active], active, studyUID, uid, s);
    };
    // ENTER AND SPACE ARE WHAT `role="button"` PROMISES. Space is also scrolled by the
    // browser by default, so it is cancelled here -- on the row, not globally.
    li.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      li.click();
    });
    el.series.appendChild(li);
  }
  markSeriesAssignment();
  // Fire and forget: the list is usable the moment it is built, and every thumbnail
  // that arrives improves it. A failure paints nothing and says nothing, because a
  // toast about a thumbnail is worse than a black rectangle.
  //
  // WITH THE STUDY THIS LIST WAS BUILT FROM. It used to be handed the module-level
  // `studyUID`, which was the same thing until a list could be rendered for a study the
  // reader had not arrived at.
  paintAllThumbs(uid).catch(() => {});
}

/**
 * Paint a series' thumbnail from the frame a panel is already holding.
 *
 * WHY FROM THE PANEL AND NOT FROM A SEPARATE FETCH. A thumbnail is worth having and is not
 * worth a second retrieval of the same series, and this surface has no cache -- so asking
 * the archive again would double the traffic to draw 96 pixels. A series that is not in a
 * panel keeps a black thumbnail, which is honest: it says "not loaded", where a grey block
 * would say "loaded, and empty".
 *
 * Windowed with the panel's own centre/width so the thumbnail and the image agree. Nearest
 * neighbour, because it is 96 px wide and every alternative is arithmetic nobody will look
 * closely enough to notice.
 */
/**
 * Paint one thumbnail from a FRAME and a WINDOW.
 *
 * Split out from `paintSeriesThumb` because the painter never needed a panel -- it
 * needed pixels and a window, and taking a panel is what tied a thumbnail to a series
 * being open. Two callers now: the panel path, which repaints as the reader windows a
 * series, and the study-load path, which paints every series whether it is open or not.
 */
function paintThumb(li, f, window_) {
  const canvas = li.querySelector('.series-thumb');
  if (!canvas || !f || !f.pixels) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const W = canvas.width;
  const H = canvas.height;
  const scale = Math.min(W / f.columns, H / f.rows);
  const w = Math.max(1, Math.round(f.columns * scale));
  const h = Math.max(1, Math.round(f.rows * scale));
  const ox = (W - w) >> 1;
  const oy = (H - h) >> 1;

  const slope = f.slope ?? 1;
  const intercept = f.intercept ?? 0;
  const { center, width } = window_;
  const lo = center - width / 2;
  const span = width || 1;

  const img = ctx.createImageData(W, H);
  img.data.fill(0);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(f.rows - 1, Math.floor(y / scale));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(f.columns - 1, Math.floor(x / scale));
      const stored = f.pixels[sy * f.columns + sx];
      const value = stored * slope + intercept;
      let g = Math.round(((value - lo) / span) * 255);
      g = g < 0 ? 0 : g > 255 ? 255 : g;
      const at = ((y + oy) * W + (x + ox)) * 4;
      img.data[at] = g; img.data[at + 1] = g; img.data[at + 2] = g; img.data[at + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * The panel path: a series that IS open repaints as the reader windows it.
 *
 * Kept because a thumbnail of an open series should track what the reader has done to
 * it, which the study-load thumbnail cannot know.
 */
function paintSeriesThumb(li, p) {
  if (!p || !p.frame) return;
  paintThumb(li, p.frame, p.viewport.window);
}

/**
 * EVERY SERIES GETS A PICTURE, whether or not it has ever been opened.
 *
 * `paintSeriesThumb` had exactly one caller and it fired only for a series occupying a
 * panel, so the list showed black rectangles for everything the reader had not already
 * clicked -- which is precisely backwards. A thumbnail exists to tell the reader what a
 * series IS before they open it; one that appears only after they open it has answered
 * a question they no longer have.
 *
 * THE MIDDLE INSTANCE, not the first. The first slice of a spine sagittal is a lateral
 * edge and the first of a chest CT is table and air; both are nearly black, which would
 * have looked like the bug this fixes.
 *
 * BOUNDED CONCURRENCY. Eight series at once is eight multi-megabyte fetches racing the
 * series the reader actually asked for. Three at a time keeps the list filling visibly
 * without competing with the panel load for the same connection pool.
 */
async function paintAllThumbs(study) {
  const rows = [...el.series.children].filter((li) => li.dataset && li.dataset.series);
  const queue = rows.filter((li) => ['CT', 'MR', 'PT'].includes(li.dataset.modality || ''));
  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      const li = queue[next++];
      // The reader moved on. Every await below is a chance for the list to change, and a
      // thumbnail painted into the previous study's list is a picture of the wrong
      // patient sitting next to the right one.
      //
      // AGAINST THE LIST'S STUDY, NOT THE ARRIVAL STUDY. This read `studyUID !== study`,
      // which was the same question while the surface held one study and stopped being
      // one the moment a prior could be opened: clicking the prior re-renders this list
      // from the prior's series while `studyUID` -- the study the reader arrived at --
      // does not move. The guard passed, and the loop then asked the archive for the
      // PRIOR's series UID under the CURRENT study's UID. Measured in the network log:
      // four `/studies/{current}/series/{prior}/instances` requests, each 204 No Content
      // and then aborted. A pairing that answered 200 instead is the version of this that
      // paints a thumbnail of one study onto another study's row.
      if (activeStudy() !== study) return;
      try {
        const instances = await client.instancesOf(study, li.dataset.series);
        if (!instances.length || activeStudy() !== study) continue;
        const sorted = [...instances].sort((a, b) => num(a) - num(b));
        const pick = sorted[Math.floor(sorted.length / 2)];
        const sop = pick['00080018'] && pick['00080018'].Value && pick['00080018'].Value[0];
        if (!sop) continue;
        const one = await client.retrieveInstance(study, li.dataset.series, sop);
        if (activeStudy() !== study) return;
        const stack = buildStack([one]);
        if (stack.frames.length) paintThumb(li, stack.frames[0], stack.defaultWindow);
      } catch (e) {
        // A thumbnail is a convenience. A series whose representative slice will not
        // fetch or parse keeps its black rectangle, and the reader finds out what is
        // wrong with it by opening it -- which reports properly.
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}

/** (0020,0013) as a number, for ordering. Absent sorts first, which is the encoded order. */
function num(inst) {
  const v = inst['00200013'] && inst['00200013'].Value && inst['00200013'].Value[0];
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Show which panel each series occupies, so the list reflects the grid. */
function markSeriesAssignment() {
  for (const li of el.series.children) {
    if (!li.dataset || !li.dataset.series) continue;
    const at = panels.findIndex((p) => p.seriesUID === li.dataset.series);
    li.classList.toggle('active', at >= 0);
    if (at >= 0) paintSeriesThumb(li, panels[at]);
    let tag = li.querySelector('.panel-tag');
    if (at >= 0 && panels.length > 1) {
      if (!tag) {
        tag = document.createElement('span');
        tag.className = 'panel-tag';
        // INTO THE ROW IT WAS WRITTEN FOR. `.panel-tag` is `flex: 0 0 auto` and was being
        // appended to the `<li>`, which is not a flex container: its own box then rose
        // into the line above and sat on the image count -- measured, 12x2 px over
        // "32 images". `.series-row` is the flex row that already holds the modality dot,
        // the modality and the series number, and this belongs with them.
        (li.querySelector('.series-row') || li).appendChild(tag);
      }
      tag.textContent = String(at + 1);
      tag.title = t('series.inPanel', 'Open in panel {n}').replace('{n}', String(at + 1));
    } else if (tag) tag.remove();
  }
}

async function loadSeriesInto(panel, panelIndex, study, seriesUID, row) {
  if (!panel || !panel.viewport) return;

  const previous = inFlight.get(panel);
  if (previous) previous.abort();
  const controller = new AbortController();
  inFlight.set(panel, controller);
  loadToken++;
  const mine = () => inFlight.get(panel) === controller;

  notice('Loading series…', 'info');
  try {
    let painted = 0;
    const { instances, warnings } = await client.retrieveSeries(study, seriesUID, (_i, n, soFar) => {
      if (!mine() || n < 2) return;
      if (n !== 2 && n - painted < Math.max(2, Math.floor(n / 8))) return;
      try {
        const partial = buildStack(soFar);
        if (painted === 0) {
          panel.index = Math.floor(partial.depth / 2);
          panel.plane = PLANES.AXIAL;
          panel.viewport.setWindow(partial.defaultWindow.center, partial.defaultWindow.width);
        }
        panel.stack = partial;
        painted = n;
        draw(panel);
      } catch (e) { /* not yet a coherent stack */ }
    }, controller.signal);

    if (!mine()) return;

    const stack = buildStack(instances);
    delete stack._volume;
    panel.stack = stack;
    // AND THE LINK MODE GOES WITH THE OLD SERIES. `crosshairFor` suppresses the
    // absence sentence when the badge already states it, and asks `_linkMode` -- which is
    // written by the cursor propagation, i.e. on the next scroll. Between this assignment
    // and that scroll it holds the answer for the series that WAS here: a new series with
    // a different frame of reference would have its absence suppressed by a badge that is
    // not on screen yet, and the reader would be told nothing at all.
    panel._linkMode = null;
    panel.seriesUID = seriesUID;
    // WHICH STUDY THIS PANEL IS SHOWING, which until now nothing on a panel recorded.
    // `loadSeriesInto` had always been given the study -- it is the first half of every
    // WADO-RS path it builds -- and threw it away once the request was made, because a
    // single module-level `studyUID` was the only answer the surface had. That single
    // variable is what made a prior impossible: two panels could not disagree about which
    // study they held, so there was nothing to compare a current study WITH.
    panel.studyUID = study;
    // A NEW SERIES IS NOT THE SERIES THE FUSION WAS SAMPLED ONTO. Keeping it would
    // draw one acquisition's uptake through another's anatomy, captioned correctly
    // and wrong -- the resampling is onto a frame that has just been replaced.
    panel.fusion = null;
    panel._fusionAt = null;
    panel._fusionSampled = null;
    panel._fusionError = null;
    if (panel.viewport) panel.viewport.setFusion(null);
    panel.index = Math.floor(stack.depth / 2);
    panel.plane = PLANES.AXIAL;
    panel.seg = null;
    panel._anchor = null;   // a new series invalidates the reader's assertion
    panel.viewport.setWindow(stack.defaultWindow.center, stack.defaultWindow.width);
    panel.viewport.setOverlay(null);

    // THE SERIES, AND NOT THE PATIENT AGAIN. This label carried the patient's name on a
    // second line, in every panel: four identical copies in a 2x2, because this viewer
    // opens ONE study into every panel and the four could never differ. A repetition that
    // cannot vary distinguishes nothing.
    //
    // The identity is answered twice, deliberately: the header banner, which is at eye
    // level and always there, and the `Study` panel in the right rail, which carries the
    // id, the accession and the series count for when the question is "which study
    // exactly". A capture is unaffected -- `capturePanel` builds its caption from `meta`,
    // not from this corner, so an exported picture still names the patient.
    panel.label = escape(String(dv(row, '0008103E', 'series')));

    // The transfer syntax moved to the footer, beside the other facts about the bytes.
    // It was a pill in the header, beside the patient's name, which gave the most
    // prominent strip on the surface to a constant.
    transferSyntax = 'read as Explicit VR LE, uncompressed';

    if (panelIndex === active) { buildPresets(); buildPlaneButtons(); buildSlabButtons(); buildOrientButtons(); buildZoomButtons(); buildObliqueButtons(); syncToolbarToActive(); }

    // BURNED-IN TEXT IS THE ONE PHI THIS SURFACE CAN PUT ON SCREEN WITHOUT NOTICING.
    //
    // Every other identifier the viewer handles is a header field it chooses whether to
    // render. A name burned into the pixels arrives with the anatomy, and MOS-DATA-040
    // permits exactly that: `pixel_phi.action: ALLOW` is "no modification; permitted only
    // when the consumer class is clinical_viewer". So the platform deliberately lets
    // unredacted pixels reach here, and the reader has to be told before they screenshot
    // it, export it or share the tab.
    //
    // ABSENT IS NOT NO. (0028,0301) is Type 1C and a study that never declares it is not a
    // study that declared it clean -- most secondary captures and re-photographed films
    // say nothing at all. The two are held apart in the wording rather than collapsed into
    // one warning, because "may" and "does" send a reader to different places.
    const burned = panel.stack.burnedInAnnotation;
    // NAMED, BECAUSE "THIS SERIES" IS AMBIGUOUS THE MOMENT THERE IS MORE THAN ONE PANEL.
    //
    // This warning is raised per SERIES, in this function, and rendered into the one
    // notice bar the surface has. On a 2x2 it fires four times as the panels fill and the
    // last one stands, so the reader is told that "this series" may carry patient
    // identifiers in its pixels while looking at four series, none of them named. A
    // warning about which pixels can be screenshotted has to say which pixels.
    const named = String(dv(row, '0008103E', '') || `series ${dv(row, '00200011', '?')}`);
    if (burned === 'YES') {
      notice(`“${named}” declares burned-in annotation: the PIXELS carry patient `
        + 'identifiers, and they travel with any screenshot or export of this view', 'err');
    } else if (panel.stack.burnedInUnknown) {
      notice(`“${named}” does not declare (0028,0301), so whether its pixels carry `
        + 'burned-in identifiers is unknown — it has not been screened by this surface', 'warn');
    } else {
      notice(warnings.length ? `${warnings.length} instance(s) refused: ${warnings[0].detail}` : '');
    }
    draw(panel);
    markSeriesAssignment();
    publishPanels('series-loaded');
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    if (mine()) notice(describe(err), 'err');
  } finally {
    if (inFlight.get(panel) === controller) inFlight.delete(panel);
  }
}

/** Every SEG and SR in the study, layered onto whichever panel its geometry actually fits. */
async function loadDerived(study, series, token) {
  for (const s of series.filter((x) => dv(x, '00080060') === 'SEG')) {
    try {
      const { instances } = await client.retrieveSeries(study, dv(s, '0020000E'));
      for (const inst of instances) {
        // Attached to every panel whose stack the SEG ALIGNS TO, decided by seg.js, not by
        // assuming it belongs to the active one. A SEG matching nothing is reported.
        let placed = 0;
        for (const p of panels) {
          if (!p.stack) continue;
          try {
            const decoded = decodeSegmentation(inst, p.stack);
            if (!decoded.planes.size) continue;
            p.seg = decoded;
            draw(p);
            placed++;
          } catch (e) { /* geometry mismatch: this SEG is not for this panel */ }
        }
        if (!placed) notice('a segmentation in this study matched no displayed series');
        break;
      }
      break;                    // MOS-IMG-066 defines no ordering across two label maps
    } catch (err) { notice(describe(err)); }
  }

  const rows = [];
  for (const s of series.filter((x) => dv(x, '00080060') === 'SR')) {
    try {
      const { instances } = await client.retrieveSeries(study, dv(s, '0020000E'));
      for (const inst of instances) rows.push(...readStructuredReport(inst));
    } catch (e) { /* an unreadable SR must not take the images down */ }
  }
  renderMeasurements(rows);
  publishPanels('derived-loaded');
}

/* ----------------------------------------------------------------------------------
 * side panels
 *
 * Nothing here renders a panel any more. Every panel is a registered contribution that
 * mounts into its slot and re-renders from state; the shell's job is to PUBLISH state
 * (see publishPanels) and never to call a panel's render function.
 * -------------------------------------------------------------------------------- */

/**
 * SR rows go into shared state; the registered measurements panel renders them.
 *
 * This function used to build the table itself. It was 40 lines of markup in the shell,
 * and converting it was the point of the registry: a panel is mounted once and re-renders
 * from state, rather than being called by whoever remembered to.
 */
function renderMeasurements(rows) {
  setState({ srMeasurements: rows }, 'derived');
}

/* ----------------------------------------------------------------------------------
 * toolbar
 * -------------------------------------------------------------------------------- */

/**
 * Light the preset the panel IS SHOWING, not the one last pressed.
 *
 * `applyPreset` was the only writer of this row's lit state, so every other route that
 * changes the window left it alone: the LEFT-DRAG handler -- which the hint text itself
 * advertises as `L-drag W/L`, and which is how a reader actually windows an image -- a
 * linked panel receiving a window from `applyWindowFrom`, and a new series arriving with
 * its own acquisition window. So `Lung` stayed lit while the reader dragged the window to
 * something else entirely, and the toolbar asserted a window that was not on screen.
 *
 * Derived rather than written, so there is no route left that can forget to update it.
 */
function syncPresetsToWindow(p) {
  if (!el.presets) return;
  const w = p && p.viewport ? p.viewport.window : null;
  const base = p && p.stack ? p.stack.defaultWindow : null;
  for (const b of el.presets.children) {
    const preset = PRESETS.find((x) => x.name === b.dataset.name);
    // `null` on a preset means "whatever the acquisition said", so it is compared against
    // the stack's own window rather than against a number.
    const c = preset && (preset.center === null ? base && base.center : preset.center);
    const width = preset && (preset.width === null ? base && base.width : preset.width);
    // ROUNDED, because a drag lands on fractional values and a reader who drags back to
    // exactly the lung window should see it light up again.
    const on = Boolean(w) && typeof c === 'number' && typeof width === 'number'
      && Math.round(w.center) === Math.round(c)
      && Math.round(w.width) === Math.round(width);
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
}

/**
 * Does this preset's unit match what the series actually measures?
 *
 * A window is a pair of numbers ON A SCALE. `presets.json` declares the scale its
 * conventions are written in -- Hounsfield units -- and `deriveUnit` decides what a series
 * is in: HU for CT or from (0028,1054), null when nothing says. Applying one to the other
 * is not a worse window, it is a window over a scale the data does not use.
 *
 * A preset with no `unit` is the acquisition's own (0028,1050/1051) and fits anything.
 */
function presetFitsStack(preset, stack) {
  if (!preset.unit) return true;
  return String(stack && stack.valueUnit || '').toUpperCase() === preset.unit.toUpperCase();
}

function applyPreset(preset) {
  const p = panels[active];
  if (!p || !p.stack) return;
  // THE REFUSAL LIVES HERE AND NOT ONLY ON THE BUTTON, because keys 2-6 reach this
  // function directly from the global handler. A guard on the control is a guard a
  // keystroke walks past.
  if (!presetFitsStack(preset, p.stack)) {
    notice(t('preset.wrongUnit',
      '“{name}” is a window in {unit}; this series does not measure in {unit}, so those '
      + 'numbers describe a scale its pixels are not on.')
      .replace(/\{name\}/g, preset.name).replace(/\{unit\}/g, preset.unit), 'warn');
    return;
  }
  const c = preset.center === null ? p.stack.defaultWindow.center : preset.center;
  const w = preset.width === null ? p.stack.defaultWindow.width : preset.width;
  p.viewport.setWindow(c, w);
  syncPresetsToWindow(p);
  draw(p);
  applyWindowFrom(p);
}

function buildPresets() {
  el.presets.innerHTML = '';
  for (const preset of PRESETS) {
    const b = document.createElement('button');
    b.className = 'tool';
    b.dataset.name = preset.name;
    b.textContent = preset.name;
    // THE SAME QUESTION THE KEYBOARD PATH ASKS, ASKED BEFORE THE READER COMMITS.
    // `buildPresets` runs on every series change (see `loadSeriesInto`), so a strip built
    // for a CT and then shown over an MR cannot go stale.
    const active_ = panels[active];
    const fits = !active_ || !active_.stack || presetFitsStack(preset, active_.stack);
    b.disabled = !fits;
    b.title = preset.center === null
      ? t('preset.acquisition', "The acquisition's own window (0028,1050/1051)")
      // W AND L AND THE NUMBERS STAY. `src/core/i18n.js` forbids translating a measured
      // value and a window width is one; only the word for the key is a label.
      : `W ${preset.width} L ${preset.center}  ·  `
        + `${t('common.key', 'key')} ${preset.key}`
        + (fits ? '' : '  ·  ' + t('preset.wrongUnit',
          '“{name}” is a window in {unit}; this series does not measure in {unit}, so those '
          + 'numbers describe a scale its pixels are not on.')
          .replace(/\{name\}/g, preset.name).replace(/\{unit\}/g, preset.unit));
    b.onclick = () => applyPreset(preset);
    el.presets.appendChild(b);
  }
}

function setPlane(plane) {
  const p = panels[active];
  if (!p || !p.stack || plane === p.plane) return;
  // THE GUARD LIVES HERE, not on the button, because the button is one of TWO call sites
  // and the keyboard is the other. Disabling the control and leaving `c` live would be a
  // half-conversion of exactly the kind this viewer has already paid for twice: the
  // surface would look like it refuses and the shortcut would still throw.
  //
  // And it asks `reconstructionRefusal` rather than restating the conditions, which is how
  // two of the four came to have no guard at all -- the two nobody remembered to copy.
  const refusal = reconstructionRefusal(p.stack, plane);
  if (refusal) { notice(`${refusal.code} — ${refusal.message}`, 'err'); return; }

  // The same reason `setIndex` does it: a partial measurement belongs to one plane of one
  // slice, and reprojecting its points onto a different plane would place them at pixel
  // coordinates that mean something else entirely.
  if (armed && armed.panel === p) { armed.handlers.onCancel(); preview = null; }

  p.plane = plane;
  for (const b of el.planes.children) b.classList.toggle('on', b.dataset.plane === plane);
  // The slab thickness the reader chose still stands -- it is a physical thickness and
  // means the same on the new plane. What changes is which thicknesses can be BUILT: a
  // 5 mm slab is three steps of a 0.7 mm coronal and less than two of a 2 mm axial, so the
  // strip is rebuilt to enable and disable against the new plane's own spacing.
  buildSlabButtons();
  buildObliqueButtons();
  setIndex(p, Math.floor(planeDepth(p.stack, plane) / 2));
  // AFTER `setIndex`, because that is what draws and therefore what sets `p.frame` -- and
  // `1:1` is decided from the frame's pixel spacing, which is 0.70 x 0.70 mm on this
  // study's axial and 2.00 x 0.70 mm on its coronal. Rebuilt before the new frame existed,
  // the button would carry the previous plane's verdict: offered on a plane where one
  // image pixel cannot be one screen pixel in both directions.
  buildZoomButtons();
}

/**
 * What to CALL a plane on this stack, or null when it cannot honestly be named.
 *
 * `p.plane` IS AN ADDRESS, NOT AN ANATOMY. `PLANES.AXIAL` means "the acquired plane", and
 * on a CT the acquired plane IS axial -- so printing the address read correctly for every
 * study this surface had ever been shown. On the first real MR it did not: three sagittal
 * lumbar acquisitions each reported "axial 6 / 11" in the bottom-right HUD, directly
 * beside the orientation letters H/A/P/F that said sagittal. The reader was told the plane
 * twice, by two mechanisms, and the two disagreed.
 *
 * SHARED WITH THE PLANE BUTTONS, which had already been taught this and left the HUD
 * behind. That is the whole failure: two surfaces name the same thing, one was fixed, and
 * nothing connected them. A second copy of this logic is a second thing to forget.
 */
function planeWording(stack, plane) {
  // A series whose slices face different ways has no plane to name. The one view it can
  // offer is the order the scanner wrote, which is a fact about the file and not anatomy.
  if (stack && stack.coplanar === false) {
    return plane === PLANES.AXIAL ? t('plane.asEncoded', 'as encoded') : null;
  }
  const anatomy = stack ? planeAnatomy(stack, plane) : null;
  if (!anatomy) return null;
  /*
   * THE GEOMETRY MODULE KEEPS SAYING `axial`, AND THAT IS THE RIGHT DIVISION.
   *
   * `planeAnatomy` decides which plane this is from (0020,0037) and returns one of
   * three English words. Those are a MODULE’S VOCABULARY -- three enumerated values
   * a caller switches on -- not text for a screen, and translating them there would
   * make `mpr.js` depend on the reader's language to answer a question about direction
   * cosines. This function is where the word reaches an eye, so this is where it is
   * translated: once, for the plane buttons, the HUD and the canvas name alike.
   */
  const PLANE_KEYS = {
    axial: 'plane.axial', coronal: 'plane.coronal', sagittal: 'plane.sagittal',
  };
  const said = t(PLANE_KEYS[anatomy.name] || '', anatomy.name).toLowerCase();
  return anatomy.oblique ? `${said}\u00b0` : said;
}

function buildPlaneButtons() {
  el.planes.innerHTML = '';
  // THE LABEL COMES FROM THE GEOMETRY, not from the address. See `planeAnatomy`: these
  // three names are what the code calls the acquired plane and its two reconstructions,
  // and on anything not acquired axially they name the wrong anatomy. The fallbacks are
  // used only before a stack is loaded, when there is nothing to ask.
  const defs = [
    ['Axial', PLANES.AXIAL, 'a'],
    ['Coronal', PLANES.CORONAL, 'c'],
    ['Sagittal', PLANES.SAGITTAL, 's'],
  ];
  const current = panels[active] ? panels[active].plane : PLANES.AXIAL;
  // A CINE LOOP OFFERS ONLY AXIAL, and the button says why rather than vanishing.
  //
  // `stack.spatial` is false when the frames carry no distinct positions -- a US cine, an
  // XA run -- which means the third axis is time. `mpr.js` refuses to reslice those, so an
  // enabled Coronal button here would be a control whose only outcome is an error notice.
  // Disabling it with the reason in the tooltip is the difference between a surface that
  // cannot do something and one that appears broken.
  const stack = panels[active] ? panels[active].stack : null;
  for (const [fallback, plane, key] of defs) {
    const b = document.createElement('button');
    // WHAT THIS BUTTON WILL ACTUALLY SHOW. The acquired plane is marked, because it is the
    // only one of the three that is not a reconstruction and a reader is entitled to know
    // which picture is the data and which is derived from it.
    // ONE RESOLVER, shared with the HUD. See `planeWording`.
    const word = planeWording(stack, plane);
    let label = fallback;
    if (word) {
      label = word.charAt(0).toUpperCase() + word.slice(1);
      // Only a series that HAS a plane has an acquired one to mark.
      if (plane === PLANES.AXIAL && stack && stack.coplanar !== false) {
        label += ` \u00b7 ${t('plane.acquiredMark', 'acquired')}`;
      }
    }
    // ASK THE MODULE. This guarded two of reslice's four refusals with its own copy of the
    // conditions, so a series with a per-frame Modality LUT or an uncorrectable gantry
    // tilt offered a button that threw when pressed.
    const refusal = stack ? reconstructionRefusal(stack, plane) : null;
    const offered = !refusal;
    b.className = `tool${plane === current ? ' on' : ''}`;
    b.dataset.plane = plane;
    b.textContent = label;
    b.disabled = !offered;
    // THE REASON IS THE MODULE'S OWN SENTENCE, so a reader is told the same thing the
    // refusal would have said -- and a refusal added to the module reaches this tooltip
    // without anybody remembering to write a second version of it here.
    b.title = offered
      ? `${label} ${t('plane.reconstruction', 'reconstruction')}  ·  `
        + `${t('common.key', 'key')} ${key}`
      : `${label}: ${refusal.message}`;
    if (offered) b.onclick = () => setPlane(plane);
    el.planes.appendChild(b);
  }
}

/**
 * Slab thickness for the active panel, in millimetres.
 *
 * MILLIMETRES AND NOT SLICES, because a slab is a physical thickness. 10 mm is 10 mm on
 * the axial and on the coronal; "5 slices" is 10 mm on one and 3.5 mm on the other, and a
 * reader comparing two panels would be comparing two different things while the control
 * read the same on both. `slabPlan` rounds the request DOWN to whole positions and the HUD
 * states what it actually projected, so the two never disagree silently.
 *
 * `Off` is first and is the default. A viewer that opens in projection is a viewer whose
 * first impression is a picture of no slice.
 */
/**
 * Rotate and flip for the active panel.
 *
 * These compose onto what is already applied, because the reader pressed a button about
 * the picture in front of them: "rotate right" turns what they can see, not the stored
 * frame. `Reset` is offered whenever anything is applied, and is the only way back --
 * pressing rotate four times also works, and a reader who has flipped and rotated should
 * not have to work out which sequence undoes it.
 *
 * The orientation markers follow every one of these. That is checked by a gate, and it is
 * the reason these buttons did not exist until the markers did: a flip that leaves `R`
 * where it was is worse than no marker, because an absent marker sends a reader to the
 * header and a wrong one does not send them anywhere.
 */
/**
 * Fit and 1:1.
 *
 * `Fit` is zoom 1, which is what `fitOf` means by fitting: the whole picture inside the
 * panel with its physical proportions kept.
 *
 * `1:1` is one image pixel per DEVICE pixel -- not one millimetre per millimetre. No
 * browser can offer the second: it needs the display's physical size, and `devicePixelRatio`
 * is a ratio to the CSS pixel, which is defined against a notional 96 dpi rather than a
 * measured one. The scale bar in the corner of every panel is the honest answer to "how big
 * is that", and it is why this strip does not carry an "actual size" button.
 *
 * The control refuses a frame whose pixels are not square, because on one there is no zoom
 * at which both directions are 1:1 without abandoning the physical fit -- and abandoning it
 * would stretch every shape on screen to satisfy a button. `zoomForOneToOne` returns null
 * and the reason goes in the tooltip, the way the plane buttons refuse uneven spacing.
 */
function buildZoomButtons() {
  if (!el.zooms) return;
  el.zooms.innerHTML = '';
  const p = panels[active];
  const ready = p && p.stack && p.frame && p.canvas.width > 0;

  const fit = document.createElement('button');
  fit.className = `tool${ready && !p.viewport.oneToOne && p.viewport.zoom === 1 ? ' on' : ''}`;
  fit.dataset.zoom = 'fit';
  fit.textContent = 'Fit';
  fit.title = t('zoom.fit', 'The whole picture inside the panel, in its own proportions');
  fit.disabled = !ready;
  if (ready) {
    // `draw` FIRST. `applyViewFrom` propagates to the OTHER panels and returns early when
    // zoom is not linked, so a handler that only calls it changes the number and never
    // redraws the panel the reader pressed the button on. `resetView` gets away with the
    // same shape because `applyPreset` redraws behind it.
    fit.onclick = () => {
      p.viewport.zoom = 1;
      p.viewport.pan = [0, 0];
      p.viewport.oneToOne = false;
      draw(p);
      applyViewFrom(p);
      buildZoomButtons();
    };
  }
  el.zooms.appendChild(fit);

  const one = document.createElement('button');
  const rect = ready ? p.canvas.getBoundingClientRect() : null;
  const target = ready
    ? zoomForOneToOne(p.frame, { width: rect.width, height: rect.height },
      p.viewport.deviceSize(), viewOf(p.viewport))
    : null;
  one.className = `tool${ready && p.viewport.oneToOne ? ' on' : ''}`;
  one.dataset.zoom = 'one-to-one';
  one.textContent = '1:1';
  one.disabled = !target;
  const [rowMm, colMm] = (p && p.frame && p.frame.pixelSpacing) || [1, 1];
  one.title = target
    ? t('zoom.oneToOne', 'One image pixel per screen pixel · not one millimetre per '
      + 'millimetre, which no browser can know — use the scale bar for size')
    : (ready
      ? `This plane's pixels are ${rowMm.toFixed(2)} × ${colMm.toFixed(2)} mm, so one `
        + 'image pixel cannot be one screen pixel in both directions without stretching the '
        + 'picture and making every caliper on it wrong.'
      : 'No series loaded');
  if (target) {
    one.onclick = () => {
      // A MODE, not a number. `Fit` survives a window resize because zoom 1 MEANS fit --
      // `fitOf` recomputes it from the live panel every draw. A 1:1 stored as the scalar
      // it happened to work out to does not: measured here, the layout moved between the
      // click and the draw and the picture came out at 438 of the 448 device pixels the
      // control promises. 2% is invisible and the control's entire claim is exactness, so
      // it is recomputed each draw like the fit it sits beside.
      p.viewport.oneToOne = true;
      draw(p);
      applyViewFrom(p);
      buildZoomButtons();
    };
  }
  el.zooms.appendChild(one);
}

function buildOrientButtons() {
  if (!el.orient) return;
  el.orient.innerHTML = '';
  const p = panels[active];
  const applied = p && p.viewport && isTransformed(p.viewport.transform || NO_TRANSFORM);

  const defs = [
    // KEYS NAMED `mirrorH`/`mirrorV`, NOT `flipH`/`flipV`.
    // `test_the_view_transform_is_one_matrix_rather_than_three_flags` forbids `.flipH`
    // and `.flipV` anywhere in the viewer's source: a boolean beside the transform matrix
    // is a second source of truth and the two disagree the first time one is set alone.
    // The gate greps text, so a TRANSLATION KEY spelled `orient.flipH` reads exactly like
    // the property it bans. Renaming the key is the cheap side of that trade; weakening
    // the gate to admit a string literal would blind it to the real thing.
    ['rotate', 'rotate', rotatedRight,
     t('orient.rotate', 'Rotate a quarter turn clockwise')],
    ['flipH', 'flip-h', flippedHorizontally, t('orient.mirrorH', 'Mirror left to right')],
    ['flipV', 'flip-v', flippedVertically, t('orient.mirrorV', 'Mirror top to bottom')],
  ];
  for (const [glyph, id, op, title] of defs) {
    const b = document.createElement('button');
    b.className = 'itool';
    b.type = 'button';
    b.dataset.orient = id;
    b.innerHTML = icon(glyph);
    b.setAttribute('aria-label', title);
    b.title = `${title} · ${t('orient.lettersFollow', 'the orientation letters follow')}`;
    b.disabled = !p || !p.stack;
    if (!b.disabled) {
      b.onclick = () => {
        p.viewport.transform = op(p.viewport.transform || NO_TRANSFORM);
        buildOrientButtons();
        draw(p);
      };
    }
    el.orient.appendChild(b);
  }

  const reset = document.createElement('button');
  // A CONDITION, NOT A SELECTION. `applied` is true when the reader HAS transformed the
  // picture, so `.on` lit the button labelled `As acquired` precisely when the picture
  // was not -- and `disabled` then dimmed it in the safe case. The control naming the
  // safe state announced the unsafe one.
  reset.className = `tool${applied ? ' altered' : ''}`;
  reset.dataset.orient = 'as-acquired';
  reset.textContent = t('orient.asAcquired', 'As acquired');
  reset.title = applied
    ? t('orient.asStoredBack', 'Back to the orientation the archive stored')
    : t('orient.asStored', 'The picture is in the orientation the archive stored');
  reset.disabled = !applied;
  if (applied) {
    reset.onclick = () => {
      p.viewport.transform = NO_TRANSFORM;
      buildOrientButtons();
      draw(p);
    };
  }
  el.orient.appendChild(reset);
}

function buildSlabButtons() {
  if (!el.slab) return;
  el.slab.innerHTML = '';
  const p = panels[active];
  const step = p && p.stack ? planeStepMm(p.stack, p.plane) : null;
  // A SERIES WHOSE MODALITY LUT VARIES OFFERS NO SLAB AT ALL.
  //
  // `reslice` refuses to project across frames that map stored values differently, and the
  // refusal is checked against the slab's own span -- which moves as the reader scrolls. A
  // thickness enabled at slice 10 could therefore throw at slice 40, which is a control
  // that works until it does not. The whole series is refused instead, for the same reason
  // the plane buttons refuse a whole series with uneven spacing rather than refusing it
  // slice by slice.
  const mixed = p && p.stack
    ? rescaleVariesOver(p.stack.frames, 0, p.stack.depth - 1)
    : null;
  // AND A SERIES WITH UNEVEN GAPS OFFERS NO SLAB ON ANY PLANE. The Coronal and Sagittal
  // buttons already refuse it; the axial plane stays available because it selects a frame
  // rather than resampling between them -- but a slab through that plane does cross them,
  // and would quote its thickness at the median gap. Refused here as well as in `reslice`,
  // so the throw is unreachable from the toolbar.
  const uneven = Boolean(p && p.stack && p.stack.uniformSpacing === false);

  // WHAT IS ACTUALLY ON SCREEN, not what was asked for. `p.frame.projection` is set by
  // `reslice` only when a slab was really built, so keying the lit state on it means the
  // strip cannot claim a MIP over a slice that was never projected -- which is what
  // happened when a thickness buildable on the coronal was carried to a coarser axial.
  const projecting = Boolean(p && p.frame && p.frame.projection);
  // And a mode button is only meaningful where SOME thickness can be built on this plane.
  const anyBuildable = step !== null && [5, 10, 20, 50].some((mm) => slabHalf(mm, step));

  const mode = document.createElement('button');
  const isMin = p && p.slab && p.slab.mode === 'min';
  mode.className = `tool${projecting ? ' on' : ''}`;
  mode.disabled = Boolean(mixed) || uneven || !anyBuildable;
  mode.dataset.slabMode = isMin ? 'min' : 'max';
  mode.textContent = isMin ? 'MinIP' : 'MIP';
  mode.title = isMin
    ? t('slab.minip', 'Minimum intensity along each ray · airways and emphysema. '
      + 'Click for MIP.')
    : t('slab.mip', 'Maximum intensity along each ray · nodules and vessels. '
      + 'Click for MinIP.');
  mode.onclick = () => {
    if (!p) return;
    // The first thickness this plane can build, rather than a fixed 10 mm -- on a 5 mm
    // axial nothing below 25 mm exists, and defaulting to 10 lit the control over a slice
    // `slabPlan` had refused.
    const usable = [5, 10, 20, 50].filter((mm) => slabHalf(mm, step));
    const keep = p.slab && slabHalf(p.slab.mm, step) ? p.slab.mm : usable[0];
    if (!keep) return;
    p.slab = { mm: keep, mode: isMin ? 'max' : 'min' };
    buildSlabButtons();
    draw(p);
  };
  el.slab.appendChild(mode);

  for (const mm of [0, 5, 10, 20, 50]) {
    const b = document.createElement('button');
    const on = mm === 0 ? !projecting : Boolean(projecting && p.slab && p.slab.mm === mm);
    b.className = `tool${on ? ' on' : ''}`;
    b.dataset.slabMm = String(mm);
    b.textContent = mm === 0 ? t('slab.off', 'Off') : `${mm}`;
    // A REQUEST TOO THIN FOR THREE POSITIONS IS NOT A SLAB. On a 2 mm series a 5 mm slab
    // would have to round up to 6 mm to exist, and `slabPlan` refuses to round up. The
    // button says so rather than doing nothing when pressed.
    const tooThin = mm > 0 && step !== null && !slabHalf(mm, step);
    b.disabled = !p || !p.stack || tooThin || (mm > 0 && (Boolean(mixed) || uneven));
    b.title = mm > 0 && uneven
      ? t('slab.uneven', 'The gaps between these slices are not equal, so a slab would '
        + 'quote its thickness at the median gap and state a distance the rays did not '
        + 'travel.')
      : mm > 0 && mixed
      ? t('slab.mixedScale', 'This series maps stored values to output units differently '
        + 'across frames, so the extreme along a ray would be decided by which frame had '
        + 'the coarser scale rather than by which voxel was denser.')
      : tooThin
        // THE NUMBERS ARE SUBSTITUTED, NOT TRANSLATED. `{mm}` and `{step}` carry a
        // millimetre figure read off the series; `src/core/i18n.js` forbids a translation
        // from touching a measured value, and a slab thickness is one.
        ? t('slab.tooThin', '{mm} mm is thinner than three {step} mm steps of this plane, '
          + 'so a slab that thick cannot be built without projecting more than was asked '
          + 'for.').replace('{mm}', String(mm)).replace('{step}', step.toFixed(2))
        : mm === 0
          ? t('slab.none', 'One plane, no projection · every value is a value of that plane')
          : t('slab.thick', '{mm} mm slab · values become extremes along a ray, not '
            + 'densities').replace('{mm}', String(mm));
    if (!b.disabled) {
      b.onclick = () => {
        p.slab = mm === 0 ? null : { mm, mode: p.slab ? p.slab.mode : 'max' };
        buildSlabButtons();
        draw(p);
      };
    }
    el.slab.appendChild(b);
  }
}

/** The angles offered. A step a reader can hold in their head, and 90 is the coronal. */
const OBLIQUE_STEP = 15;

/**
 * The oblique controls: which lattice axis to keep, and how far to tilt off it.
 *
 * ONE PROBE ANSWERS FOR THE WHOLE FAMILY, and that is sound rather than lucky: every one of
 * the seven refusals `reconstructionRefusal` can return for an oblique is ANGLE-INDEPENDENT
 * -- four are about the series (time rather than distance, uneven gaps, an uncorrectable
 * tilt, a per-frame Modality LUT) and three about its orientation, spacing and shear. So the
 * state of this control is decided by asking about one angle, and the tooltip carries the
 * module's own sentence for whichever reason applied.
 */
function buildObliqueButtons() {
  if (!el.oblique) return;
  el.oblique.innerHTML = '';
  const p = panels[active];
  const stack = p ? p.stack : null;
  const probe = stack ? reconstructionRefusal(stack, obliqueName('x', 45)) : null;
  const here = p ? obliqueParts(p.plane) : null;

  for (const axis of ['x', 'y']) {
    const b = document.createElement('button');
    const on = Boolean(here && here.axis === axis);
    b.className = `tool${on ? ' on' : ''}`;
    b.dataset.oblique = axis;
    b.textContent = axis === 'x' ? 'Obl X' : 'Obl Y';
    b.disabled = !stack || Boolean(probe);
    b.title = probe
      ? `${probe.code} — ${probe.message}`
      : (axis === 'x'
        ? t('oblique.x', 'Tilt off the axial about the patient’s left-right axis '
          + '· 90° is the coronal')
        : t('oblique.y', 'Tilt off the sagittal · the plane keeps the source’s row axis'));
    if (!b.disabled) {
      b.onclick = () => setPlane(obliqueName(axis, here && here.axis === axis ? here.deg : 45));
    }
    el.oblique.appendChild(b);
  }

  for (const delta of [-OBLIQUE_STEP, OBLIQUE_STEP]) {
    const b = document.createElement('button');
    b.className = 'tool';
    b.dataset.obliqueStep = String(delta);
    b.textContent = delta < 0 ? `−${OBLIQUE_STEP}°` : `+${OBLIQUE_STEP}°`;
    // A STEP OFF THE END IS NOT AN OBLIQUE. `obliqueName` returns null at 0 and at 90,
    // because those planes already have names and a second name for the axial would split
    // the address every measurement is drawn by.
    const next = here ? obliqueName(here.axis, here.deg + delta) : null;
    b.disabled = !next;
    b.title = next
      ? `${next}`
      : (here
        ? `${here.deg + delta}° is a plane that already has a name, or past the far side `
          + 'of one. Use the Axial, Coronal and Sagittal buttons for those.'
        : t('oblique.pickFirst', 'Pick an oblique axis first'));
    if (next) b.onclick = () => setPlane(next);
    el.oblique.appendChild(b);
  }
}

/** The largest grid the picker offers. Four panels a side is already more than a reader
 *  can window/level independently; past it the control is a demonstration, not a tool. */
const LAYOUT_MAX = 4;

function buildLayoutButtons() {
  el.layouts.innerHTML = '';
  // THE THREE A READER REACHES FOR STAY ONE CLICK AWAY. Everything else moved behind the
  // picker rather than becoming three more buttons: `.bar-tools` is `overflow: hidden`
  // and does not wrap, and six controls were measured clipped out of it -- out of paint
  // AND out of hit-testing -- at widths this surface is actually used at.
  for (const [label, cols, rows] of [['1×1', 1, 1], ['1×2', 2, 1], ['2×2', 2, 2]]) {
    const b = document.createElement('button');
    b.className = 'tool';
    b.dataset.layout = `${cols}x${rows}`;
    b.textContent = label;
    b.title = cols * rows === 1
      ? t('layout.onePanel', '1 panel')
      : t('layout.nPanels', '{n} panels').replace('{n}', String(cols * rows));
    b.onclick = () => setLayout(cols, rows);
    el.layouts.appendChild(b);
  }
  el.layouts.appendChild(buildLayoutPicker());
}

/**
 * A grid picker for every layout up to 4x4.
 *
 * WHY A GRID AND NOT MORE BUTTONS. The shape of the answer IS a grid, so a reader picking
 * 2x3 points at a 2x3 instead of reading six labels and translating. It also costs one
 * control's width rather than thirteen, which matters on the one row of this surface that
 * cannot wrap.
 *
 * IT ANSWERS THE KEYBOARD. The cells are a `grid` role with roving focus: arrows move,
 * Enter and Space apply, Escape closes and returns focus to the button. A picker only a
 * pointer can reach would put every layout past 2x2 out of reach of a reader who does not
 * use one -- which is most of this surface's accessibility work undone in one control.
 */
function buildLayoutPicker() {
  const wrap = document.createElement('span');
  wrap.className = 'layout-pick-wrap';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'itool layout-pick';
  button.id = 'layout-pick';
  button.setAttribute('aria-haspopup', 'true');
  button.setAttribute('aria-expanded', 'false');
  button.title = t('layout.more', 'Choose a layout up to 4 by 4');
  button.innerHTML = `${icon('layout')}<span class="sr-only">`
    + `${escape(t('layout.more', 'Choose a layout up to 4 by 4'))}</span>`;

  const menu = document.createElement('div');
  menu.className = 'layout-grid';
  menu.hidden = true;
  menu.setAttribute('role', 'grid');
  menu.setAttribute('aria-label', t('layout.more', 'Choose a layout up to 4 by 4'));

  const cells = [];
  for (let r = 1; r <= LAYOUT_MAX; r++) {
    for (let c = 1; c <= LAYOUT_MAX; c++) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'layout-cell';
      cell.dataset.rows = String(r);
      cell.dataset.cols = String(c);
      cell.tabIndex = -1;
      cell.setAttribute('role', 'gridcell');
      // THE NAME IS THE SHAPE AND THE COUNT, because a screen reader gets no picture:
      // "3 by 2, 6 panels" is the whole of what the cell means.
      // `1 by 1, 1 panels` IS WHAT A `{n}` SUBSTITUTION GIVES YOU, and a screen reader
      // reads it out loud. The single-panel case already has its own string, for the
      // same reason the three buttons above use it.
      cell.setAttribute('aria-label', r * c === 1
        ? t('layout.onePanel', '1 panel')
        : t('layout.pick', '{r} by {c}, {n} panels')
          .replace('{r}', String(r)).replace('{c}', String(c))
          .replace('{n}', String(r * c)));
      cell.onmouseenter = () => preview(r, c);
      cell.onfocus = () => preview(r, c);
      cell.onclick = () => { setLayout(c, r); close(); button.focus(); };
      cells.push(cell);
      menu.appendChild(cell);
    }
  }

  const readout = document.createElement('span');
  readout.className = 'layout-readout';
  readout.setAttribute('aria-hidden', 'true');
  menu.appendChild(readout);

  function preview(r, c) {
    for (const cell of cells) {
      const within = Number(cell.dataset.rows) <= r && Number(cell.dataset.cols) <= c;
      cell.classList.toggle('in', within);
    }
    // ROWS FIRST, because the three buttons beside this picker already say `1×2` for one
    // row of two. A picker that read `2×1` for the same shape would make the reader
    // translate between two spellings of one layout on one toolbar.
    readout.textContent = `${r}×${c}`;
  }

  function close() {
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  }

  function open() {
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    const at = cells.find((cell) => Number(cell.dataset.rows) === Math.max(1, layoutRows)
      && Number(cell.dataset.cols) === Math.max(1, layoutCols)) || cells[0];
    at.focus();
  }

  button.onclick = (e) => { e.stopPropagation(); if (menu.hidden) open(); else close(); };
  menu.onkeydown = (e) => {
    if (e.key === 'Escape') { close(); button.focus(); return; }
    const here = cells.indexOf(document.activeElement);
    if (here < 0) return;
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: LAYOUT_MAX, ArrowUp: -LAYOUT_MAX }[e.key];
    if (!step) return;
    e.preventDefault();
    const to = here + step;
    // NO WRAPPING. Arrowing off the right edge of row 2 onto row 3 moves the pointer two
    // panels in a direction the reader did not press.
    if (to < 0 || to >= cells.length) return;
    if (Math.abs(step) === 1 && Math.floor(to / LAYOUT_MAX) !== Math.floor(here / LAYOUT_MAX)) return;
    cells[to].focus();
  };
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !wrap.contains(e.target)) close();
  });

  wrap.append(button, menu);
  return wrap;
}

/**
 * One button per registered TOOL contribution.
 *
 * Read from the registry rather than listed here, so adding a tool is a module plus an
 * import and never an edit to this function -- the whole point of src/core/registry.js.
 */
function buildToolButtons() {
  if (!el.barVerbs || !el.barToggles) return;
  el.barVerbs.innerHTML = '';
  el.barToggles.innerHTML = '';

  // THE MEASURE TOOLS, as glyphs. `tool.icon` is declared where the tool is, so a
  // contribution that grows a glyph does not need this function edited -- and one that
  // does not declare one still gets a button, labelled, rather than an empty square.
  for (const tool of contributions(KINDS.TOOL)) {
    el.barVerbs.appendChild(iconButton({
      id: tool.id,
      glyph: tool.icon,
      fallback: tool.title,
      label: toolName(tool),
      // A TOOL MAY SAY WHAT IT IS FOR IN THE READER'S OWN WORDS. `Freehand ROI` is the
      // correct name and it is not the word a reader reaches for: one went looking for
      // "the pen" and did not find it, because nothing on the surface carries that word.
      // The hint adds the synonym without RENAMING the tool, which matters -- calling this
      // one a pen would promise free drawing, and what it does is measure.
      title: `${toolName(tool)} \u00b7 `
        + t('tool.arms', 'key {k} \u00b7 arms for one measurement, then returns to navigation')
          .replace('{k}', tool.key)
        + (toolHint(tool) ? ` \u2014 ${toolHint(tool)}` : ''),
      onClick: () => armTool(armed && armed.tool.id === tool.id ? null : tool),
    }));
  }

  // THE TOGGLES. Each still owns its own handler in `attachGlobalInteraction`; these are
  // the same buttons by id, so nothing below this line had to learn a new name.
  for (const [id, glyph, name, title] of [
    ['t-invert', 'invert', t('toggle.invert', 'Invert'),
     t('toggle.invertWhy', 'Invert greyscale (I)')],
    ['t-overlay', 'overlay', t('toggle.overlay', 'Segmentation overlay'),
     t('toggle.overlayWhy', 'Show or hide the segmentation (O)')],
    ['t-fusion', 'overlay', t('toggle.fusion', 'Fusion'),
     t('toggle.fusionWhy', 'Lay a second acquisition over this one (F)')],
    ['t-cine', 'cine', t('toggle.cine', 'Cine'),
     t('toggle.cineWhy', 'Cine play (Space)')],
    ['t-reset', 'reset', t('toggle.reset', 'Reset view'),
     t('toggle.resetWhy', 'Reset zoom, pan and window (double-click)')],
    ['t-capture', 'capture', t('toggle.capture', 'Capture'),
     t('toggle.captureWhy', 'Save this panel as a PNG, with its annotations and a caption')],
    ['t-csv', 'table', t('toggle.export', 'Export measurements'),
     t('toggle.exportWhy', 'Save the measurements of this study as CSV, with their provenance')],
  ]) {
    const b = iconButton({ glyph, fallback: name, label: name, title });
    b.id = id;
    el.barToggles.appendChild(b);
  }
  // Rebound, because the elements they were attached to no longer exist.
  el.invert = $('t-invert');
  el.overlay = $('t-overlay');
  el.fusion = $('t-fusion');
  el.cine = $('t-cine');
  el.reset = $('t-reset');
  el.capture = $('t-capture');
  el.csv = $('t-csv');
  bindToggles();
}

/** A 1x18 rule between groups of glyphs. */
function divider() {
  const d = document.createElement('span');
  d.className = 'tool-sep';
  return d;
}

/**
 * One glyph button.
 *
 * THE NAME IS ON THE BUTTON, not on the icon: `aria-label` plus `title`, so the control is
 * announced once and hovering explains it. A toolbar of unlabelled glyphs is unusable by
 * anyone who has not already learnt it, and unreachable by anyone using a screen reader --
 * which is the trade an icon toolbar makes and the reason it has to be paid here.
 */
function iconButton({ id, glyph, fallback, title, label, onClick }) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'itool';
  if (id) b.dataset.tool = id;
  b.title = title;
  // THE NAME AND THE EXPLANATION ARE DIFFERENT STRINGS. A screen reader announces the
  // accessible name every time focus lands, and "Length, key m, arms for one measurement,
  // then returns to navigation" is a sentence to sit through on each of fourteen buttons.
  // The name is the name; the sentence stays in `title`, read on demand.
  b.setAttribute('aria-label', label || title);
  const svg = glyph ? icon(glyph) : '';
  if (svg) b.innerHTML = svg;
  else { b.textContent = fallback; b.classList.add('tool'); b.classList.remove('itool'); }
  if (onClick) b.onclick = onClick;
  return b;
}

/**
 * Type into a note, over the image, where it sits.
 *
 * INLINE AND IN PLACE, because a dialogue for one short string is a dialogue the reader
 * has to dismiss, and because a note's whole point is that it belongs to a spot on the
 * anatomy -- typing it somewhere else breaks the association while it is being made.
 *
 * AN EMPTY NOTE IS REMOVED RATHER THAN KEPT. Escape, or a blank commit, leaves nothing:
 * a marker with no text is a dot on the image that says nothing and cannot be read, and
 * a reader who changed their mind should not have to delete what they did not create.
 */
function editNote(panel, m) {
  const host = panel.canvas.parentElement;
  if (!host) return;
  const box = panel.canvas.getBoundingClientRect();
  // THE SAME TRANSFORM THE ANNOTATION LAYER USES, so the box opens exactly where the
  // marker was drawn. A second way of converting a pixel to a screen point is a second
  // thing to get wrong, and the symptom would be an editor a few pixels off the note
  // it belongs to -- which reads as sloppiness rather than as a bug.
  const at = panel.frame
    ? imageToScreen(panel.frame, { width: box.width, height: box.height },
      viewOf(panel.viewport), m.points[0])
    : null;
  const input = document.createElement('input');
  input.className = 'note-input';
  input.setAttribute('aria-label', 'Text for this note');
  input.placeholder = 'Note';
  input.style.left = `${(at ? at.x : box.width / 2) + 14}px`;
  input.style.top = `${(at ? at.y : box.height / 2) - 26}px`;
  host.appendChild(input);
  input.focus();

  const done = (keep) => {
    if (input.dataset.done) return;
    input.dataset.done = '1';
    const text = input.value.trim();
    input.remove();
    if (keep && text) {
      setState({
        measurements: getState().measurements.map((x) => (x.id === m.id
          ? Object.freeze({ ...x, text })
          : x)),
      }, 'note');
    } else {
      setState({
        measurements: getState().measurements.filter((x) => x.id !== m.id),
        selectedMeasurement: null,
      }, 'note');
    }
  };
  input.onblur = () => done(true);
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); done(true); }
    if (e.key === 'Escape') { e.preventDefault(); done(false); }
    // Every other key belongs to the box. Without this, `d` arms the freehand tool and
    // Delete removes the note being typed into, from the shell's own global bindings.
    e.stopPropagation();
  };
}

/**
 * A tool's name and its hint, in the reader's language.
 *
 * THE REGISTRY KEEPS ENGLISH, AND THAT IS CORRECT. `src/tools/measure-tools.js`
 * registers `title: 'Length'` -- an identifier for whoever is reading the source, not a
 * string for the screen. The table is consulted by the tool's `id`, so a tool contributed
 * by somebody else with no key in the table shows its own English name rather than
 * `tool.medos.length`, which is the right failure.
 */
const TOOL_KEYS = {
  'medos.length': 'length',
  'medos.angle': 'angle',
  'medos.roi-ellipse': 'roi',
  'medos.roi-rect': 'rectRoi',
  'medos.roi-freehand': 'freehandRoi',
  'medos.note': 'textNote',
};

/*
 * A MAP, NOT A DERIVATION, and the first version was a derivation.
 *
 * `id.split('.').pop()` turns `medos.roi-freehand` into `roi-freehand`, and the table's
 * key is `tool.freehandRoi`. Four of the six tools looked up a key nobody had written and
 * fell back to English -- silently, because falling back to English is what `t()` is FOR.
 * A missing translation and a wrong key produce the same screen, which is why this was
 * caught by reading the rendered toolbar rather than by reading the code.
 */
function toolName(tool) {
  const key = TOOL_KEYS[tool.id];
  return key ? t(`tool.${key}`, tool.title || tool.id) : (tool.title || tool.id);
}

function toolHint(tool) {
  if (!tool.hint) return '';
  const key = TOOL_KEYS[tool.id];
  if (!key) return tool.hint;
  return t(`tool.hint${key.charAt(0).toUpperCase()}${key.slice(1)}`, tool.hint);
}

function armTool(tool) {
  if (armed) armed.handlers.onCancel();
  armed = null;
  preview = null;
  if (tool) {
    const p = panels[active];
    if (!p || !p.stack) return;
    armed = {
      tool,
      panel: p,
      handlers: tool.handlers(
        p,
        // A LIVE ADDRESS, NOT A SNAPSHOT OF ONE. This used to be the object literal
        // `{ plane: p.plane, index: p.index, seriesUID: p.seriesUID }`, evaluated once when
        // the tool was armed. A tool is armed and then used, and between those two moments
        // the reader can scroll, change plane or load another series -- so the measurement
        // was addressed to wherever the panel happened to be when the BUTTON was pressed
        // and valued from wherever it was when the GESTURE finished. The record came out
        // internally inconsistent: `sliceIndex` from arm time, `sopInstanceUID`,
        // `pixelSpacing` and the arithmetic itself from commit time. Reading through to the
        // panel means the address is whatever the reader was actually looking at.
        {
          get plane() { return p.plane; },
          get index() { return p.index; },
          get seriesUID() { return p.seriesUID; },
          // AND WHICH STUDY, for the same reason one line up and one that got sharper the
          // moment a prior could be on screen. A measurement is stored under a study UID,
          // and the surface used to have exactly one to store it under -- so a caliper
          // placed on the panel holding the PRIOR would have been written into the
          // CURRENT study's record, recalled onto the current study on the next visit,
          // and listed there as a number taken from a picture it was never taken from.
          get studyUID() { return p.studyUID; },
          // AND WHAT THAT PLANE IS CALLED. `plane` is an address -- PLANES.AXIAL means
          // 'the acquired plane' -- and the measurements panel printed it raw, so a
          // region traced on a sagittal MR produced a row reading 'axial 3' while the
          // HUD three inches away read 'as encoded 3 / 5'. The panel renders from state
          // and holds no stack, so it cannot ask the geometry at render time; the word
          // is recorded here for the same reason `resolutionMm` and `spacingStated`
          // are -- the row outlives the frame it was taken on.
          get planeName() { return planeWording(p.stack, p.plane); },
        },
        (m) => {
          setState({ measurements: [...getState().measurements, m] }, 'tool');
          armTool(null);
          // A NOTE ARRIVES EMPTY AND NEEDS TYPING INTO. The tool places the anchor and
          // owns no DOM; the shell owns the canvas, so the editor opens here. Deferred a
          // frame so the annotation layer has drawn the marker the editor sits beside.
          if (m.kind === 'note' && !m.text) requestAnimationFrame(() => editNote(p, m));
        },
        (preview_) => { preview = preview_; draw(panels[active]); },
      ),
    };
  }
  // IN THE CONTAINER THE BUTTONS ARE ACTUALLY IN. This iterated `el.tools`, which is the
  // value bar below the image; the tool buttons moved into the header's `#bar-verbs` and
  // the lit state was left looking at an element that no longer holds them -- so arming a
  // tool worked and nothing on screen said so.
  for (const b of el.barVerbs ? el.barVerbs.children : []) {
    const on = Boolean(armed) && b.dataset.tool === armed.tool.id;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
  // The cursor says which mode the surface is in without the reader having to remember.
  //
  // AND THE ANNOTATIONS STOP TAKING CLICKS. While a tool is armed the reader is placing a
  // new measurement, so an existing one under the pointer is scenery -- if its stroke
  // could still take the press, drawing across anything already measured would silently
  // do nothing.
  for (const p of panels) {
    p.canvas.style.cursor = armed ? 'crosshair' : 'default';
    if (p.annotations && p.annotations.svg) {
      p.annotations.svg.classList.toggle('annot-inert', Boolean(armed));
    }
  }
  draw(panels[active]);
}

function buildLinkButtons() {
  el.links.innerHTML = '';
  const defs = [
    [t('link.scroll', 'Link scroll'), 'scroll', 'link',
     t('link.scrollWhy', 'Scrolling one panel scrolls the others. By patient position '
       + 'where the series share a Frame of Reference, by proportion otherwise — each '
       + 'panel says which.')],
    [t('link.window', 'Link W/L'), 'window', 'contrast',
     t('link.windowWhy', 'Window and level follow the active panel.')],
    [t('link.zoom', 'Link zoom'), 'zoomPan', 'zoom',
     t('link.zoomWhy', 'Zoom and pan follow the active panel.')],
  ];
  for (const [label, key, glyph, title] of defs) {
    const b = document.createElement('button');
    b.className = `itool${link[key] ? ' on' : ''}`;
    b.type = 'button';
    b.innerHTML = icon(glyph);
    // The NAME is the label; the sentence is the explanation. Both on the button, because
    // a glyph that only a tooltip explains is unreachable by anyone not using a mouse.
    b.setAttribute('aria-label', label);
    b.setAttribute('aria-pressed', String(Boolean(link[key])));
    b.title = `${label} \u2014 ${title}`;
    b.onclick = () => {
      link[key] = !link[key];
      b.classList.toggle('on', link[key]);
      b.setAttribute('aria-pressed', String(link[key]));
      const p = panels[active];
      if (!p || !p.stack) return;
      if (key === 'scroll') setIndex(p, p.index);
      if (key === 'window') applyWindowFrom(p);
      if (key === 'zoomPan') applyViewFrom(p);
    };
    el.links.appendChild(b);
  }
  const align = document.createElement('button');
  align.className = 'itool';
  align.type = 'button';
  align.innerHTML = icon('align');
  align.setAttribute('aria-label', t('link.align', 'Align'));
  align.title = t('link.alignWhy', 'Scroll the panels to the same anatomy, then press '
    + 'Align. They follow by the offset you chose. Used when the platform cannot derive '
    + 'the correspondence itself.');
  align.onclick = alignPanels;
  el.links.appendChild(align);
}

function syncToolbarToActive() {
  const p = panels[active];
  for (const b of el.planes.children) b.classList.toggle('on', b.dataset.plane === (p ? p.plane : null));
  if (p && p.viewport) el.invert.classList.toggle('on', p.viewport.invert);
  // The toolbar describes the ACTIVE panel, and each panel carries its own window.
  syncPresetsToWindow(p);
}

function setCine(on) {
  if (cineTimer) { clearInterval(cineTimer); cineTimer = null; }
  // The glyph and the pressed state are `syncToggles`' business, and it is called by every
  // caller of this function. Writing `textContent` here replaced the SVG with a character,
  // so the one control whose appearance changes with its state was also the one control
  // that lost its icon the moment it was used.
  syncToggles();
  if (!on) return;
  cineTimer = setInterval(() => {
    const p = panels[active];
    if (!p || !p.stack) return;
    setIndex(p, (p.index + 1) % planeDepth(p.stack, p.plane));
  }, 60);
}

function resetView() {
  const p = panels[active];
  if (!p || !p.viewport) return;
  p.viewport.zoom = 1;
  p.viewport.pan = [0, 0];
  p.viewport.oneToOne = false;
  // AND THE ORIENTATION. `Reset` is the control a reader reaches for to get back to a
  // known state, and leaving a flip applied through it would make "reset" mean "reset
  // everything except the one thing that changes which side is which".
  p.viewport.transform = NO_TRANSFORM;
  buildOrientButtons();
  applyPreset(PRESETS[0]);
  applyViewFrom(p);
}

/* ----------------------------------------------------------------------------------
 * interaction
 *
 * The mouse model is RadiAnt's, which is also exactly what MOS-UI-207 specifies:
 * left-drag window/level, middle-drag pan, right-drag zoom, wheel through the stack.
 * MOS-UI-204: no gesture here creates, edits or erases a pixel.
 * -------------------------------------------------------------------------------- */

function attachPanelInteraction(p, i) {
  const c = p.canvas;
  c.addEventListener('contextmenu', (e) => e.preventDefault());

  // ARRIVING BY KEYBOARD IS ARRIVING. A pointer made a panel active from four call sites
  // below and the keyboard from none, so a reader who tabbed to a panel and pressed an
  // arrow moved a DIFFERENT panel's slice -- the one the mouse had last touched.
  p.node.addEventListener('focus', () => {
    setActive(i);
    // And it says which panel it is, because `aria-label` on a container that has just
    // received focus is read once and a reader arriving mid-stack needs the slice too.
    announce(p.node.getAttribute('aria-label'));
  });

  c.addEventListener('pointerdown', (e) => {
    setActive(i);
    if (!p.stack) return;
    c.setPointerCapture(e.pointerId);
    // An armed tool takes the LEFT button only. Middle and right stay pan and zoom,
    // because that is how a reader positions the thing they are about to measure.
    if (armed && armed.handlers.onDown(e)) { p._measuring = true; return; }

    // SHIFT-CLICK PUTS THE CURSOR WHERE YOU CLICKED, and every panel answers to it.
    //
    // A MODIFIER RATHER THAN A MODE, because this is the gesture a reader makes constantly
    // while doing something else, and a crosshair tool that had to be armed and disarmed
    // around every window-and-level drag would be a mode they spend the day leaving. The
    // left button alone stays window and level, which is the binding muscle memory already
    // has from both products being replaced.
    if (e.shiftKey) {
      const next = cursorFromClick(p, e);
      if (next) { setCursor(next); return; }
      // A frame that never stated its spacing cannot say where a patient point is, so
      // there is nothing to set -- said once, rather than silently doing nothing.
      notice('This series never stated its pixel spacing, so a position on it is not a '
        + 'patient position.', 'warn');
      return;
    }
    p._drag = {
      button: e.button, x: e.clientX, y: e.clientY,
      c: p.viewport.window.center, w: p.viewport.window.width,
      zoom: p.viewport.zoom, pan: [...p.viewport.pan],
    };
  });
  c.addEventListener('pointerup', (e) => {
    if (p._measuring) { armed && armed.handlers.onUp(e); p._measuring = false; return; }
    p._drag = null;
  });
  c.addEventListener('pointercancel', () => { p._drag = null; });
  // AND WHEN THE CAPTURE GOES, THE DRAG GOES WITH IT. `pointerup` is bound to the canvas,
  // so a release the canvas never sees -- the reader drags past the window edge and lets
  // go there, the browser hands capture to something else -- left `_drag` armed for the
  // rest of the session. The `e.buttons` test above is what makes that unrecoverable state
  // impossible; this ends the drag at the moment capture is lost rather than at the next
  // mouse move, so nothing is applied in between.
  c.addEventListener('lostpointercapture', () => { p._drag = null; });

  c.addEventListener('wheel', (e) => {
    if (!p.stack) return;
    e.preventDefault();
    setActive(i);
    const depth = planeDepth(p.stack, p.plane);
    setIndex(p, Math.max(0, Math.min(depth - 1, p.index + Math.sign(e.deltaY))));
  }, { passive: false });

  c.addEventListener('pointermove', (e) => {
    // OFFERED TO THE TOOL WHETHER OR NOT A BUTTON IS DOWN, because not every gesture is a
    // drag. This read `p._measuring && armed`, and `_measuring` is set in `onDown` and
    // cleared in `onUp` -- so it described a press-and-hold exactly and described
    // `angleTool` not at all. That tool places three points with three separate clicks, and
    // between them the button is up: its `onMove` was never called, so the ray never
    // followed the cursor and the reader placed the vertex with nothing to aim at.
    //
    // Both tools already guard themselves -- `dragTool` returns false without an anchor and
    // `angleTool` without a point -- so the tool decides whether the move is part of its
    // gesture, and a false answer falls through to pan and window as before.
    if (armed && armed.handlers.onMove(e)) { readout(p, e); return; }
    const d = p._drag;
    if (!d) { readout(p, e); return; }

    // IS THE BUTTON THAT STARTED THIS DRAG STILL DOWN? Asked of `e.buttons`, which is the
    // state now rather than a memory of an event that may never have arrived. See the
    // block comment on `lostpointercapture` below for what this repairs.
    //
    // `button` (which one was pressed) and `buttons` (which are held) use DIFFERENT
    // numbering: left is button 0 and bit 1, middle is button 1 and bit 4, right is
    // button 2 and bit 2. Mapping them by index would silently swap middle and right.
    const HELD = { 0: 1, 1: 4, 2: 2 };
    if (!(e.buttons & (HELD[d.button] || 0))) {
      p._drag = null;
      readout(p, e);
      return;
    }

    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (d.button === 0) {
      p.viewport.setWindow(d.c + dy * 2, Math.max(1, d.w + dx * 2));
      draw(p); applyWindowFrom(p);
      // The gesture the hint text calls `L-drag W/L`. Without this the row kept asserting
      // the last preset pressed while the reader dragged the window somewhere else.
      syncPresetsToWindow(p);
    } else if (d.button === 2) {
      // Dragging the zoom is the reader choosing a magnification, which is no longer the
      // one 1:1 names. Leaving the mode set would have the next draw snap back to it.
      p.viewport.oneToOne = false;
      p.viewport.zoom = Math.max(0.2, Math.min(20, d.zoom * Math.exp(-dy / 200)));
      draw(p); applyViewFrom(p);
    } else if (d.button === 1) {
      const r = c.getBoundingClientRect();
      p.viewport.pan = [d.pan[0] + (dx / r.width) * 2, d.pan[1] - (dy / r.height) * 2];
      draw(p); applyViewFrom(p);
    }
  });

  c.addEventListener('dblclick', () => { setActive(i); resetView(); });
  c.addEventListener('pointerleave', () => { p.hud.bl.textContent = ''; });
}

/**
 * Bind the four toggle glyphs, and sync them to the panel they describe.
 *
 * A FUNCTION BECAUSE THE BUTTONS ARE REBUILT. `buildTools` recreates them whenever the
 * contribution list is rendered, and an `onclick` set once in `attachGlobalInteraction`
 * was attached to elements that no longer existed.
 */
/**
 * Select a measurement, or clear the selection.
 *
 * Redraws every panel's overlay rather than one: the same measurement can be visible in
 * two panels showing the same series and slice, and a selection that highlighted it in
 * only one of them would say the two shapes were different measurements.
 */
function selectMeasurement(id) {
  if (selectedId() === id) return;
  setState({ selectedMeasurement: id }, 'measure');
}

/** Replace one by id, keeping its position in the list so rows do not jump while dragging. */
function replaceMeasurement(updated) {
  const next = getState().measurements.map((m) => (m.id === updated.id ? updated : m));
  setState({ measurements: next }, 'measure');
}

/**
 * Move one point of a measurement to a new image-space position, and re-measure it.
 *
 * THE FRAME IS THE PANEL'S CURRENT ONE, and that is sound rather than convenient: a
 * measurement is drawn only on its own series and its own slice, so a panel showing it is
 * a panel showing the frame it was taken on. `remeasure` rebuilds the whole record from
 * that frame, so the spacing, the unit, the projection note and the provenance all belong
 * to the same moment as the number.
 */
function moveHandle(panel, m, handleIndex, at) {
  let moved = null;
  if (m.kind === 'length' || m.kind === 'angle') {
    const points = m.points.map((p, i) => (i === handleIndex ? { ...at } : { ...p }));
    moved = { ...m, points };
  } else if (m.kind === 'roi') {
    const box = { ...m.box };
    if (handleIndex === 0) { box.x0 = at.x; box.y0 = at.y; } else { box.x1 = at.x; box.y1 = at.y; }
    moved = { ...m, box };
  }
  if (!moved) return;
  const fresh = remeasure(moved, panel.frame);
  if (fresh) replaceMeasurement(fresh);
}

/**
 * Wire one panel's annotation layer for selection and handle dragging.
 *
 * ON THE SVG, NOT ON THE CANVAS, and it matters which: the canvas handler owns window and
 * level, pan and zoom, and a measurement gesture that went through it would have to
 * out-guess those. The layer is `pointer-events: none` except on the shapes themselves, so
 * this handler only ever runs when the reader actually hit one -- and a miss never reaches
 * here at all, it reaches the canvas, which is what makes the fall-through exact rather
 * than a race between two handlers.
 */
function bindAnnotationEditing(p) {
  const svg = p.annotations && p.annotations.svg;
  if (!svg || svg.dataset.bound) return;
  svg.dataset.bound = '1';

  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    // An armed tool owns the click -- but RETURNING HERE IS NOT ENOUGH, and that was a
    // real bug. The shape had already taken the event by the time this ran, so returning
    // meant the click reached nothing at all: the layer did not select, and the canvas
    // underneath never saw the press. Measured: with a caliper on screen and the
    // rectangle tool armed, a drag that happened to start on the caliper's stroke drew
    // nothing and selected nothing. `armTool` now makes the layer inert, so the event is
    // never captured in the first place; this is the belt to that brace.
    if (armed) return;
    const id = e.target.dataset && e.target.dataset.m;
    if (!id) return;

    e.preventDefault();
    e.stopPropagation();
    setActive(panels.indexOf(p));
    selectMeasurement(id);

    const handle = e.target.dataset.h;
    if (handle === undefined) return;          // the shape, not a handle: select only

    const m = getState().measurements.find((x) => x.id === id);
    if (!m) return;
    handleDrag = { panel: p, id, handleIndex: Number(handle) };
    // ON THE BODY, not on the layer: the layer is `pointer-events: none` from an inline
    // style, so it is never hit-tested and never asked for a cursor.
    document.body.classList.add('annot-dragging');
    try { svg.setPointerCapture(e.pointerId); } catch { /* a synthetic pointer has none */ }
  });

  svg.addEventListener('pointermove', (e) => {
    if (!handleDrag || handleDrag.panel !== p) return;
    const at = pixelAt(p, e);
    if (!at) return;
    const m = getState().measurements.find((x) => x.id === handleDrag.id);
    if (!m) return;
    moveHandle(p, m, handleDrag.handleIndex, at);
    drawOverlays(p);
  });

  const end = (e) => {
    if (!handleDrag || handleDrag.panel !== p) return;
    handleDrag = null;
    document.body.classList.remove('annot-dragging');
    try { svg.releasePointerCapture(e.pointerId); } catch { /* as above */ }
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
}

/**
 * Save the active panel as a picture.
 *
 * WITH THE PATIENT NAMED. An exported image separated from this surface is an image
 * somebody has to be able to identify, and a capture of a thorax with no name on it is
 * unsafe in a way that is easy to miss -- it cannot be filed, and it cannot be refuted.
 * `volume.js` already warns that identifiers travel with any export of a view; this makes
 * that literal rather than leaving it to a screenshot key nobody controls.
 *
 * A capture WITHOUT identity is the right artefact for a figure or a bug report, and the
 * caption says which kind it is, so one cannot be mistaken for the other afterwards. It is
 * not offered as a button yet: a second control for a rarer case, on a toolbar this
 * session has just finished thinning, needs a place to live that is not another glyph.
 */
async function captureActivePanel() {
  const p = panels[active];
  if (!p || !p.stack || !p.frame) { notice('There is nothing on this panel to capture.', 'err'); return; }

  // FROM THIS PANEL'S OWN STUDY, which is not necessarily the one the banner is showing.
  // These rows used to come from `seriesIndex` -- the single open study -- and that was
  // exactly right while every panel held the same one. With a prior on screen it is not:
  // capturing the prior would have produced a picture of the prior's pixels captioned with
  // the CURRENT study's date and description, which is the single worst artefact this
  // feature could produce. `p.studyUID` is the panel's answer, not the surface's.
  const rows = studyRows(p.studyUID);
  const row = rows.find((x) => dv(x, '0020000E') === p.seriesUID) || {};
  const depth = planeDepth(p.stack, p.plane);
  // FROM THE SERIES ROWS, NOT FROM A RAIL. These read `el.railDate.textContent` and
  // `el.railDesc.textContent`, so the caption of an exported picture -- and the name of
  // the file -- depended on what happened to be drawn in a rail, including its
  // `(no study date)` placeholder. The rail is a view of the same rows this reads.
  const study = rows[0] || {};
  const meta = {
    patientName: dv(study, '00100010', ''),
    patientId: '',
    studyDate: studyDate(dv(study, '00080020', ''), dv(study, '00080030', '')),
    studyDescription: dv(study, '00081030', ''),
    seriesDescription: dv(row, '0008103E', ''),
    position: `${p.plane} ${p.index + 1} / ${depth}`,
    window: `W ${Math.round(p.viewport.window.width)}  L ${Math.round(p.viewport.window.center)}`,
  };

  try {
    const canvas = await capturePanel(p, meta, true);
    if (!canvas) { notice('This panel could not be captured.', 'err'); return; }
    const stamp = (meta.studyDate || 'study').replace(/[^\w-]+/g, '-');
    await downloadCanvas(canvas, `medos-${stamp}-${p.plane}-${p.index + 1}.png`);
    notice('Captured. The picture carries the patient identifiers shown on it.', 'warn');
  } catch (err) {
    notice(`Capture failed: ${describe(err)}`, 'err');
  }
}

/** Save this study's measurements, with the provenance each one carries. */
function exportMeasurements() {
  const rows = getState().measurements;
  if (!rows.length) { notice('There are no measurements to export.', 'err'); return; }
  // The same source as the capture's file name, for the same reason -- and from the ACTIVE
  // panel's study, because with a prior open the surface holds two.
  const study = studyRows(activeStudy())[0] || {};
  const stamp = (studyDate(dv(study, '00080020', ''), dv(study, '00080030', '')) || 'study')
    .replace(/[^\w-]+/g, '-');
  downloadText(measurementsCSV(rows), `medos-measurements-${stamp}.csv`);
}

/**
 * Put the cursor where the reader clicked, and let every panel answer to it.
 *
 * THIS IS THE GESTURE BOTH PRODUCTS BEING REPLACED ARE NAVIGATED BY, and this surface had
 * no equivalent: the reference lines were drawn and inert, and changing plane threw the
 * position away by jumping to the middle of the new one.
 *
 * A PANEL THAT CANNOT FOLLOW IS NOT MOVED. `indexForCursor` refuses a series in another
 * frame of reference, and a refusal leaves the panel exactly where it was rather than
 * guessing -- the rule `followIndex` has always kept. What that panel shows instead is a
 * crosshair saying why it has none, which is absence rendered rather than omitted.
 */
function setCursor(next) {
  if (!next) return;
  setState({ cursor: next }, 'cursor');
  for (const p of panels) {
    if (!p.stack || !p.frame) continue;
    const where = indexForCursor(p.stack, p.plane, next);
    if (where.index !== null && where.index !== p.index) {
      p.index = where.index;
      draw(p);
    } else {
      drawOverlays(p);
    }
    if (p !== panels[active]) showLink(p, where.mode, where);
  }
}

/** The cursor implied by a click on this panel. */
function cursorFromClick(p, event) {
  const at = pixelAt(p, event);
  if (!at) return null;
  return cursorAt(p.stack, p.frame, at.x, at.y);
}

function bindToggles() {
  if (!el.invert) return;

  el.invert.onclick = () => {
    const p = panels[active];
    if (!p || !p.viewport) return;
    p.viewport.invert = !p.viewport.invert;
    draw(p);
    syncToggles();
  };
  el.overlay.onclick = () => {
    const p = panels[active];
    if (!p || !p.viewport) return;
    p.viewport.overlayAlpha = p.viewport.overlayAlpha > 0 ? 0 : 0.45;
    draw(p);
    syncToggles();
  };
  if (el.fusion) el.fusion.onclick = () => { setFusion(!(panels[active] && panels[active].fusion)); };
  el.cine.onclick = () => { setCine(!cineTimer); syncToggles(); };
  el.reset.onclick = () => { resetView(); syncToggles(); };
  if (el.capture) el.capture.onclick = () => captureActivePanel();
  if (el.csv) el.csv.onclick = () => exportMeasurements();
  syncToggles();
}

/**
 * Make the toggles describe the ACTIVE panel.
 *
 * TWO BUGS LIVED HERE. The overlay button read
 * `classList.toggle('on', p.viewport.overlayAlpha === 0)` -- lit when the overlay was
 * OFF, inverted since it was written. And neither button was ever re-synced on a panel
 * switch, so the toolbar went on describing the panel the reader had left: `setActive`
 * rebuilt the slab, orient, zoom and plane strips and not these.
 */
function syncToggles() {
  const p = panels[active];
  const vp = p && p.viewport;
  for (const [node, state] of [
    [el.invert, Boolean(vp && vp.invert)],
    [el.overlay, Boolean(vp && vp.overlayAlpha > 0)],
    [el.fusion, Boolean(p && p.fusion)],
    [el.cine, Boolean(cineTimer)],
  ]) {
    if (!node) continue;
    node.classList.toggle('on', state);
    node.setAttribute('aria-pressed', String(state));
  }
  if (el.cine) {
    // The glyph is the ACTION the button performs, not the state it is in: a playing cine
    // offers a pause. A play triangle that means "currently playing" is the ambiguity
    // every media control has to pick a side of, and this is the side a toolbar takes.
    el.cine.innerHTML = icon(cineTimer ? 'pause' : 'cine');
    el.cine.title = cineTimer
      ? t('toggle.cinePauseWhy', 'Pause cine (Space)')
      : t('toggle.cineWhy', 'Cine play (Space)');
    el.cine.setAttribute('aria-label',
      cineTimer ? t('toggle.cinePause', 'Pause cine') : t('toggle.cine', 'Cine'));
  }
}

/**
 * Whether a rail may be hidden right now, and why not.
 *
 * A GENERATED SEGMENTATION ON SCREEN PINS THE RIGHT RAIL. That rail is where a SEG says
 * which algorithm produced it and whether its geometry aligned; hiding it leaves a
 * coloured overlay on the anatomy with nothing on the surface saying where the colour
 * came from. The reader can still hide it -- by turning the overlay off first, which is
 * the order that keeps the two facts together.
 */
function railHideRefusal(name) {
  if (name !== 'right') return null;
  if (!panels.some((p) => p.seg)) return null;
  return 'A segmentation is on screen. This rail says which algorithm produced it, so it '
    + 'stays until the overlay is off (O).';
}

/** Each registered panel's teardown, so a remount cannot subscribe it twice. */
const mountedPanels = new Map();

function attachGlobalInteraction() {
  window.addEventListener('resize', drawAll);
  // THE ROW IS MEASURED AGAIN WHENEVER THE WINDOW IS. The rails do not reach the header,
  // so unlike the canvases this one really does only change with the window.
  window.addEventListener('resize', fitToolbar);

  // THE RAILS RESIZE THE CANVAS, AND A RESIZE EVENT DOES NOT FIRE FOR THEM. Dragging a
  // splitter, collapsing a rail and moving a panel all change the stage's CSS box
  // without the window changing size, so `drawAll` is handed in: it is the only thing
  // that brings the WebGL backing store back in line with the box it is drawn into.
  initRails({
    root: el.viewer,
    onResize: drawAll,
    // The zoom buttons print a percentage of a size that just changed.
    onSettled: () => { buildZoomButtons(); },
    blockedReason: railHideRefusal,
  });
  el.back.onclick = showStudies;

  bindToggles();

  /**
   * IS THE READER TYPING? Asked once, for every binding, instead of once for Delete.
   *
   * `s` typed into the patient-name filter reconstructed the open study to SAGITTAL, and
   * the letter landed in the field as well -- so the reader saw ordinary typing and a
   * silent re-cut of the volume they were reading. Every single-character binding below
   * was reachable from inside a text box; only the Delete branch had ever asked, and it
   * asked with its own inline copy of this test.
   *
   * WCAG 2.1.4 is the rule. The clinical form of it is the worse one: searching for a
   * patient called Smirnov must not change the plane, the window or the inversion of the
   * study on screen.
   */
  const typing = (node) => !!node && (
    node.tagName === 'INPUT' || node.tagName === 'SELECT' || node.tagName === 'TEXTAREA'
    || node.isContentEditable);

  /**
   * SPACE AND ENTER BELONG TO WHATEVER HAS FOCUS.
   *
   * A focused button is pressed with Space; that is what makes it a control rather than a
   * picture of one. Taking Space for cine meant the keyboard could REACH a control and
   * then not operate it, which is a worse failure than not reaching it -- the focus ring
   * says "press this" and pressing it played a loop somewhere else.
   */
  const activatable = (node) => !!node && (
    node.tagName === 'BUTTON' || node.tagName === 'A' || node.tagName === 'SUMMARY'
    || ['button', 'menuitem', 'checkbox', 'tab', 'separator', 'link']
      .includes(node.getAttribute('role')));

  window.addEventListener('keydown', (e) => {
    const focused = document.activeElement;

    // DELETE REMOVES THE SELECTED MEASUREMENT, and there was no binding for it at all: the
    // only way to remove one was a 24px glyph in a side panel, which means taking a hand
    // off the image to undo something that happened on the image.
    //
    // ONLY WITH A SELECTION. Delete with nothing selected is a keystroke that does
    // nothing, which is the right outcome -- a viewer that deleted "the last one" would
    // remove a measurement the reader was not looking at.
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId()) {
      // NOT WHILE TYPING. Backspace in a filter box is a backspace.
      if (!typing(focused)) {
        e.preventDefault();
        const id = selectedId();
        setState({
          measurements: getState().measurements.filter((m) => m.id !== id),
          selectedMeasurement: null,
        }, 'measure');
        return;
      }
    }

    const p = panels[active];
    if (!p || !p.stack) return;

    // NOTHING BELOW THIS LINE FIRES WHILE A TEXT FIELD, A SELECT OR AN EDITABLE NOTE HAS
    // FOCUS. Arrows move a caret, digits are digits, and letters are letters.
    if (typing(focused)) return;

    const preset = PRESETS.find((x) => x.key === e.key);
    if (preset) { applyPreset(preset); return; }
    const depth = planeDepth(p.stack, p.plane);
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') setIndex(p, Math.min(depth - 1, p.index + 1));
    if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') setIndex(p, Math.max(0, p.index - 1));
    if (e.key === 'Home') setIndex(p, 0);
    if (e.key === 'End') setIndex(p, depth - 1);
    if (e.key === 'a') setPlane(PLANES.AXIAL);
    if (e.key === 'c') setPlane(PLANES.CORONAL);
    if (e.key === 's') setPlane(PLANES.SAGITTAL);
    if (e.key === 'f') {
      p.viewport.zoom = 1; p.viewport.pan = [0, 0]; p.viewport.oneToOne = false;
      draw(p); applyViewFrom(p); buildZoomButtons();
    }
    if (e.key === 'l' && el.links.firstChild) el.links.firstChild.click();
    if (e.key === 'Escape') armTool(null);
    for (const tool of contributions(KINDS.TOOL)) {
      if (e.key === tool.key) armTool(armed && armed.tool.id === tool.id ? null : tool);
    }
    // THE PANELS CYCLE ON THE BACKQUOTE, AND TAB IS LEFT ALONE.
    //
    // This was `Tab` with a `preventDefault`, which is the definition of a keyboard trap
    // (WCAG 2.1.2, level A). Once any study had been opened the focus ring could not be
    // moved off whatever held it -- not here, and not on the study list afterwards, since
    // `p.stack` outlives the return to the worklist. Every keyboard affordance this
    // viewer owns sat behind it: the measurement rows with their `tabindex` and their
    // Enter/Space and their F2, both splitters, the rail controls, the gear menu. One
    // line made a file's worth of keyboard work unreachable.
    //
    // Nothing is lost by moving it. A panel is made active by clicking it too, from four
    // other call sites, so this binding was a convenience and never the only route.
    if (e.key === '`') { e.preventDefault(); setActive((active + 1) % panels.length); }
    if (e.key === '?' || e.key === 'h') toggleHelp();
    // THE RAILS, on the brackets. Every letter this surface could spare is already a
    // tool or a plane; the brackets are unclaimed and are what an editor uses.
    if (e.key === '[' || e.key === ']') {
      e.preventDefault();
      const refused = toggleRail(e.key === '[' ? 'left' : 'right');
      if (refused) notice(refused, 'info');
    }
    if (e.key === 'i') el.invert.click();
    if (e.key === 'o') el.overlay.click();
    // `f`, BECAUSE THE BUTTON'S OWN TITLE PROMISES IT. A tooltip that names a key the
    // surface does not listen for is a smaller defect than no key and a worse one: the
    // reader presses it, nothing happens, and they stop trusting the other nine.
    if (e.key === 'f' && el.fusion) el.fusion.click();
    if (e.key === ' ' && !activatable(focused)) { e.preventDefault(); el.cine.click(); }
  });
}

/**
 * HU under the cursor, for one panel.
 *
 * Computed from the CPU copy of the STORED values through the same
 * `slope * stored + intercept` the shader uses -- never sampled back off the canvas, which
 * would report a display grey level. `MOS-IMG-039`/`MOS-IMG-041`: a measurement computed
 * anywhere but the source array "is a defect, not an approximation".
 *
 * This function was once deleted by a refactor that left its call site, so pointermove threw
 * ReferenceError on every mouse move and the HU corner stayed empty while three commit
 * messages claimed the readout as delivered. A test that hovers and asserts a number is owed.
 */
function readout(p, e) {
  const frame = p.frame;
  if (!frame) { p.hud.bl.textContent = ''; return; }

  // THE TRANSFORM IS SHARED, NOT REPEATED. This function used to invert viewport.render()'s
  // physical-aspect fit inline, with a comment admitting "kept in step with it by hand,
  // which is a seam worth a test: if the two ever disagree the reported HU is for a pixel
  // the reader is not pointing at". Measurements would have made that a third copy, and a
  // caliper anchored a pixel away from where the reader clicked is a wrong number that
  // looks right. src/render/transform.js is now the one implementation and its two
  // directions are exact inverses to 1e-13.
  const rect = p.canvas.getBoundingClientRect();
  const pixel = screenToImage(
    frame,
    { width: rect.width, height: rect.height },
    viewOf(p.viewport),
    { x: e.clientX - rect.left, y: e.clientY - rect.top },
  );
  if (!pixel) { p.hud.bl.textContent = ''; return; }

  const px = Math.floor(pixel.x);
  const py = Math.floor(pixel.y);
  const hu = p.viewport.huAt(px, py);
  // ONE FUNCTION DECIDES THE UNIT, and this readout asks it rather than assuming. On a CT
  // it still says HU; on a PET it says what (0054,1001) says; on an MR it says the unit was
  // not recorded, instead of inviting the reader to supply "HU" from habit.
  p.hud.bl.textContent = hu === null
    ? ''
    : `${withUnit(hu, p.frame && p.frame.valueUnit)}   ·   (${px}, ${py})`;
}

/** MOS-UI-210: the binding table, reachable without leaving the case. */
function toggleHelp() {
  el.help.hidden = !el.help.hidden;
  if (el.help.hidden) return;
  const rows = [
    ['wheel / arrows', 'previous, next slice'],
    ['Home / End', 'first, last slice'],
    // NO `Tab` ROW. Tab cycled the panels until this session, and the binding was a
    // keyboard trap: it `preventDefault`ed every Tab once a study was open, so focus
    // could not leave whatever held it. The cycle moved to the backquote below; this row
    // outlived it by one commit and advertised a key that does nothing, which sends a
    // reader to conclude the application is broken rather than that the list is stale.
    ['a  c  s', 'axial, coronal, sagittal'],
  ];
  for (const p of PRESETS) {
    rows.push([p.key, `window: ${p.name}${p.source === 'convention_unverified' ? '  (unverified source)' : ''}`]);
  }
  rows.push(['l', 'toggle linked scrolling'], ['f', 'zoom to fit'], ['i', 'invert'],
    ['o', 'toggle overlay'], ['space', 'cine'],
    // THESE TWO WERE MISSING, and they were the ONLY way to collapse a rail -- so the
    // one route to the feature was undocumented, and a reader who found it by accident
    // had nothing to undo it with. Both rails now carry a visible control as well.
    ['[  ]', 'hide or show the left / right rail'],
    // WAS TAB, AND TAB IS THE KEY THE READER NEEDS TO LEAVE THE IMAGE WITH.
    ['`', 'next panel'],
    ['? or h', 'this list'],
    ['left drag', 'window / level'], ['middle drag', 'pan'], ['right drag', 'zoom'],
    ['double click', 'reset']);
  el.help.innerHTML = '<h4>Keyboard and mouse</h4>' + rows.map(
    ([k, v]) => `<div class="help-row"><kbd>${escape(k)}</kbd><span>${escape(v)}</span></div>`).join('');
}

/* ----------------------------------------------------------------------------------
 * helpers
 * -------------------------------------------------------------------------------- */

/** A refusal is rendered with its reason verbatim, as MOS-SAFE-089a requires of one. */
function describe(err) {
  if (err instanceof DicomRefusal) return `${err.reason}: ${err.detail}`;
  return String((err && err.message) || err);
}

function escape(s) {
  return String(s).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

/**
 * Mount every registered PANEL into the side column slot that matches its id.
 *
 * The markup still names the slots, so a panel cannot appear somewhere the layout did not
 * plan for; what the registry buys is that the shell no longer knows what a panel RENDERS.
 */
/**
 * Build the rail section a registered panel did not find, and put it in its rail.
 *
 * THE SHAPE MATCHES THE HAND-WRITTEN ONES EXACTLY -- `section.rail-section` carrying
 * `data-panel-id`, a heading, then one host element -- because `rails.js` moves these
 * between rails by that selector and `mountPanels` finds the host as
 * `lastElementChild`. A created section that differed in shape would be a panel that
 * mounts and then cannot be moved, which is worse than one that never appeared.
 *
 * The heading is marked `data-i18n` so a panel title translates with the rest of the
 * chrome. A title is a LABEL; nothing a panel renders into the host is translated from
 * here.
 */
function createPanelSection(panel) {
  const rail = document.querySelector(`[data-rail="${panel.slot || 'right'}"]`);
  if (!rail) return null;

  const section = document.createElement('section');
  section.className = 'rail-section';
  section.dataset.panelId = panel.id;

  const heading = document.createElement('h3');
  heading.dataset.i18n = `panel.${panel.id}`;
  heading.textContent = panel.title || panel.id;
  section.appendChild(heading);

  const host = document.createElement('div');
  host.className = 'panel-host';
  section.appendChild(host);

  // AMONG ITS NEIGHBOURS BY `order`, not simply appended. Appending would make the
  // rail's arrangement depend on module import order, which is not something a panel
  // author controls or can see.
  const mine = panel.order ?? 100;
  const after = [...rail.querySelectorAll('[data-panel-id]')].find((s) => {
    const other = contributions(KINDS.PANEL).find((c) => c.id === s.dataset.panelId);
    return other && (other.order ?? 100) > mine;
  });
  rail.insertBefore(section, after || null);
  return section;
}
function mountPanels() {
  // THE VIEWPORT SUBSCRIBES TOO, and this is not optional. The measurements panel removes a
  // row by writing state; without this the panel updated and the annotation layer kept
  // drawing the shape -- the panel and the image disagreeing about what exists, which is
  // exactly the defect state.js was introduced to remove. Half-converting reintroduced it,
  // and the end-to-end check caught it: one shape still on the layer after the row was
  // gone from the table.
  subscribeTo(['measurements'], () => { for (const p of panels) draw(p); });

  // A PANEL'S SLOT IS A PROPERTY OF THE MARKUP, NOT A LITERAL HERE. This was
  // `{ 'medos.segments': el.segments, 'medos.measurements': el.measurements }`, which
  // made the rail a panel lives in a fact about this line -- so a reader could not move
  // one, and a new panel could not be mounted without editing the shell. The section
  // carrying `data-panel-id` is what `rails.js` moves between rails; the HOST inside it
  // is what the panel renders into, and neither this function nor `rails.js` ever
  // writes into that host. A panel with no section in the markup is skipped and said
  // so once, because a contribution that registers and never appears is the kind of
  // thing that goes unnoticed for months.
  // IN THE ORDER THE PANELS DECLARE, so a panel's position among its neighbours is a
  // property of the panel rather than of where someone happened to paste its markup.
  const declared = [...contributions(KINDS.PANEL)]
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));

  for (const panel of declared) {
    if (typeof panel.mount !== 'function') continue;
    let section = document.querySelector(`[data-panel-id="${panel.id}"]`);
    // A SECTION IN THE MARKUP WINS. The two shipped panels carry one so their empty
    // states are on screen before the first subscription fires, and a deployment that
    // laid out its rails by hand should not have that undone by a default.
    if (!section) section = createPanelSection(panel);
    if (!section) {
      notice(`panel ${panel.id} names rail '${panel.slot || 'right'}', which this `
        + 'layout does not have, so it is not on screen', 'info');
      continue;
    }
    // The host is the section's body: the element after its heading.
    const mountHost = section.lastElementChild;
    if (!mountHost) continue;
    // A REMOUNT MUST TEAR DOWN FIRST. Every panel's `mount` returns its unsubscribe;
    // dropping it would leave the old subscription live and render the panel twice for
    // every state change, which looks like a flicker rather than like a leak.
    const teardown = mountedPanels.get(panel.id);
    if (typeof teardown === 'function') teardown();
    mountedPanels.set(panel.id, panel.mount(mountHost));
  }

  // EVERY SECTION FOLDS, INCLUDING THE ONES THIS FUNCTION JUST BUILT.
  //
  // The top-level pass runs BEFORE `mountPanels`, so a section from `createPanelSection`
  // was never reached by it: `medos.study` sat at the top of the right rail as the one
  // heading in either rail with no fold button and no `aria-expanded` -- and it is the
  // section most worth folding, seven fixed rows a reader confirms once and then reads
  // past all session. The guard on `data-foldable` makes this a no-op for the rest.
  makeSectionsFoldable();
}

// IN PARALLEL: two independent configuration files, and the page is not usable until both
// have either arrived or failed. Sequencing them would cost a round trip for nothing.
await Promise.all([loadPresets(), loadProtocols()]);
buildPresets();
buildLayoutButtons();
buildLinkButtons();
buildToolButtons();
buildPlaneButtons();
buildSlabButtons();
buildOrientButtons();
buildZoomButtons();
buildObliqueButtons();
attachGlobalInteraction();
bindWorklist();

// THE CHROME'S OWN CONTROLS. About and Preferences are modals over the page rather than
// routes, because a reader opening Preferences mid-read has not stopped reading: losing
// the open study, the layout and this session's measurements to look at a checkbox would
// be a worse trade than any setting in there is worth.
/* ---------------------------------------------------------------- the gear ------- */

//: Which rail sections the reader has folded, by panel id. Per-browser, never sent.
const FOLDED_KEY = 'medos.viewer.folded';

function foldedSet() {
  try {
    return new Set(JSON.parse(localStorage.getItem(FOLDED_KEY) || '[]'));
  } catch {
    // A private window, or blocked site data. Nothing folded is a usable answer.
    return new Set();
  }
}

function rememberFolded(set) {
  try {
    localStorage.setItem(FOLDED_KEY, JSON.stringify([...set]));
  } catch {
    // The fold still applies to this session; it just will not outlive it.
  }
}

/**
 * Make every rail section a disclosure: a heading that folds what is under it.
 *
 * THE HEADING BECOMES A BUTTON rather than gaining one beside it, because the whole
 * heading is the target a reader aims at, and a 16px chevron is not. `aria-expanded`
 * on that button is what tells a screen reader the section can fold at all -- without
 * it this is a heading that mysteriously empties when clicked.
 */
function makeSectionsFoldable() {
  const folded = foldedSet();
  for (const section of document.querySelectorAll('.rail-section')) {
    const heading = section.querySelector('h3');
    if (!heading || heading.dataset.foldable === '1') continue;
    heading.dataset.foldable = '1';

    const id = section.dataset.panelId || section.dataset.section || '';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'fold';
    // THE HEADING'S CHILDREN AND ITS TRANSLATION MARKER BOTH MOVE INTO THE BUTTON.
    //
    // Moving only the children was not enough and the failure was invisible from here:
    // `paintChrome` writes `node.textContent` on anything carrying `data-i18n`, so the
    // heading kept the marker, the next paint replaced ALL of its children with a text
    // node, and the button that had just been built inside it was destroyed. The section
    // rendered exactly as before, with `data-foldable="1"` set and nothing to click.
    // THE GLYPH IS A SIBLING OF THE LABEL, NOT A PSEUDO-ELEMENT AND NOT A CHILD OF THE
    // TRANSLATED NODE.
    //
    // It used to be `::before` on the button -- a 5x5 box with two borders rotated 45
    // degrees -- and it had to be, for the reason the note below records: `paintChrome`
    // writes `textContent` on whatever carries `data-i18n`, so any child of this button
    // was destroyed on the next paint and only a pseudo-element survived. At one device
    // pixel per CSS pixel a rotated 1px border antialiases into a smudge that matches no
    // other glyph on the surface, which is what a reader reported it as.
    //
    // Moving the translation marker onto an inner label makes the button safe to put
    // things in: `paintChrome` now rewrites the LABEL's text and leaves the chevron --
    // `icons.js`'s own, the one the rest of the chrome uses -- alone beside it.
    const mark = document.createElement('span');
    mark.className = 'fold-mark';
    mark.innerHTML = icon('chevron');
    const label = document.createElement('span');
    label.className = 'fold-label';
    while (heading.firstChild) label.appendChild(heading.firstChild);
    for (const marker of ['i18n', 'i18nEnText']) {
      if (heading.dataset[marker] !== undefined) {
        label.dataset[marker] = heading.dataset[marker];
        delete heading.dataset[marker];
      }
    }
    button.append(mark, label);
    button.title = t('rail.fold', 'Collapse or expand this section');
    button.dataset.i18nTitle = 'rail.fold';
    heading.appendChild(button);

    const apply = (isFolded) => {
      section.classList.toggle('folded', isFolded);
      button.setAttribute('aria-expanded', String(!isFolded));
    };
    apply(id ? folded.has(id) : false);

    button.onclick = () => {
      const now = foldedSet();
      const isFolded = !section.classList.contains('folded');
      if (id) {
        if (isFolded) now.add(id); else now.delete(id);
        rememberFolded(now);
      }
      apply(isFolded);
    };
  }
}

/**
 * The gear: one control holding the things that are not the reading task.
 *
 * A MENU, NOT A DIALOG OF DIALOGS. Each entry opens the thing it names; the menu
 * closes on Escape, on a click outside, and after a choice, and focus goes back to the
 * gear -- the same contract `openDialog` keeps, for the same reason.
 */
function bindChromeMenu() {
  const gear = el.gear;
  const menu = el.chromeMenu;
  if (!gear || !menu) return;
  gear.innerHTML = icon('gear') + gear.innerHTML;

  const ENTRIES = [
    { key: 'chrome.preferences', english: 'Preferences', run: () => openPreferences() },
    { key: 'chrome.about', english: 'About', run: () => openAbout() },
  ];

  const close = () => {
    menu.hidden = true;
    gear.setAttribute('aria-expanded', 'false');
  };
  const open = () => {
    menu.innerHTML = ENTRIES.map((e, i) => (
      `<button type="button" role="menuitem" class="chrome-menu-item" data-run="${i}"`
      + ` data-i18n="${e.key}">${escape(e.english)}</button>`
    )).join('');
    for (const item of menu.querySelectorAll('[data-run]')) {
      item.onclick = () => { close(); ENTRIES[Number(item.dataset.run)].run(); };
    }
    paintChrome();
    menu.hidden = false;
    gear.setAttribute('aria-expanded', 'true');
    const first = menu.querySelector('button');
    if (first) first.focus();
  };

  gear.onclick = (e) => { e.stopPropagation(); if (menu.hidden) open(); else close(); };
  // THE ROLE PROMISES ARROW KEYS; ONLY ESCAPE WAS HANDLED.
  //
  // `role="menu"` with `role="menuitem"` children is a contract: a keyboard reader expects
  // Up/Down to move within it. Worse, Tab walked straight OUT of the menu and left it open
  // and floating over the study list, so focus was somewhere behind a panel the reader
  // could no longer see they had opened.
  menu.onkeydown = (e) => {
    if (e.key === 'Escape') { close(); gear.focus(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...menu.querySelectorAll('[data-run]')];
    const i = items.indexOf(document.activeElement);
    e.preventDefault();
    const next = e.key === 'ArrowDown' ? i + 1 : i - 1 + items.length;
    items[next % items.length].focus();
  };
  // `relatedTarget` is where focus is GOING. Tabbing past the last item closes the menu
  // rather than leaving it open behind the reader.
  menu.onfocusout = (e) => {
    if (!menu.contains(e.relatedTarget) && e.relatedTarget !== gear) close();
  };
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== gear) close();
  });
}
bindChromeMenu();
bindToolbarOverflow();
makeSectionsFoldable();

// LANGUAGE IS CHROME ONLY. Every node carrying `data-i18n` is a LABEL; no measured value,
// no unit, no identifier and no part of the MOS-SAFE-001 statement is reached from here.
// See src/core/i18n.js for why that boundary is the whole point of the module.
function paintChrome() {
  // THE ENGLISH IS REMEMBERED ON FIRST SIGHT, not re-read from the node.
  //
  // Reading the node's current value as the fallback works exactly once. After one pass
  // the node holds the TRANSLATION, so switching back to English asked `t()` to fall back
  // to Russian, and the interface stuck in whatever language it was first painted in.
  const original = (node, slot, read) => {
    const key = `i18nEn${slot}`;
    if (node.dataset[key] === undefined) node.dataset[key] = read();
    return node.dataset[key];
  };

  for (const node of document.querySelectorAll('[data-i18n]')) {
    node.textContent = t(node.dataset.i18n, original(node, 'Text', () => node.textContent));
  }
  // AN ATTRIBUTE A READER SEES IS TEXT TOO. A placeholder, a tooltip and an accessible
  // name are read by somebody; leaving them in English while the labels translate is a
  // half-translated interface, and the half left behind is the half a screen-reader user
  // depends on.
  const attrs = [
    ['data-i18n-placeholder', 'placeholder', 'Ph'],
    ['data-i18n-title', 'title', 'Ti'],
    ['data-i18n-aria', 'aria-label', 'Ar'],
  ];
  for (const [marker, attribute, slot] of attrs) {
    for (const node of document.querySelectorAll(`[${marker}]`)) {
      const key = node.getAttribute(marker);
      const english = original(node, slot, () => node.getAttribute(attribute) || '');
      node.setAttribute(attribute, t(key, english));
    }
  }
}
/**
 * The date fields: a calendar the reader can see, and a format that follows the viewer.
 *
 * TWO SEPARATE FAULTS, both invisible from the source.
 *
 * 1. `<input type="date">` formats itself from the BROWSER's locale, not the page's. On a
 *    machine set to Russian the field reads `дд.мм.гггг` however the viewer is set, so a reader
 *    who chose English still types into a Russian field. Chrome honours a `lang` on the
 *    input itself, so the field is told which language it is in.
 *
 * 2. The native calendar button is drawn by `::-webkit-calendar-picker-indicator`, which
 *    lives in the shadow DOM. On this theme it renders dark-on-dark -- and styling it from
 *    the page did not take (`filter` computed to `none`). The control was there and
 *    nobody could find it. So the field gets a REAL button, in our own icon set, that
 *    calls `showPicker()`.
 *
 * Typed entry still works exactly as before: this adds a way in, it does not replace one.
 */
function dressDateFields(lang) {
  for (const input of document.querySelectorAll('.wl-dates input[type="date"]')) {
    input.lang = lang;
    if (input.nextElementSibling && input.nextElementSibling.classList.contains('date-pick')) {
      continue;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'date-pick linkish';
    button.innerHTML = icon('calendar');
    // CREATED IN ENGLISH, then translated by `paintChrome` like every other label.
    //
    // Setting the translated text here looked simpler and was wrong: `paintChrome`
    // remembers a node's first value as its English, so a button born in Arabic taught
    // the translator that "افتح التقويم" was the English fallback, and it stayed Arabic
    // in every other language afterwards.
    button.title = 'Open the calendar';
    button.setAttribute('aria-label', 'Open the calendar');
    button.dataset.i18nTitle = 'wl.openCalendar';
    button.dataset.i18nAria = 'wl.openCalendar';
    // `showPicker` throws if it is called without a user gesture; this one always has
    // exactly that, so a failure here is a browser that cannot open it at all -- in which
    // case typing still works and focusing the field is the honest fallback.
    button.onclick = () => {
      try {
        input.showPicker();
      } catch {
        input.focus();
      }
    };
    input.after(button);
  }
}

onLanguageChange((lang) => {
  // DRESS FIRST, PAINT SECOND. A button created after the paint keeps the English it was
  // built with until the next language change -- which is one change too late.
  dressDateFields(lang);
  paintChrome();
  // AND ANYTHING THE SHELL BUILT AS A STRING. `paintChrome` only reaches nodes carrying
  // `data-i18n`, which the study list's rows and its count are not -- they are written by
  // `renderWorklist`. Without this the count kept the language it was first drawn in, so
  // switching to Arabic left "1 angezeigt" above an otherwise Arabic table.
  if (typeof renderWorklist === 'function') renderWorklist();
  // AND THE TOOLBAR, whose labels are composed rather than marked.
  //
  // `paintChrome` translates nodes carrying `data-i18n`; these buttons carry none, because
  // their titles are BUILT -- "Axial, acquired, reconstruction, key a" is four strings and
  // a plane resolver, not one key. The builders read `t()` at construction time, so the
  // way to translate them is to construct them again. They are cheap and idempotent:
  // every one clears its own container first.
  rebuildToolbarChrome();
  // AND THE PICTURE'S OWN CHROME. The HUD's plane word, and the canvas's accessible name
  // with it, are written by `draw()` -- not by any builder -- so after a language change
  // the toolbar said "Axial" while the corner of the image still said "аксиальная". The
  // redraw is the same one a resize does; it repaints from state and invents nothing.
  drawAll();
});

/**
 * Rebuild every control whose label is composed at build time.
 *
 * Each of these clears its own container, so calling them again is the whole operation --
 * no node is orphaned and no handler is bound twice. `buildPresets` is deliberately absent:
 * it renders window widths and levels, which are MEASURED VALUES and are not translated
 * (`src/core/i18n.js`); it is rebuilt only when the presets themselves change.
 */
/* ------------------------------------------------------------------------------------
 * THE TOOLBAR SAYS WHAT DOES NOT FIT, INSTEAD OF LOSING ITS TAIL.
 *
 * `.bar-tools` is `overflow: hidden` and does not wrap -- deliberately: the comment over
 * that rule records what a wrapping row of these controls cost the picture. What it cost
 * instead, measured on this build with a study open, is the tail of the row:
 *
 *     1440 and wider   nothing lost
 *     1366             15px of the last button's edge
 *     1340             Export measurements (CSV) unreachable
 *     1320             and Capture (PNG)
 *     1280             and Reset view
 *     1200             and Invert, Segmentation overlay, Cine
 *
 * Unreachable is exact: `document.elementFromPoint` at the centre of each of those buttons
 * answered with the patient-name banner, not the button. The first three to go are the two
 * that carry evidence out of this viewer and the one that puts the picture back to a known
 * state, and nothing on screen said a control had ever been there.
 *
 * WHAT HAPPENS NOW. Buttons that do not fit are hidden and listed in a menu on a control
 * that sits OUTSIDE the clipping box, so the way to reach them cannot itself be clipped.
 * Nothing is rebuilt and nothing moves in the DOM: a menu entry calls `click()` on the
 * button it stands for, so the handler, the id and the toggle state are all still the
 * ones the four toolbar builders wrote.
 * --------------------------------------------------------------------------------- */

/** Every tool button in the bar, in the order a reader reads them. */
function toolbarButtons() {
  return el.barTools ? [...el.barTools.querySelectorAll('button')] : [];
}

function closeMoreMenu() {
  if (!el.barMoreMenu) return;
  el.barMoreMenu.hidden = true;
  if (el.barMore) el.barMore.setAttribute('aria-expanded', 'false');
}

/**
 * A separator earns its pixel only between two things it separates.
 *
 * The four groups are divided by `.tool-sep`; once a whole group is in the menu its
 * divider is a rule with nothing on one side of it.
 */
function syncToolSeparators() {
  if (!el.barTools) return;
  const parts = [...el.barTools.children];
  const filled = (node) => !!node.querySelector && [...node.querySelectorAll('button')]
    .some((b) => !b.hidden);
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i].classList.contains('tool-sep')) continue;
    const before = parts.slice(0, i).some(filled);
    const after = parts.slice(i + 1).some(filled);
    parts[i].hidden = !(before && after);
  }
}

let fittingToolbar = false;

/**
 * Hide from the end until the row fits, then list what was hidden.
 *
 * MEASURED, NOT ASSUMED. There is no breakpoint here and there must not be: the row's
 * width depends on the language (a plane button reading "As acquired" is not the width of
 * "Wie aufgenommen"), on whether a study is open (the identity banner appears and takes
 * 190px), and on how many tools the registry contributed. A number in a media query would
 * be right for one of those combinations.
 */
function fitToolbar() {
  const bar = el.barTools;
  const more = el.barMore;
  if (!bar || !more || fittingToolbar) return;
  fittingToolbar = true;
  try {
    const buttons = toolbarButtons();
    for (const b of buttons) { b.hidden = false; delete b.dataset.overflow; }
    more.hidden = true;
    closeMoreMenu();
    syncToolSeparators();
    // `+1` because a fractional layout width rounds up into `scrollWidth` and would
    // otherwise report a row that fits as one that does not, forever hiding one button.
    if (bar.scrollWidth <= bar.clientWidth + 1) return;
    // THE CONTROL ITSELF COSTS 30px, so it is shown BEFORE the row is measured again --
    // otherwise the last button hidden is one that would have fitted.
    more.hidden = false;
    for (let i = buttons.length - 1; i >= 0; i--) {
      if (bar.scrollWidth <= bar.clientWidth + 1) break;
      buttons[i].hidden = true;
      buttons[i].dataset.overflow = '1';
      syncToolSeparators();
    }
  } finally {
    fittingToolbar = false;
  }
}

/**
 * The menu: the same contract as the gear's, for the same reason.
 *
 * Escape closes it and gives focus back, the arrows move within it, tabbing out of it
 * closes it rather than leaving it floating over the picture, and a click anywhere else
 * closes it. A reader who opens this menu has already been told the row is short of room;
 * being left with an open menu they cannot see they opened would be the second surprise.
 */
function bindToolbarOverflow() {
  const more = el.barMore;
  const menu = el.barMoreMenu;
  if (!more || !menu) return;
  more.innerHTML = icon('more') + more.innerHTML;

  const open = () => {
    const hiddenButtons = toolbarButtons().filter((b) => b.dataset.overflow);
    menu.innerHTML = '';
    for (const source of hiddenButtons) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'chrome-menu-item';
      item.setAttribute('role', 'menuitem');
      // THE NAME, NOT THE SENTENCE. `aria-label` is the short name `iconButton` wrote
      // for exactly this reason; `title` carries the explanation and stays on demand.
      // A TEXT BUTTON HAS NO `aria-label` AND DOES NOT NEED ONE -- its own text IS the
      // name. `As acquired` was reaching the menu as `null` and then as the whole of its
      // tooltip, which is a sentence, because the fallback went straight to `title`.
      item.textContent = source.getAttribute('aria-label')
        || source.textContent.trim() || source.title || '';
      item.title = source.title || '';
      if (source.classList.contains('on')) item.dataset.on = '1';
      if (source.disabled) item.disabled = true;
      item.onclick = () => { closeMoreMenu(); more.focus(); source.click(); };
      menu.appendChild(item);
    }
    menu.hidden = false;
    more.setAttribute('aria-expanded', 'true');
    const first = menu.querySelector('button:not([disabled])');
    if (first) first.focus();
  };

  more.onclick = (e) => { e.stopPropagation(); if (menu.hidden) open(); else closeMoreMenu(); };
  menu.onkeydown = (e) => {
    if (e.key === 'Escape') { closeMoreMenu(); more.focus(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...menu.querySelectorAll('button:not([disabled])')];
    if (!items.length) return;
    const i = items.indexOf(document.activeElement);
    e.preventDefault();
    const next = e.key === 'ArrowDown' ? i + 1 : i - 1 + items.length;
    items[next % items.length].focus();
  };
  menu.onfocusout = (e) => {
    if (!menu.contains(e.relatedTarget) && e.relatedTarget !== more) closeMoreMenu();
  };
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== more) closeMoreMenu();
  });
}

function rebuildToolbarChrome() {
  if (!el.barVerbs) return;
  buildLayoutButtons();
  buildLinkButtons();
  buildToolButtons();
  buildPlaneButtons();
  buildSlabButtons();
  buildOrientButtons();
  buildZoomButtons();
  buildObliqueButtons();
  buildPresets();
  syncToolbarToActive();
  // AFTER THE ROW IS BUILT, NOT BEFORE. Every builder above can change the row's width --
  // a language with longer words, a registry with one more tool -- and the measurement is
  // only worth anything once the row it measures exists.
  fitToolbar();
}
startI18n().then((lang) => { dressDateFields(lang); paintChrome(); });

// THE SELECTION REACHES THE PICTURE BY ONE PATH. Whoever changed it -- a shape, a panel
// row, a delete that cleared it -- every overlay is redrawn from here, so no call site has
// to remember to.
subscribeTo(['selectedMeasurement', 'measurements', 'hiddenMeasurements'], () => {
  for (const p of panels) drawOverlays(p);
});

// REMEMBERED PER STUDY, on every change. Not "saved": the heading still says these are not
// in the archive, because they are not -- writing a DICOM SR back is the right end state
// and is weeks away. What this buys is that a reload, a crash or a stray Back no longer
// erases an afternoon's work without a word.
subscribeTo(['measurements'], () => {
  // PER STUDY, BY THE MEASUREMENT'S OWN, not by the one variable the surface used to have.
  // With a prior open the list holds measurements from two studies at once, and writing
  // the whole list under the arrival study's UID would file the prior's calipers in the
  // current study's record -- then recall them onto it, where they would be read as
  // numbers taken from a picture they were never taken from.
  //
  // EVERY OPEN STUDY IS WRITTEN, including one whose measurements all just went: the
  // subset is then empty and `remember` removes the record, which is how a deletion
  // persists. Keyed off the panels rather than off the list for exactly that reason -- a
  // study with nothing left in the list is absent FROM the list.
  const byStudy = new Map();
  for (const p of panels) if (p.studyUID) byStudy.set(p.studyUID, []);
  if (studyUID) byStudy.set(studyUID, byStudy.get(studyUID) || []);
  for (const m of getState().measurements) {
    const uid = m.studyUID || studyUID;
    if (!uid) continue;
    if (!byStudy.has(uid)) byStudy.set(uid, []);
    byStudy.get(uid).push(m);
  }
  for (const [uid, held] of byStudy) remember(uid, held);
});
mountPanels();
showStudies();
