/* =====================================================================================
 * The measurements panel: what the model measured, and what the reader measured.
 *
 * THE DISTINCTION IS THE DESIGN
 * -------------------------------
 * These are not the same kind of claim and the panel must not let them look like it.
 *
 *   FROM THE MODEL   a DICOM SR row, computed by a capability over the whole volume, with
 *                    an `EvaluationRun` behind it and a `ModelVersion` that can be named.
 *   YOURS            one reader's drag on one slice, computed seconds ago, with nothing
 *                    behind it but the reader's hand.
 *
 * One undifferentiated table would let the second borrow the authority of the first. That
 * is `MOS-SAFE-012`'s adjacency problem in miniature -- the requirement exists because a
 * derived finding placed beside a measured one is read as equally established -- and the
 * cheapest correct answer is a heading that says which is which.
 *
 * "NOT SAVED" IS LITERAL
 * ------------------------
 * Reader measurements live in page memory and vanish on reload. That is a real limitation
 * and the panel states it rather than implying durability the surface does not have.
 *
 * It is also an OPEN QUESTION rather than an oversight. Persisting one means deciding what
 * it IS: a `ResultReview` modification under `MOS-SAFE-069`, a new SR the platform authors,
 * or neither. `MOS-UI-004` forbids an operator-surface-only capability -- "anything either
 * surface can do MUST be doable by an API client with the same permissions" -- so a viewer
 * that quietly kept its own measurement store would be creating exactly that. Inventing a
 * fourth answer here would be the platform asserting a record shape nobody specified.
 *
 * Spec: MOS-SAFE-012, MOS-SAFE-069, MOS-UI-004, MOS-IMG-039, MOS-CORE-004 (units and
 * wording are vocabulary).
 * ===================================================================================== */

import { KINDS, register } from '../core/registry.js';
import { icon } from './icons.js';
import { get, set, subscribeTo } from '../core/state.js';
import {
  angleText, areaText, distanceText, emptyRegionNote, paddingNote, projectionNote,
  resolutionNote, spreadWithUnit,
} from '../image/units.js';

function escape(s) {
  return String(s).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

/**
 * The displayed form of a reader measurement.
 *
 * Formatting happens here and the stored measurement keeps full precision, so nothing
 * downstream is ever tempted to re-parse a label back into a number.
 */
/**
 * A number from the model, in the same convention as every other number on this surface.
 *
 * THIS WAS `toLocaleString(undefined, ...)`, and `undefined` means THE BROWSER'S LOCALE.
 * Measured on this machine, reading a real thorax CT's organ-at-risk SR:
 *
 *     rendered            meant          read as, by a reader expecting a decimal point
 *     3 162,538 ml        3162.538 ml    three million millilitres
 *     9,522 mm            9.522 mm       nine thousand millimetres
 *     0,452 ml            0.452 ml       four hundred and fifty-two millilitres
 *
 * A factor of a thousand, in the direction of "this lung is enormous", on a value the
 * reader is being shown BECAUSE a model produced it. And the caliper beside it in the same
 * panel prints `109.7 mm` through `distanceText`, which uses `toFixed` -- so one screen
 * carried two decimal conventions and neither was labelled.
 *
 * The DICOM source is unambiguous: a DS value is a decimal string with a period, and an SR
 * numeric value carries no locale. Re-rendering it in one is the surface inventing an
 * interpretation the data does not have.
 *
 * NO THOUSANDS GROUPING either, for the same reason: `3,162.538` and `3.162,538` are the
 * same digits under two conventions, and the only way to be unambiguous in both is to
 * group in neither. Three decimals, matching what the old call asked for.
 */
function modelValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return String(Math.round(n * 1000) / 1000);
}

