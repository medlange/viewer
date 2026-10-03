// SPDX-License-Identifier: Apache-2.0
/* =====================================================================================
 * Worklist upload (U4): Part-10 files from disk into the archive, without leaving the
 * viewer.
 *
 * THE PROBLEM THIS SOLVES. The worklist was read-only from the reader's side: a study
 * arriving on a CD-ROM, a USB stick or a messenger folder had to be ingested by
 * somebody with shell access to the archive. The reader who HAS the files could not
 * put them anywhere. This module is the missing verb: pick files (or a directory, or
 * drop them on the worklist) and they go to the same DICOMweb root every read uses.
 *
 * THE WIRE SHAPE IS STOW-RS, ASSEMBLED BY HAND. `multipart/related; type=
 * "application/dicom"` with Content-Type + Content-Length parts and no
 * Content-Disposition — the same construction as `medos.dicomweb.client.stow`, because
 * a `multipart/form-data` encoder (FormData) emits a shape a DICOMweb origin is
 * entitled to reject outright. One batch per drop/pick; the response's
 * FailedSOPSequence (0008,1198) is reported, not swallowed (MOS-IMG-084's shape).
 *
 * IT MUST NOT IMPORT THE SHELL. `bindUpload` receives the DICOMweb root, a refresh
 * callback and an announce callback from app.js — the same seam ai-action uses.
 * A refused batch announces the platform's own sentence and keeps the files listed,
 * because a silent drop teaches the reader never to drop.
 * ===================================================================================== */

import { t } from '../core/i18n.js';

const MULTIPART_DICOM = 'application/dicom';

/** Assemble one STOW-RS multipart/related body. Mirrors `DicomWebClient.stow`. */
export function buildStowBody(files) {
  // A MIME boundary (RFC 2046), unpredictable so it cannot collide with Part-10 bytes.
  // This writes no DICOM identifier; the platform's uuid4 ban covers UID minting.
  const boundary = `medlange-${crypto.getRandomValues(new Uint32Array(4)).join('-')}`;
  const chunks = [];
  const enc = new TextEncoder();
  for (const file of files) {
    chunks.push(enc.encode(
      `--${boundary}\r\n`
      + `Content-Type: ${MULTIPART_DICOM}\r\n`
      + `Content-Length: ${file.size}\r\n`
      + '\r\n',
    ));
    chunks.push(file);
    chunks.push(enc.encode('\r\n'));
  }
  chunks.push(enc.encode(`--${boundary}--\r\n`));
  return { boundary, parts: chunks };
}

/** POST one batch to `{root}/studies`. Returns {stored, failed} or throws an Error
 *  carrying the platform's problem detail. */
export async function stowFiles(root, files, fetchImpl) {
  const doFetch = fetchImpl || ((...args) => fetch(...args));
  const { boundary, parts } = buildStowBody(files);
  const body = new Blob(parts, { type: `multipart/related; boundary=${boundary}` });
  const response = await doFetch(`${String(root).replace(/\/+$/, '')}/studies`, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/related; type="${MULTIPART_DICOM}"; boundary=${boundary}`,
      Accept: 'application/dicom+json, application/problem+json',
    },
    body,
  });
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const doc = await response.json();
      detail = doc.detail || doc.title || detail;
    } catch { /* a non-JSON refusal still names its status */ }
    throw new Error(detail);
  }
  // MOS-IMG-084: 200 with a non-empty FailedSOPSequence is a partial store the reader
  // must SEE. The sequence travels in DICOM JSON: (0008,1198).
  let failed = 0;
  try {
    const doc = await response.json();
    const seq = doc?.['00081198']?.Value;
    if (Array.isArray(seq)) failed = seq.length;
  } catch { /* an origin that answers 200 with no JSON body stored what it took */ }
  return { stored: files.length - failed, failed };
}

/**
 * Wire the worklist upload. `root` is the DICOMweb root reads use (tenant included);
 * `onDone` refreshes the worklist; `announce(message, kind)` is the shell's notice bar.
 */
export function bindUpload({ root, onDone, announce } = {}) {
  const button = document.getElementById('wl-upload');
  if (!button) return;
  const section = document.getElementById('study-list');

  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = '.dcm,application/dicom';
  input.hidden = true;
  document.body.appendChild(input);

  let busy = false;
  const run = async (fileList) => {
    const files = [...fileList].filter((f) => f.size > 0);
    if (!files.length || busy) return;
    busy = true;
    button.disabled = true;
    announce(t('upload.sending', 'Uploading {n} file(s)…').replace('{n}', String(files.length)), 'info');
    try {
      const { stored, failed } = await stowFiles(root, files);
      if (failed) {
        announce(t('upload.partial', 'Stored {stored} of {n}; {failed} refused by the archive')
          .replace('{stored}', String(stored)).replace('{n}', String(files.length))
          .replace('{failed}', String(failed)), 'err');
      } else {
        announce(t('upload.done', 'Stored {n} file(s) to the archive')
          .replace('{n}', String(stored)), '');
      }
      if (onDone) onDone();
    } catch (err) {
      // THE REFUSAL, ANNOUNCED: the archive's own sentence, files kept in hand.
      announce(String(err.message || err), 'err');
    } finally {
      busy = false;
      button.disabled = false;
      input.value = '';
    }
  };

  button.addEventListener('click', () => input.click());
  input.addEventListener('change', () => run(input.files));

  // DRAG-DROP onto the worklist section. dragover must be prevented or the drop event
  // never fires — the one browser behaviour every upload UI has to relearn.
  let depth = 0;
  section.addEventListener('dragenter', (e) => {
    if (e.dataTransfer?.types?.includes('Files')) { depth += 1; section.classList.add('wl-drop'); }
  });
  section.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) section.classList.remove('wl-drop');
  });
  section.addEventListener('dragover', (e) => e.preventDefault());
  section.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    section.classList.remove('wl-drop');
    if (e.dataTransfer?.files?.length) run(e.dataTransfer.files);
  });
}
