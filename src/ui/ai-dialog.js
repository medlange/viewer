// SPDX-License-Identifier: Apache-2.0
/* =====================================================================================
 * The analyze dialog: run a capability against the open study without leaving the viewer.
 *
 * THIS IS WHAT THE ROADMAP CALLS U3. The analysis used to live on a separate page
 * (`/medicalos/standalone/`), and a reader who opened a study in the viewer could do
 * nothing with it -- measured by the owner on 2026-10-03 as "открыл исследование и
 * ничего не могу сделать". The dialog is the plug-n-play seam between the viewer and
 * Medlange Core: the model LIST comes from `window.VIEWER_CONFIG.capabilities` (the
 * deployment's configured whitelist, the same source the MedicalOS panel uses), the
 * DEPENDENCY EDGES come from the platform's `GET /api/v1/capabilities`, the request
 * goes same-origin to `/api/v1` where the host injects the credential (the page holds
 * none -- MOS-UI-316), and on completion the shell reloads the study so the SEG/SR the
 * platform stored appears as an overlay.
 *
 * WHY TWO SOURCES AND NOT ONE. `MOS-UI-366` fixed the offered list as the configured
 * list when the platform had no route to read; the route exists now
 * (`medos.api.routes_jobs.list_capabilities`). The list stays configured -- a
 * deployment whitelists what its readers may run -- but a capability's `depends_on`
 * edges are platform DATA (CONTRACT.md section 7: `emphysema_laa` needs
 * `lung_segmentation`'s mask in the same job), not viewer configuration. A dialog
 * that showed `emphysema_laa` as a standalone choice used to submit it alone, and the
 * worker refused the job with `capability_resolution_failed` -- measured live on
 * 2026-10-03. The closure below requests the dependency with the selection, and the
 * note under the list says so before the reader presses the button.
 *
 * IT MUST NOT IMPORT THE SHELL. `viewer/tests/test_architecture.py` fails any `src/ui/*`
 * module that reaches into app.js; the action (`ai-action.js`) passes the study and the
 * reload callback in through the registration, the same seam panels and tools use.
 *
 * THE REFUSAL IS RENDERED, NOT SWALLOWED. A deployment with no credential configured
 * answers `401 AUTHENTICATION_REQUIRED`; the dialog shows that problem document's
 * detail, because a button that silently does nothing is how a reader learns not to
 * press buttons. The descriptor call degrades the same way a missing list would: on
 * any non-OK answer (a 404 platform, an old core) the closure is empty, which is the
 * pre-route behaviour, not an error the reader can act on.
 * ===================================================================================== */

import { openDialog, closeDialog } from './dialogs.js';
import { t } from '../core/i18n.js';

/** Terminal states of `GET /api/v1/jobs/{id}` (the platform's public job enum). */
const TERMINAL = new Set(['COMPLETED', 'FAILED', 'REJECTED', 'CANCELLED']);

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function problemOf(response) {
  try {
    const body = await response.json();
    return new Error(
      body.detail || body.title || `${response.status} ${response.statusText}`,
    );
  } catch {
    return new Error(`${response.status} ${response.statusText}`);
  }
}

/**
 * `GET /api/v1/capabilities` -> `Map<capability_id, depends_on[]>`, or `null`.
 *
 * `null` is the DEGRADED answer, not the error answer: a platform old enough to
 * predate the route (or a proxy that hides it) still serves single-capability jobs
 * fine, so the dialog falls back to empty edges and behaves the way it did before
 * the route existed. The refusal rendering for the SUBMIT path is unchanged -- that
 * one the reader must see.
 */
export async function loadCapabilityDescriptors(apiRoot, fetchImpl) {
  const response = await fetchImpl(`${apiRoot}/capabilities`, {
    headers: { Accept: 'application/json, application/problem+json' },
  });
  if (!response.ok) return null;
  const body = await response.json().catch(() => null);
  if (!body || !Array.isArray(body.capabilities)) return null;
  return new Map(
    body.capabilities.map((d) => [d.capability_id, d.depends_on || []]),
  );
}

/**
 * The capability set one selection must submit: the selection plus every
 * `depends_on` edge, transitively. Sorted for a stable wire body -- the worker
 * orders its own steps regardless, but a deterministic request body makes the
 * idempotency key (MOS-EXEC-053) deterministic too. Cycle-safe: an edge already
 * visited is not walked twice, and a provider that declares a cycle gets its own
 * `resolve_capability_order` ValueError server-side, not a hung dialog here.
 */
export function closureFor(capabilityId, depsById) {
  const out = new Set();
  const visit = (id) => {
    if (out.has(id)) return;
    out.add(id);
    for (const dep of depsById.get(id) || []) visit(dep);
  };
  visit(capabilityId);
  return [...out].sort();
}

