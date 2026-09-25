/* =====================================================================================
 * The viewer's contribution registries: panels, tools and overlays.
 *
 * WHY THIS EXISTS NOW AND NOT LATER
 * -----------------------------------
 * `app.js` is 830 lines and does everything: the study list, the series list, the panel
 * grid, the toolbar, the interaction model, three side panels and the help overlay. The
 * directive's next tranche -- measurements, annotations, AI overlays with confidence and
 * model version, and modality support beyond CT -- all lands in the same file. At that
 * point every feature is an edit to one module, which is precisely the OHIF complaint this
 * viewer was built to avoid. Adding the seam AFTER the file is 2,000 lines is a rewrite;
 * adding it now is a refactor.
 *
 * WHAT A CONTRIBUTION IS
 * -----------------------
 * A plain object with a `id`, a `kind` and the few functions that kind needs. No classes,
 * no base to extend, no lifecycle framework. A panel renders into an element it is given
 * and subscribes to the state it cares about; a tool answers pointer events for one
 * interaction mode. That is the whole contract, and it is small on purpose: the argument
 * for building this viewer was that it stays small enough to specify completely
 * (`docs/adr/BUILD_VS_ADOPT.md`), and a plugin framework would spend that budget on itself.
 *
 * STATIC, AND FOR THE SAME REASON THE PYTHON SIDE IS
 * ----------------------------------------------------
 * `MOS-REL-108` forbids "an in-process plugin API -- no shared-library loading, no dynamic
 * module import, no user-supplied code executed inside a platform process", and
 * `medos/services/catalogue.py` is how this repository already answers that: one ordinary
 * top-level import per shipped provider, a dictionary lookup, and an unknown key refused by
 * listing the known ones.
 *
 * WHETHER MOS-REL-108 REACHES A STATIC PAGE SERVED READ-ONLY BY NGINX IS ARGUABLE -- the
 * clause is about a PLATFORM PROCESS, and this is a browser tab. The position taken here is
 * that it should be honoured anyway, and not out of caution: the property the clause buys
 * is that a reviewer can read the complete set of executable contributions with `grep
 * import`, and that property is worth exactly as much in a clinician-facing surface as in a
 * worker. So `register()` takes an object a module already imported. There is no URL
 * loader, no `import()` over a configuration string, and no manifest fetch.
 *
 * Spec: MOS-REL-108, MOS-CONF-109, MOS-UI-009a (MOS-UI-009 withdrawn at specification
 * 0.3.0; what this surface is now held to is
 * forbidden to render pixels, and every seam added here deepens what a withdrawal covers).
 * ===================================================================================== */

/** The contribution kinds this viewer knows. Closed, like `MOS-UI-005`'s surface set. */
export const KINDS = Object.freeze({
  // A PANEL DECLARES `slot` (which rail), `title` (its heading) and `order` (where
  // among its neighbours). The shell builds the section when the markup has none, so
  // adding a panel is a registration and not an edit to index.html.
  PANEL: 'panel',        // a side-panel that renders MedicalOS data
  TOOL: 'tool',          // an interaction mode over a viewport
  OVERLAY: 'overlay',    // something drawn on top of the image
});

const registries = new Map(Object.values(KINDS).map((k) => [k, new Map()]));

/**
 * Register one contribution.
 *
 * @param {{id:string, kind:string, title?:string, order?:number}} contribution
 *
 * Refuses a duplicate id rather than overwriting. Two panels answering to one id is a
 * configuration whose behaviour depends on import order, and the symptom -- one panel
 * silently missing -- looks like a rendering bug rather than a registration one.
 */
export function register(contribution) {
  const { id, kind } = contribution || {};
  if (!id || typeof id !== 'string') throw new Error('a contribution needs a string id');
  const bucket = registries.get(kind);
  if (!bucket) {
    throw new Error(
      `${kind} is not a contribution kind. Known: ${Object.values(KINDS).join(', ')}. `
      + 'Adding a kind is an edit to registry.js, which is a review.',
    );
  }
  if (bucket.has(id)) {
    throw new Error(
      `a ${kind} with id ${id} is already registered. Two contributions on one id resolve `
      + 'by import order, and the loser is invisible.',
    );
  }
  bucket.set(id, Object.freeze({ order: 100, ...contribution }));
  return contribution;
}

/** Everything of one kind, in declared order then id -- deterministic, never insertion. */
export function contributions(kind) {
  const bucket = registries.get(kind);
  if (!bucket) throw new Error(`${kind} is not a contribution kind`);
  return [...bucket.values()].sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id));
}

export function contribution(kind, id) {
  return registries.get(kind)?.get(id) || null;
}

/** For a test, and for `medos doctor`'s eventual "what does this surface contribute". */
export function describe() {
  const out = {};
  for (const [kind, bucket] of registries) {
    out[kind] = [...bucket.keys()].sort();
  }
  return out;
}

/** Test-only. Production never unregisters: the set is fixed when the page loaded. */
export function _reset() {
  for (const bucket of registries.values()) bucket.clear();
}