function readerValue(m) {
  if (m.kind === 'length') {
    return distanceText(m.value.mm, m.value.px, m.spacingStated)
      + projectionNote(m) + resolutionNote(m);
  }
  if (m.kind === 'angle') {
    return Number.isFinite(m.value) ? angleText(m.value, m.spacingStated) : 'no measurement';
  }
  if (m.kind === 'note') {
    // A NOTE'S VALUE IS ITS TEXT. There is no number, and a row that printed one
    // -- even a dash -- would put a note in the same column as a measurement and
    // invite it to be read as one.
    return String(m.text || '(empty)');
  }
  if (m.kind === 'roi') {
    // MEAN AND SD TOGETHER, always. A mean alone invites a heterogeneous region to be read
    // as a homogeneous one -- and that is not theoretical: an ROI straddling the body edge
    // during this module's own verification reported -473 HU, which looks like a plausible
    // tissue value until the SD of 430 beside it says the region spans air and soft tissue.
    // The spread is what tells a reader their placement was wrong.
    // An ROI that excluded every pixel it enclosed is not a measurement, and `NaN +/- NaN`
    // is not a way of saying so. Both renderers ask the same function.
    return emptyRegionNote(m.value)
      || (spreadWithUnit(m.value.mean, m.value.sd, m.valueUnit)
        + paddingNote(m.value) + projectionNote(m));
  }
  return '';
}

/* ------------------------------------------------- grouping ---------------------- */

//: How the table is arranged, and which groups the reader has folded. Per-browser.
const GROUP_KEY = 'medos.viewer.meas.group';
const FOLD_KEY = 'medos.viewer.meas.folded';

const GROUPINGS = [
  { id: 'none', label: 'No grouping' },
  { id: 'kind', label: 'By kind' },
  { id: 'slice', label: 'By slice' },
];

function readStore(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    // A private window, or blocked site data. The default arrangement is usable.
    return fallback;
  }
}

function writeStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // The choice still applies to this session; it just will not outlive it.
  }
}

/**
 * Split the measurements into the groups the reader asked for.
 *
 * ORDER IS PRESERVED INSIDE EVERY GROUP, and the groups come out in the order their
 * first member was taken. Sorting them by name would put `angle` above `length`
 * whatever the reader did first, and the order measurements were taken in is itself
 * information -- it is the order the reader worked.
 */
function grouped(rows, mode) {
  if (mode === 'none') return [{ key: '', label: '', rows }];
  const order = [];
  const byKey = new Map();
  for (const m of rows) {
    const key = mode === 'kind'
      ? String(m.kind || 'other')
      : `${m.planeName || m.plane} ${m.sliceIndex + 1}`;
    if (!byKey.has(key)) { byKey.set(key, []); order.push(key); }
    byKey.get(key).push(m);
  }
  return order.map((key) => ({ key, label: key, rows: byKey.get(key) }));
}

/**
 * Put the reader back on the row they were editing, and take the caret with you.
 *
 * WHY A STRAY CARET IS NOT COSMETIC. Committing an edit re-renders this panel, which
 * replaces its `innerHTML` -- so the focused `<input>` is destroyed mid-edit. Focus falls
 * to `<body>` and the selection collapses to a CARET on the nearest surviving text node,
 * which is the word "Yours" in the panel's own heading. A blinking caret sitting in a
 * heading tells the reader that heading is a text field. It is not, and the next thing
 * they type goes to the shell's global key bindings instead -- where `d` arms the
 * freehand tool and Delete removes the selected measurement.
 */
function restoreRowFocus(root, id) {
  const selection = window.getSelection();
  if (selection) selection.removeAllRanges();
  // AFTER the re-render, not before: the row this returns to is a new element.
  // TWO FRAMES, because `set()` schedules the re-render rather than doing it inline: one
  // frame lands before the new rows exist and the lookup finds nothing, which is why the
  // first version cleared the caret and left focus on <body>.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const rows = [...root.querySelectorAll('tr[data-m]')];
    const again = rows.find((r) => String(r.dataset.m) === String(id));
    if (again) again.focus();
  }));
}

