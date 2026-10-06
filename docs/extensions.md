# Extending the Medlange Viewer

The viewer is a framework: features arrive as **contributions**, not edits to the
shell. A contribution is a plain object registered in a module of its own; the shell
renders it and hands it the context it cannot reach without importing the shell, and
the architecture tests hold both sides to the contract. This file is the whole
developer guide — each kind takes about thirty lines to learn.

There are two ways to get a contribution registered:

1. **A module the shell imports** — for contributions shipped inside this tree. One
   top-level import in `app.js` beside the others; the gate
   `test_every_registered_contribution_module_is_imported_by_the_shell` fails a module
   that registers but is never imported.
2. **A plugin named in the host's manifest** — for contributions a deployment adds
   WITHOUT editing the shell. `viewer-config.js` names the module URLs and the shell
   dynamic-imports them at boot through `src/core/plugins.js`, the tree's one
   designated loader. See **Plugins without editing the shell** below.

```
viewer/
  src/core/registry.js      # register({...}), contributions(kind) — the one seam
  src/core/plugins.js       # the manifest loader (plugins only)
  src/ui/ai-action.js       # the worked example of an ACTION (read it first)
  src/ui/ai-dialog.js       # what the example opens
  src/tools/measure-tools.js# the worked examples of TOOLs
  src/ui/study-panel.js     # the worked example of a PANEL
  examples/hello-plugin.js  # the worked example of a manifest plugin
  app.js                    # the shell: renders contributions, owns the study
```

## The rules every contribution follows

1. **A module never imports the shell** (`app.js`). The architecture gate fails any
   `src/ui/*` module that does. The shell passes what you need through the
   contribution's callbacks — a plugin receives the same things through its setup
   argument.
2. **Register at import or setup time; never edit the shell to register.** A shipped
   module registers when the shell imports it; a plugin registers inside
   `setup(api)`.
3. **Every reader-facing string goes through `t(key, 'English')`** and exists in every
   file under `i18n/`. The parity gate fails a missing key in any locale. The one
   plain-string surface is `notice()`, the status bar — every shipped notice is a
   plain English sentence, not a translation key.
4. **Dynamic loading happens in exactly one place.** `src/core/plugins.js` is the only
   module under `src/` that dynamic-imports (`viewer/tests/test_plugins.py` gates
   that, file by file). The registry stays pure and static: `MOS-REL-108`'s property
   is that a reviewer can read the complete set of executable contributions from the
   shell's import list PLUS the host's manifest — nothing executes that is not one of
   those two.

## ACTION — a verb on the study bar

For operations on the study, not on pixels. The shell renders each registered ACTION
as a button and calls `onClick(ctx)` with `ctx = { studyUid, reloadStudy }`.

```js
// src/ui/report-action.js
import { KINDS, register } from '../core/registry.js';
import { t } from '../core/i18n.js';
import { openDialog } from './dialogs.js';

export default register({
  id: 'report',
  kind: KINDS.ACTION,
  order: 20,                    // where among the verbs; lower is lefter
  title: t('report.action', 'Report'),
  icon: null,                   // no glyph yet: the button renders the title text
  onClick({ studyUid }) {
    if (!studyUid) return;
    openDialog({
      title: t('report.title', 'Report this study'),
      body: `<p>${t('report.body', 'Study')}: <code>${studyUid}</code></p>`,
    });
  },
});
```

Then one line in `app.js`, beside the other UI imports:
`import './src/ui/report-action.js';  // registers the Report verb`

That is a complete feature: button, dialog, two locales' worth of strings to add,
zero edits to the shell beyond the import.

## PANEL — a side-panel

`register({ id, kind: KINDS.PANEL, slot: 'left' | 'right', title, order, mount })`.
The shell builds the section (no `index.html` edit), moves it between rails when the
reader drags it, and calls `mount(host)` with the section's body element. `mount`
renders into the host and **returns its teardown** — the shell calls the teardown
before any remount, so a panel that subscribes and never unsubscribes renders twice
per state change.

```js
export default register({
  id: 'acme.dose-notes',
  kind: KINDS.PANEL,
  slot: 'right',
  title: 'Dose notes',
  order: 40,
  mount(host) {
    render(host);                                   // draw once, immediately
    const stop = subscribeTo(['series'], () => render(host));
    // A language change is not a state change: labels translate, so listen for it.
    const stopLang = onLanguageChange(() => render(host));
    return () => { stop(); stopLang(); };           // the teardown the shell calls
  },
});
```

The shipped study panel (`src/ui/study-panel.js`) is the reference. A panel reads
`core/state.js`; the shell never renders into a panel's host —
`test_the_shell_does_not_render_into_a_panel_slot` fails either direction.

## TOOL — an interaction over pixels

`register({ id, kind: KINDS.TOOL, title, key, icon, order, handlers })`. A tool is
NOT a mode the viewer sits in: selecting one arms it for ONE measurement, and the
surface returns to navigation by itself. While armed, the shell calls

