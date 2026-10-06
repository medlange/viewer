/* =====================================================================================
 * core/plugins.js -- the manifest loader: the ONE place host-supplied code arrives
 * dynamically. Everything a plugin may touch is handed to it through buildPluginApi();
 * the registry itself stays pure and static (see registry.js's header for why that
 * property is worth keeping).
 *
 * WHY DYNAMIC LOADING LIVES HERE AND NOT IN registry.js
 * ------------------------------------------------------
 * The registry's documented position (`MOS-REL-108`, argued out in registry.js's own
 * header) is that the clause buys a reviewer one property: the complete set of
 * executable contributions is readable with `grep import`. Shipped modules keep that
 * property -- one top-level import per module, registration as a side effect, and
 * `viewer/tests/test_architecture.py` fails any registering module the shell does not
 * import. Host plugins are the deliberate exception: a deployment must be able to add a
 * contribution WITHOUT editing the shell, which a static registry cannot express. So
 * there is exactly one dynamic-import site in the tree, and it is this file, named in
 * docs/extensions.md: a reviewer auditing "what code can this surface run" reads
 * `viewer-config.js`'s manifest and this loader. `viewer/tests/test_plugins.py` gates
 * that no second dynamic import appears anywhere under src/.
 *
 * WHAT A PLUGIN IS
 * -----------------
 * An ES module named by the host's manifest -- `viewer-config.js`,
 * `plugins: [{ id, src, api? }]` -- exporting `setup` (named or default). `setup`
 * receives ONE argument, the frozen public API, and registers its contributions through
 * it. A plugin runs WITH THE PAGE'S OWN CREDENTIALS: the API hands it the configured
 * DicomWebClient, whose Authorization header is whatever the host's authHeaderProvider
 * (or authToken) says. That is the point of the seam -- a plugin CAN reach the archive
 * -- and the reason hosts ship only plugins they trust.
 *
 * FAILURE ISOLATION
 * ------------------
 * One plugin's failure -- a dead URL, a syntax error, a thrown setup(), an API major the
 * viewer refuses -- never aborts the rest. Every outcome lands in a `{id, ok, error?}`
 * record; refusals and failures are named on the console (version refusals also notice
 * the reader, because a version skew is a deployment fact a host must see), and one
 * summary line closes the batch. The viewer boots and reads studies with zero plugins
 * loaded.
 *
 * VERSION COMPATIBILITY
 * ----------------------
 * `PLUGIN_API_VERSION` is semver; only MAJOR is load-bearing. A manifest entry's `api`
 * (or the module's own `PLUGIN_API`) names the major the plugin was written against;
 * a different major is refused BEFORE setup runs. The contract a major covers is
 * documented in docs/api.md.
 *
 * Spec: MOS-REL-108 (the designated loader; the registry stays pure), MOS-UI-009a.
 * ===================================================================================== */

import { KINDS } from './registry.js';

/** The plugin API contract this build implements. MAJOR is the only compatibility
 *  digit: plugins name the major they were written against, and a mismatch refuses
 *  the plugin before its setup runs. */
export const PLUGIN_API_VERSION = '1.0.0';

const LOG_PREFIX = '[medlange-viewer]';

/** The major of a semver-ish requirement ('^1.0.0', '1.x', '1.2.3'), or null when the
 *  string names no leading version number and cannot be reasoned about. */
function majorOf(version) {
  const match = /^[^\d]*(\d+)/.exec(String(version ?? '').trim());
  return match ? Number(match[1]) : null;
}

/**
 * Load every plugin named by `config.plugins` and run its setup.
 *
 * @param {object} o
 * @param {object} o.config  `window.VIEWER_CONFIG` -- the host's manifest lives beside
 *                 its other integration settings, so one file replaces the whole seam.
 * @param {DicomWebClient} o.client  the configured client; becomes `api.dicomweb`.
 * @param {(c: object) => object} o.registerContribution  the registry's `register`.
 * @param {{get, subscribe, subscribeTo}} o.state  the read-only state seam.
 * @param {(message: string, kind?: string) => void} o.notice  the shell's notice bar.
 * @returns {Promise<Array<{id: string, ok: boolean, error?: string}>>} one record per
 *          manifest entry, in manifest order.
 */