function render(root) {
  const {
    measurements, srMeasurements, panels, active,
    selectedMeasurement: selected, hiddenMeasurements,
  } = get();
  // A SET, because the row template asks about every measurement in turn and an
  // array would make the table quadratic in a session with many of them.
  const hidden = new Set((hiddenMeasurements || []).map(String));
  const parts = [];

  // WHICH SERIES THIS ROW BELONGS TO, when it is not the one on screen. A plane and a slice
  // number are not an address: with two series loaded, "length axial 33" names a row in
  // each of them and the two rows are identical. The annotation layer stopped drawing
  // across series for this reason; the list has to say it rather than stop showing them,
  // because the list is the session's record and a measurement does not cease to exist
  // when the reader looks at something else.
  const shown = panels && panels[active] ? panels[active].seriesUID : null;
  const elsewhere = (m) => shown && m.seriesUID && m.seriesUID !== shown;

  // AND WHETHER IT IS ANOTHER STUDY, which is a different statement and a louder one.
  //
  // "· another series" describes an ordinary, safe, within-study situation. A reader who
  // has seen it a hundred times has been taught it means "not the picture you are on, and
  // that is fine". Once a prior can be open, the SAME marking would appear on a row
  // measured on a different study -- a different day, a different acquisition, the very
  // thing the reader is comparing -- and it would read as the familiar harmless one.
  //
  // This surface has been here before, from the other side: a caliper from one patient
  // stayed in this table while another patient's study was open, marked "· another
  // series", and the wording is what made it invisible. The fix then was to scope the
  // list. The fix now is to say the larger difference in larger words, because this time
  // the row belongs in the list -- comparing two studies is the point.
  const shownStudy = panels && panels[active] ? panels[active].studyUID : null;
  const otherStudy = (m) => shownStudy && m.studyUID && m.studyUID !== shownStudy;

  if (measurements.length) {
    const mode = readStore(GROUP_KEY, 'none');
    const foldedGroups = new Set(readStore(FOLD_KEY, []));
    parts.push(
      '<div class="meas-head">Yours '
      + '<span class="muted">this session, not saved</span>'
      // THE PANEL'S OWN SETTINGS, beside the thing they arrange rather than in a
      // dialog two clicks away: this is changed while reading, not configured once.
      + '<select class="meas-group" aria-label="Group the measurements">'
      + GROUPINGS.map((g) => (
        `<option value="${g.id}"${g.id === mode ? ' selected' : ''}>${escape(g.label)}</option>`
      )).join('')
      + '</select></div>',
    );

    for (const group of grouped(measurements, mode)) {
      const isFolded = foldedGroups.has(group.key);
      if (group.key) {
        // THE COUNT IS ON THE HEADER, so a folded group still says how much it holds.
        // A fold that hides both the rows and the fact that there are rows is a way to
        // lose a measurement without deleting it.
        parts.push(
          `<button type="button" class="meas-group-head" data-group="${escape(group.key)}"`
          + ` aria-expanded="${!isFolded}">`
          + `<span class="mg-mark" aria-hidden="true">${icon('chevron')}</span>`
          + `<span class="mg-label">${escape(group.label)}</span>`
          + `<span class="mg-count">${group.rows.length}</span></button>`,
        );
      }
      if (isFolded) continue;
      parts.push('<table class="meas">' + group.rows.map((m) => (
      // BY ID, NOT BY POSITION. `data-drop="${i}"` addressed a measurement by where
      // it happened to sit in the array, so deleting the first of three renumbered the
      // other two and any reference held across that moment meant a different one.
      `<tr data-m="${escape(String(m.id))}"`
      // A ROW IS A CONTROL, and until now it was one only for a mouse: no tabindex, no
      // role, no key handler. A reader who navigates by keyboard could read the table
      // and reach nothing in it.
      + ` tabindex="0" role="button" aria-selected="${m.id === selected}"`
      + ` class="${m.id === selected ? 'on' : ''}${hidden.has(String(m.id)) ? ' dimmed' : ''}">`
      // THE CLAMP LIVES ON THIS SPAN, not on the cell. A `display` on a `<td>` takes it
      // out of the table's formatting context, and the row's highlight and divider then
      // break into two misaligned pieces.
      + `<td><span class="meas-name">${escape(m.label || m.kind)} `
      + `<span class="muted tiny">${escape(m.planeName || m.plane)} ${m.sliceIndex + 1}`
      + `${elsewhere(m) && !otherStudy(m) ? ' · another series' : ''}</span>`
      // THE STUDY WINS WHEN BOTH ARE TRUE, and it is its own element rather than more
      // text inside `.muted.tiny`. A measurement on a prior is necessarily on another
      // series too; printing both would bury the one that matters behind the one the
      // reader has learned to skip, and printing it in the quiet colour would do the
      // same thing more slowly.
      + `${otherStudy(m) ? '<span class="meas-other-study">· another study</span>' : ''}`
      + '</span></td>'
      // A NOTE IS NOT A NUMBER. `.num` is right-aligned tabular monospace that never
      // wraps. This module's own comment says a note must not sit 'in the same column
      // as a measurement and invite it to be read as one' -- and then put it there,
      // because the cell class was unconditional.
      + `<td class="${m.kind === 'note' ? 'note-text' : 'num'}"`
      // THE WHOLE NOTE IN `title`. It wraps rather than truncates, but a very long one
      // still makes a tall row -- the tooltip is how a reader reads it without scrolling
      // the panel. Only for notes: a measured value is short and already complete.
      + `${m.kind === 'note' && m.text ? ` title="${escape(m.text)}"` : ''}>`
      + `${escape(readerValue(m))}</td>`
      + `<td class="unit">`
      // HIDDEN IS NOT DELETED. A reader comparing two of five measurements should not
      // have to destroy the other three to see past them. Visibility is a property of
      // the READER'S CURRENT VIEW and not of the measurement, which is why it lives in
      // state and never on the frozen record -- a hidden measurement is still in the
      // CSV, because it was still taken.
      + `<button class="linkish" data-eye="${escape(String(m.id))}" `
      + `aria-pressed="${hidden.has(String(m.id))}" `
      + `aria-label="${hidden.has(String(m.id)) ? 'Show' : 'Hide'} this measurement" `
      + `title="${hidden.has(String(m.id)) ? 'Show' : 'Hide'} on the image">`
      + `${icon(hidden.has(String(m.id)) ? 'eyeOff' : 'eye')}</button>`
      + `<button class="linkish" data-drop="${escape(String(m.id))}" `
      + `aria-label="Remove this ${escape(m.kind)} measurement" `
      + `title="Remove this measurement">×</button></td></tr>`
      )).join('') + '</table>');
    }
  }

  if (srMeasurements && srMeasurements.length) {
    parts.push('<div class="meas-head">From the model <span class="muted">DICOM SR</span></div>');
    parts.push('<table class="meas">' + srMeasurements.map((r) => (
      `<tr><td>${escape(r.name)}</td>`
      + `<td class="num">${escape(modelValue(r.value))}</td>`
      + `<td class="unit">${escape(r.unit)}</td></tr>`
    )).join('') + '</table>');
  }

  root.innerHTML = parts.length ? parts.join('') : '<p class="muted">no measurements yet</p>';

  for (const button of root.querySelectorAll('[data-drop]')) {
    button.onclick = (e) => {
      e.stopPropagation();
      const id = button.dataset.drop;
      const next = get().measurements.filter((m) => String(m.id) !== id);
      const patch = { measurements: next };
      // Clearing a selection that no longer exists, here rather than in the shell: the
      // panel is what removed it, so the panel is what knows the selection is stale.
      if (get().selectedMeasurement === id) patch.selectedMeasurement = null;
      set(patch, 'measurements-panel');
    };
  }

  // A ROW POINTS AT A SHAPE. The rows were dead ends -- no click, no hover, no selected
  // state -- so a measurement thirty slices back was a number you could read and not get
  // back to. Clicking one selects it, which the annotation layer draws and the shell acts
  // on.
  // THE GROUPING CONTROL AND THE GROUP HEADERS. Both write to this browser only: how a
  // reader arranges their own working list is not a fact about the measurements, and it
  // never reaches the record or the export.
  const groupSelect = root.querySelector('.meas-group');
  if (groupSelect) {
    groupSelect.onchange = () => {
      writeStore(GROUP_KEY, groupSelect.value);
      // REGROUPING RESETS THE FOLDS. A group key from `by kind` means nothing under
      // `by slice`, so keeping them would fold arbitrary groups of the new arrangement.
      writeStore(FOLD_KEY, []);
      render(root);
    };
  }
  for (const head of root.querySelectorAll('.meas-group-head')) {
    head.onclick = () => {
      const held = new Set(readStore(FOLD_KEY, []));
      const key = head.dataset.group;
      if (held.has(key)) held.delete(key); else held.add(key);
      writeStore(FOLD_KEY, [...held]);
      render(root);
    };
  }

  // THE EYE. Toggling visibility must not touch the record, so it writes the id into
  // the view's own list and the shell filters on it at draw time.
  for (const button of root.querySelectorAll('button[data-eye]')) {
    button.onclick = (e) => {
      e.stopPropagation();
      const id = String(button.dataset.eye);
      const held = new Set((get().hiddenMeasurements || []).map(String));
      if (held.has(id)) held.delete(id); else held.add(id);
      set({ hiddenMeasurements: [...held] }, 'measurements-panel');
    };
  }

  for (const row of root.querySelectorAll('tr[data-m]')) {
    row.onclick = () => set({ selectedMeasurement: row.dataset.m }, 'measurements-panel');

    // REACHABLE WITHOUT A MOUSE. Enter and Space select, which is what `role=button`
    // promises; F2 renames, which is what a table row does in every file manager the
    // reader has used. Without these the tabindex added to the row would be a promise
    // the markup makes and the behaviour does not keep.
    row.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        set({ selectedMeasurement: row.dataset.m }, 'measurements-panel');
      }
      if (e.key === 'F2') {
        e.preventDefault();
        // F2 EDITS WHAT THE ROW IS ABOUT. For a note that is its TEXT, which lives in the
        // second cell; for a measurement it is the name, because the value is not
        // editable by hand and never will be. Sending F2 to the first cell for a note
        // would offer to rename `note` while leaving the sentence untouchable.
        const cell = row.querySelector('td.note-text') || row.querySelector('td');
        if (cell && cell.ondblclick) cell.ondblclick(new Event('dblclick'));
      }
    };

    /**
     * AND A MEASUREMENT CAN BE NAMED. The record has carried a `label` since it was given
     * an id and nothing ever wrote one, so three nodules on one slice gave three rows
     * reading "length axial 33" -- identical, and telling them apart meant clicking each
     * one to see which shape lit up.
     *
     * Double-click, because a single click already selects and a reader selecting a row
     * is not asking to rename it. Inline, because a dialogue for one short string is a
     * dialogue they have to dismiss.
     */
    /**
     * AND A NOTE'S TEXT CAN BE CHANGED, which it could not.
     *
     * `editNote` in the shell is reached from exactly one place -- the moment a note is
     * committed with an empty string. Once the reader pressed Enter, `m.text` was set and
     * nothing could open that editor again: the sentence they had just written was
     * permanent, and the only way to correct a typo was to delete the note and place a new
     * one, losing its anchor. Double-click edits the TEXT here, in the cell the text is
     * actually in, by the same route the label rename already uses.
     *
     * The label rename below still applies to a note as well -- a note has a name and a
     * body like everything else in this table, and they are different fields.
     */
    const noteCell = row.querySelector('td.note-text');
    if (noteCell) {
      noteCell.title = 'Double-click to edit this note';
      noteCell.ondblclick = (e) => {
        e.stopPropagation();
        const id = row.dataset.m;
        const current = get().measurements.find((x) => String(x.id) === id);
        if (!current) return;
        const input = document.createElement('input');
        input.className = 'meas-label';
        input.value = current.text || '';
        input.placeholder = 'Note';
        input.setAttribute('aria-label', 'Text for this note');
        noteCell.textContent = '';
        noteCell.appendChild(input);
        input.focus();
        input.select();

        const commitNote = (keep) => {
          if (input.dataset.done) return;
          input.dataset.done = '1';
          if (!keep) { render(root); restoreRowFocus(root, id); return; }
          const text = input.value.trim();
          // A FROZEN RECORD IS REPLACED, NOT MUTATED -- the same rule the label rename
          // below states. An EMPTY note is kept rather than deleted: the reader asked to
          // change the words, not to remove the mark, and `editNote` in the shell already
          // deletes an abandoned NEW note, which is a different situation.
          set({
            measurements: get().measurements.map((x) => (String(x.id) === id
              ? Object.freeze({ ...x, text })
              : x)),
          }, 'measurements-panel');
          restoreRowFocus(root, id);
        };
        input.onblur = () => commitNote(true);
        input.onkeydown = (ev) => {
          if (ev.key === 'Enter') { ev.preventDefault(); commitNote(true); }
          if (ev.key === 'Escape') { ev.preventDefault(); commitNote(false); }
          // Backspace here is a backspace, not a delete of the note being edited.
          ev.stopPropagation();
        };
      };
    }

    const cell = row.querySelector('td');
    if (!cell) continue;
    cell.title = 'Double-click to name this measurement';
    cell.ondblclick = (e) => {
      e.stopPropagation();
      const id = row.dataset.m;
      const current = get().measurements.find((x) => String(x.id) === id);
      if (!current) return;
      const input = document.createElement('input');
      input.className = 'meas-label';
      input.value = current.label || '';
      input.placeholder = current.kind;
      input.setAttribute('aria-label', 'Name this measurement');
      cell.textContent = '';
      cell.appendChild(input);
      input.focus();
      input.select();

      const commit = (keep) => {
        if (input.dataset.done) return;
        input.dataset.done = '1';
        if (keep) {
          const label = input.value.trim();
          // A FROZEN RECORD IS REPLACED, NOT MUTATED. Every other edit path in this
          // surface rebuilds; a label that was assigned in place would be the one field
          // that changed without the list changing, and nothing would re-render.
          set({
            measurements: get().measurements.map((x) => (String(x.id) === id
              ? Object.freeze({ ...x, label: label || null })
              : x)),
          }, 'measurements-panel');
          restoreRowFocus(root, id);
        } else {
          render(root);
          restoreRowFocus(root, id);
        }
      };
      input.onblur = () => commit(true);
      input.onkeydown = (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); commit(true); }
        if (ev.key === 'Escape') { ev.preventDefault(); commit(false); }
        // Backspace in this box is a backspace, not a delete of the measurement.
        ev.stopPropagation();
      };
    };
  }
}

export default register({
  id: 'medos.measurements',
  kind: KINDS.PANEL,
  title: 'Measurements',
  order: 30,
  slot: 'right',

  mount(root) {
    render(root);
    // `panels` and `active` too, because which series is on screen decides whether a
    // row is marked as belonging to another one.
    // `hiddenMeasurements` BELONGS IN THIS LIST. It was read by the render and written
    // by the eye and left out of the subscription, so the state changed and nothing
    // re-rendered: the eye did nothing at all, and every static gate still passed
    // because the code they read was present and correct.
    return subscribeTo(['measurements', 'srMeasurements', 'panels', 'active',
                        'selectedMeasurement', 'hiddenMeasurements'],
      () => render(root));
  },
});