/** POST /api/v1/jobs, CONTRACT.md §9's body, and nothing else (MOS-SAFE-089a's shape). */
export async function createJob(apiRoot, { studyUid, capabilities }, fetchImpl) {
  const response = await fetchImpl(`${apiRoot}/jobs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, application/problem+json',
    },
    body: JSON.stringify({ study_instance_uid: studyUid, capabilities }),
  });
  if (response.status === 200 || response.status === 202) {
    return (await response.json()).job_id;
  }
  throw await problemOf(response);
}

/** One poll of `GET /api/v1/jobs/{id}`. */
export async function readJob(apiRoot, jobId, fetchImpl) {
  const response = await fetchImpl(`${apiRoot}/jobs/${jobId}`, {
    headers: { Accept: 'application/json, application/problem+json' },
  });
  if (!response.ok) throw await problemOf(response);
  return response.json();
}

/**
 * Open the dialog. `onDone` is the shell's reload callback; invoked only when the job
 * COMPLETEDs, so a failed run never reloads the study out from under the reader.
 */
export function openAnalyzeDialog({ studyUid, onDone, fetchImpl } = {}) {
  const cfg = (typeof window !== 'undefined' && window.VIEWER_CONFIG) || {};
  const apiRoot = cfg.apiRoot || '/api/v1';
  const capabilities = cfg.capabilities || [];
  const doFetch = fetchImpl || ((...args) => fetch(...args));
  // Empty edges until the platform answers; `closureFor` reads this map, so a failed
  // descriptor call leaves the pre-route behaviour (submit the one selection) intact.
  const depsById = new Map(capabilities.map((id) => [id, []]));

  const radios = capabilities.map((id, i) => `
    <label class="ai-choice">
      <input type="radio" name="ai-capability" value="${esc(id)}" ${i === 0 ? 'checked' : ''}>
      <span>${esc(id)}</span>
    </label>`).join('');

  const body = `
    <div class="ai-dialog">
      <p class="ai-study"><span>${esc(t('ai.study', 'Study'))}</span>
        <code>${esc(studyUid)}</code></p>
      <fieldset class="ai-models" ${capabilities.length ? '' : 'disabled'}>
        <legend>${esc(t('ai.model', 'Model'))}</legend>
        ${radios || `<p class="ai-none">${esc(t('ai.noneConfigured',
          'No capabilities are configured for this deployment. Add a "capabilities" list to viewer-config.js.'))}</p>`}
      </fieldset>
      <p class="ai-deps" role="note" hidden></p>
      <p class="ai-status" role="status" aria-live="polite"></p>
      <div class="ai-actions">
        <button type="button" class="ai-run" ${capabilities.length ? '' : 'disabled'}>
          ${esc(t('ai.submit', 'Run analysis'))}</button>
        <button type="button" class="ai-refresh" hidden>
          ${esc(t('ai.refresh', 'Show results'))}</button>
      </div>
    </div>`;

  openDialog({
    title: t('ai.title', 'Analyze this study'),
    body,
    onOpen(host) {
      const run = host.querySelector('.ai-run');
      const refresh = host.querySelector('.ai-refresh');
      const status = host.querySelector('.ai-status');
      const depsNote = host.querySelector('.ai-deps');
      if (!capabilities.length) return;

      const selected = () =>
        host.querySelector('input[name="ai-capability"]:checked')?.value;

      // Tells the reader what the selection drags in BEFORE they press the button.
      // An empty closure (the selection itself only) hides the note rather than
      // rendering "Also runs:" with nothing after it.
      const renderDeps = () => {
        const closure = closureFor(selected(), depsById);
        const dragged = closure.filter((id) => id !== selected());
        if (!dragged.length) {
          depsNote.hidden = true;
          depsNote.textContent = '';
        } else {
          depsNote.hidden = false;
          depsNote.textContent = `${t('ai.alsoRuns', 'Also runs')}: ${dragged.join(', ')}`;
        }
      };
      host.querySelector('.ai-models').addEventListener('change', renderDeps);
      renderDeps();
      // The edges may arrive after the dialog is open; when they do, the note for the
      // CURRENT selection re-renders. A stale note is worse than a late one.
      loadCapabilityDescriptors(apiRoot, doFetch).then((descriptors) => {
        if (descriptors === null) return;
        for (const id of capabilities) {
          if (descriptors.has(id)) depsById.set(id, descriptors.get(id));
        }
        renderDeps();
      });

      run.onclick = async () => {
        const capability = selected();
        run.disabled = true;
        status.textContent = t('ai.submitting', 'Submitting…');
        let jobId;
        try {
          jobId = await createJob(
            apiRoot, { studyUid, capabilities: closureFor(capability, depsById) }, doFetch,
          );
        } catch (err) {
          // THE REFUSAL, RENDERED: 401 without a credential, 403 without a grant -- the
          // reader sees the platform's own sentence, not a dead button.
          status.textContent = String(err.message || err);
          run.disabled = false;
          return;
        }
        for (;;) {
          status.textContent = t('ai.running', 'Running… {state} {step}')
            .replace('{state}', '…').replace('{step}', jobId.slice(0, 12));
          let job;
          try {
            job = await readJob(apiRoot, jobId, doFetch);
          } catch (err) {
            status.textContent = String(err.message || err);
            run.disabled = false;
            return;
          }
          const step = job.steps_completed != null
            ? `${job.steps_completed}` : '';
          status.textContent = t('ai.running', 'Running… {state} {step}')
            .replace('{state}', job.state || '…').replace('{step}', step);
          if (TERMINAL.has(job.state)) {
            if (job.state === 'COMPLETED') {
              status.textContent = t('ai.done',
                'Analysis complete. SEG and SR were stored to the study.');
              refresh.hidden = false;
              refresh.focus();
            } else {
              status.textContent = t('ai.failed', 'The job ended as {state}.')
                .replace('{state}', job.state);
              run.disabled = false;
            }
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      };

      refresh.onclick = () => {
        // The dialog's work is done; the shell re-opens the study and the stored
        // SEG/SR arrive as series the segments panel picks up on its own. Closing
        // before the reload keeps the reader's eyes on the image, not on a dead dialog.
        closeDialog();
        if (onDone) onDone();
      };
    },
  });
}
