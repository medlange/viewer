# Extending the Medlange Viewer

The viewer is a framework: features arrive as **contributions**, not edits to the
shell. A contribution is a plain object registered in a module of its own; the shell
renders it, hands it the context it cannot reach without importing the shell, and the
architecture tests hold both sides to the contract. This file is the whole developer
guide — each kind takes about thirty lines to learn.

```
viewer/
  src/core/registry.js    # register({...}), contributions(kind) — the one seam
  src/ui/ai-action.js     # the worked example of an ACTION (read it first)
  src/ui/ai-dialog.js     # what the example opens
  app.js                  # the shell: renders contributions, owns the study
```

## The rules every contribution follows

1. **A module never imports the shell** (`app.js`). The architecture gate fails any
   `src/ui/*` module that does. The shell passes what you need through the
   contribution's callbacks.
2. **Register at import time; the shell imports your module.** Adding a feature is a
   new file plus one `import './src/ui/your-thing.js';` line in `app.js`.
3. **Every reader-facing string goes through `t(key, 'English')`** and exists in every
   file under `i18n/`. The parity gate fails a missing key in any locale.
4. **No dynamic loading.** Registration is a static import. There is no URL loader and
   no `import()` over configuration (the same `MOS-REL-108` property the platform
   keeps: a reviewer can read the complete set of executable contributions with
   `grep import`).

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

`register({ id, kind: KINDS.PANEL, slot: 'left' | 'right', title, order, render })`.
The shell builds the section (no `index.html` edit), moves it between rails when the
reader drags it, and your `render(hostElement)` draws into the host. Study the
segments panel (`src/ui/segments-panel.js`) — it subscribes to state through
`src/core/state.js` and re-renders on change, which is the whole pattern.

## TOOL — an interaction over pixels

`register({ id, kind: KINDS.TOOL, title, key, icon, activate, onPointer })`. A tool
arms one interaction mode (caliper, ROI); `activate(api)` receives the viewport API.
Study `src/tools/measure-tools.js`.

## Testing your contribution

`viewer/tests/` are Python tests that read the source the way a reviewer does — the
architectural gates (shell imports, i18n parity, state wiring) run over your module
automatically. Add a `test_your_thing.py` for your feature's own contract, the way
`test_ai_action.py` pins the analyze dialog's request shape.
