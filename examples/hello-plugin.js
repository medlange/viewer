/* =====================================================================================
 * hello-plugin.js -- the smallest real manifest-loaded plugin. Copy it, rename the ids
 * to your own vendor prefix, and grow from there.
 *
 * TO LOAD IT, ADD ONE MANIFEST ENTRY to viewer-config.js (the host seam; nothing else
 * in the shell is edited):
 *
 *     window.VIEWER_CONFIG = {
 *       dicomWebRoot: '/dicomweb',
 *       plugins: [{ id: 'acme.hello', src: './examples/hello-plugin.js', api: '^1.0.0' }],
 *     };
 *
 * `id` names the plugin in the console summary and refusal notices; `src` is the URL the
 * loader dynamic-imports, relative to the viewer root or absolute; `api` is optional and
 * names the plugin-API major this was written against (see docs/api.md). On a version
 * mismatch the plugin is refused BEFORE setup runs, with a named console error and a
 * notice; one plugin's failure never stops the others.
 *
 * REGISTRATION GOES THROUGH THE SAME REGISTRY shipped modules use -- api.register IS
 * the register() imported below, and the import is kept so the example shows exactly
 * where contributions land. What the plugin CANNOT reach on its own, the setup argument
 * carries: the current study (api.context), the notice bar (api.notice), state
 * (api.state), and the configured DicomWebClient (api.dicomweb) -- with the page's own
 * Authorization header. A plugin runs with the reader's credentials: ship plugins you
 * trust. The full contract is docs/api.md; the developer guide is docs/extensions.md.
 * ===================================================================================== */

import { KINDS, register } from '../src/core/registry.js';

/**
 * @param {object} api the frozen plugin API -- see docs/api.md for every member.
 * @param {string} api.version the plugin API version this viewer implements.
 * @param {object} api.context { studyUID, series } -- the open study, live.
 * @param {(message: string, kind?: string) => void} api.notice the shell's notice bar.
 */
export function setup(api) {
  // AN ACTION: a verb on the study bar. The shell renders the button and hands the
  // click whatever context the action cannot reach by importing the shell -- here the
  // plugin asks api.context instead.
  register({
    id: 'acme.hello.study-uid',
    kind: KINDS.ACTION,
    title: 'Show study UID',
    order: 90,
    onClick() {
      const uid = api.context.studyUID;
      api.notice(uid ? `open study: ${uid}` : 'no study open', 'info');
    },
  });

  // AN OVERLAY: drawn after the annotation layer on every draw of every panel. This one
  // draws nothing -- it exists to pin the signature. `ctx.annotations` is the panel's
  // AnnotationLayer (an <svg> with pointer-events already 'none'); `ctx.state` is the
  // same read-only state seam the plugin API carries. An overlay that throws is logged
  // by id and skipped, so the picture below it survives.
  register({
    id: 'acme.hello.frame-mark',
    kind: KINDS.OVERLAY,
    title: 'Hello frame mark',
    order: 100,
    draw(/* ctx */) {
      // const { panel, annotations, state } = ctx;
      // const svg = annotations.svg;              // the layer to add marks to
    },
  });
}
