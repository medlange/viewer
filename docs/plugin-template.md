# Plugin template: a panel you can show a reviewer without shame

`getting-started.md` ends at a minimal panel. This template is its production
form: the same registration, but with the discipline the suite requires of
shipped code. Every rule in a comment names the gate that checks it.

The code in the blocks below is not an illustration: `viewer/tests/test_plugin_template.py`
extracts these blocks and runs the same checks on them that the suite runs on
shipped panels. The guide cannot rot without noticing it.

## The plugin file

```js
// SPDX-License-Identifier: Apache-2.0
/* acme.dose-notes — protocol notes in the right rail.
 *
 * PLUGIN TEMPLATE (V3): copy it, change id/render, keep the shape. All
 * integration is register() plus one import line in app.js; the shell builds
 * the section.
 */
import { KINDS, register } from '../core/registry.js';
import { get, subscribeTo } from '../core/state.js';
import { t, onLanguageChange } from '../core/i18n.js';

/** One escape helper for the whole plugin. Archive strings are someone else's bytes. */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function render(root) {
  const { series } = get();
  if (!series || !series.length) {
    // Empty state is still a state. The section must not look broken.
    root.innerHTML = `<p class="muted">${esc(t('dose.none', 'No study open.'))}</p>`;
    return;
  }
  const notes = series.length;
  root.innerHTML = `<p class="muted">${esc(
    t('dose.summary', '{n} series in this study').replace('{n}', String(notes)),
  )}</p>`;
}

export default register({
  id: 'acme.dose-notes',
  kind: KINDS.PANEL,
  title: 'Dose notes',
  order: 40,
  slot: 'right',
  mount(root) {
    render(root);
    const stop = subscribeTo(['series'], () => render(root));
    // A language change is not a state change — listen for it separately, or
    // labels freeze.
    const stopLang = onLanguageChange(() => render(root));
    // TEARDOWN IS MANDATORY: mount is called again on remount, and without
    // returning a teardown the panel draws twice per state change.
    return () => { stop(); stopLang(); };
  },
});
```

## Strings the plugin adds

1. `app.js`: `import './src/ui/dose-notes.js';` — next to the other panel imports.
2. `i18n/*.json` (13 files): the heading and label keys:

```json
{
  "panel.acme.dose-notes": "Dose notes",
  "dose.none": "No study open.",
  "dose.summary": "{n} series in this study"
}
```

3. `viewer/tests/test_dose_notes.py` — the gate test (see testing.md); without
   it the suite walks past the plugin, and the rule "contribution = module +
   registration + test" stays unproven.

## What the plugin gets for free

- A rail section with its heading from `panel.<id>` and layout by `order`.
- Remounting and clean teardown (the shell holds `mountedPanels`).
- The ability for deployment to disable it: `viewer.config.json` → `panels.disabled`
  (V2) — no code edits in the plugin.
- Moving between rails by the reader (rails.js) — the section moves, the plugin
  never knows.

## What the plugin cannot do

- Import `app.js` or anything from `src/ui/*` into `src/core/*` — the
  no-shell-import rule, gate `test_architecture.py` fails both ways.
- Go to the network directly: the panel reads the state the shell fills. Its own
  requests go through the plugin API (`api.dicomweb` — the same configured client,
  with the host's Authorization): see [extensions.md](extensions.md) and
  [api.md](api.md) — the seam that used to be "a separate solution" exists.
- Write to the DOM outside its own `root`: the shell owns the layout.