```js
handlers(panel, location, commit, setPreview) → { onDown, onMove, onUp, onCancel }
```

and installs the returned handlers. `location` is a live address
(`{ plane, index, seriesUID, studyUID, planeName }`, read at call time — the reader
can scroll between arming and committing); `commit(measurement)` files the finished
measurement; `setPreview(shape)` draws the in-progress shape, and `setPreview(null)`
clears it. `onDown` returns `false` to leave the gesture to the default bindings —
middle and right drag stay pan and zoom while a tool is armed. `onCancel` disarms
without measuring (Escape). The shipped tools (`src/tools/measure-tools.js`) are the
reference implementation.

## OVERLAY — something drawn on top of the image

`register({ id, kind: KINDS.OVERLAY, title?, order?, draw })`. The shell calls

```js
draw({ panel, annotations, state })
```

after the annotation layer, on every draw of every panel — the two sites are `draw`
and `drawOverlays` in `app.js`, and they are this kind's only consumer.
`annotations` is the panel's `AnnotationLayer` (an `<svg>` with `pointer-events`
already `'none'`); `state` is the read-only state seam (same shape as the plugin
API's). An overlay that throws is logged by id and skipped: decoration must never
take the picture down with it. `examples/hello-plugin.js` carries a do-nothing
example that pins the signature.

## Plugins without editing the shell

A deployment adds a contribution by naming a module in `viewer-config.js` — the same
file a host already replaces to point the viewer at an origin. No file in the tree is
edited, which is what makes an update to a newer viewer a file swap instead of a merge
through 5,000 lines of shell:

```js
window.VIEWER_CONFIG = {
  dicomWebRoot: '/dicomweb',
  plugins: [
    { id: 'acme.hello', src: './examples/hello-plugin.js', api: '^1.0.0' },
  ],
};
```

- `id` (string, required) — names the plugin in the console summary and in refusal
  notices.
- `src` (string, required) — the URL the loader dynamic-imports, relative to the
  viewer root or absolute.
- `api` (string, optional) — the plugin-API major the plugin was written against
  (`'^1.0.0'`, `'1.x'`). Absent, any major is accepted.

The plugin module exports `setup` (named or default). `setup` receives ONE argument,
the frozen public API — every member, one line each (the full reference is
[api.md](api.md)):

| member | what it is |
|---|---|
| `version` | the plugin API version this viewer implements (`1.0.0`). |
| `register(contribution)` | the registry's `register()` — the four kinds above. |
| `KINDS` | the contribution kinds: `PANEL`, `TOOL`, `OVERLAY`, `ACTION`. |
| `state.get()` | the frozen state object (keys in [api.md](api.md#state)). |
| `state.subscribe(fn)` | every change; returns the unsubscribe. |
| `state.subscribeTo(keys, fn)` | changes touching one of `keys`. |
| `dicomweb` | the configured `DicomWebClient` — `studies`, `series`, `instancesOf`, `retrieveInstance`, `retrieveSeries`. |
| `context.studyUID` | the open study's UID, or null. |
| `context.series` | the open study's series rows, as state holds them. |
| `notice(message, kind?)` | the status bar; `kind` is `'warn'` (default) or `'info'`. |

**Version compatibility.** `api` (or the module's own `PLUGIN_API` export) names a
MAJOR. A different MAJOR from the viewer's `PLUGIN_API_VERSION` refuses the plugin
BEFORE `setup` runs — a named console error plus a reader-visible notice — and the
other plugins keep loading.

**Failure isolation.** One plugin's failure — a dead URL, a syntax error, a thrown
`setup`, a version refusal — never aborts the rest. Every outcome lands in a
`{id, ok, error?}` record and one summary line closes the batch:
`[medlange-viewer] plugins: N loaded, M failed`. The viewer boots and reads studies
with zero plugins loaded.

**Boot order.** The manifest loads fire-and-forget: a dead plugin URL must not stand
between the reader and the worklist, so the shell does not wait. Consequences, in
order of visibility: an OVERLAY draws from the next render; TOOL/ACTION buttons
appear at the next toolbar rebuild (for example a language change); a plugin PANEL
mounts the next time the shell mounts panels. A contribution that must be on screen at
first paint ships as a module the shell imports — the path every shipped contribution
takes.

**Plugins run with the page's credentials.** `dicomweb` is the client's own
instance: the host's `authHeaderProvider` (or `authToken`) flows into it, so a plugin
CAN reach the archive. That is the point of the seam — and the reason a deployment
ships only plugins it trusts. There is no sandbox and no narrower scope.

## Testing your contribution

`viewer/tests/` are Python tests that read the source the way a reviewer does — the
architectural gates (shell imports, i18n parity, state wiring) run over your module
automatically, and `test_plugins.py` pins the loader's contract and the shell's
wiring. Add a test module for your feature's own contract, the way the analyze
dialog's test pins its request shape.