export async function loadPlugins({ config, client, registerContribution, state, notice }) {
  const manifest = Array.isArray(config && config.plugins) ? config.plugins : [];
  if (!manifest.length) return [];

  const results = [];
  for (const entry of manifest) {
    const id = entry && typeof entry.id === 'string' ? entry.id : null;
    const src = entry && typeof entry.src === 'string' ? entry.src : null;
    if (!id || !src) {
      const error = 'manifest entry needs a string id and src';
      console.error(`${LOG_PREFIX} plugin ${id || '(unnamed)'}: ${error}`);
      results.push({ id: id || '(unnamed)', ok: false, error });
      continue;
    }

    let module;
    try {
      module = await import(src);
    } catch (err) {
      const error = `import failed: ${err && err.message ? err.message : err}`;
      console.error(`${LOG_PREFIX} plugin ${id}: ${error}`);
      results.push({ id, ok: false, error });
      continue;
    }

    // COMPATIBILITY, CHECKED BEFORE setup RUNS. A module written against a different
    // major would register contributions against contracts this build does not
    // implement, so the refusal names both versions and the reader is told -- a
    // version skew is a deployment fact, not a code accident.
    const required = entry.api ?? module.PLUGIN_API;
    if (required != null) {
      const wanted = majorOf(required);
      const have = majorOf(PLUGIN_API_VERSION);
      if (wanted === null) {
        const error = `unreadable api requirement ${JSON.stringify(required)}`;
        console.error(`${LOG_PREFIX} plugin ${id}: ${error}`);
        notice(`plugin ${id} refused: ${error}`, 'err');
        results.push({ id, ok: false, error });
        continue;
      }
      if (wanted !== have) {
        const error = `needs api major ${wanted}, this viewer implements ${have}`;
        console.error(`${LOG_PREFIX} plugin ${id}: ${error}`);
        notice(`plugin ${id} refused: ${error}`, 'err');
        results.push({ id, ok: false, error });
        continue;
      }
    }

    const setup = typeof module.setup === 'function' ? module.setup
      : module.default && typeof module.default.setup === 'function' ? module.default.setup
        : typeof module.default === 'function' ? module.default : null;
    if (!setup) {
      const error = 'module exports no setup (named or default)';
      console.error(`${LOG_PREFIX} plugin ${id}: ${error}`);
      results.push({ id, ok: false, error });
      continue;
    }

    try {
      setup(buildPluginApi({ registerContribution, client, state, notice }));
      results.push({ id, ok: true });
    } catch (err) {
      const error = `setup threw: ${err && err.message ? err.message : err}`;
      console.error(`${LOG_PREFIX} plugin ${id}: ${error}`);
      results.push({ id, ok: false, error });
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `${LOG_PREFIX} plugins: ${results.length - failed.length} loaded, ${failed.length} failed`,
    failed.length ? failed.map((f) => `${f.id} (${f.error})`) : '',
  );
  return results;
}

/**
 * The frozen public API handed to every plugin's setup. One argument, no shell imports:
 * what a plugin cannot reach without the shell, the API carries.
 */
function buildPluginApi({ registerContribution, client, state, notice }) {
  return Object.freeze({
    version: PLUGIN_API_VERSION,
    register: (contribution) => registerContribution(contribution),
    KINDS,
    state: Object.freeze({
      get: state.get,
      subscribe: state.subscribe,
      subscribeTo: state.subscribeTo,
    }),
    dicomweb: client,
    context: Object.freeze({
      get studyUID() { return state.get().studyUID; },
      get series() { return state.get().series; },
    }),
    notice,
  });
}
