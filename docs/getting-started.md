# A panel in 30 lines

This is a step-by-step guide: from an empty file to a mounted panel in the right
rail, without a single core edit — except for one import line (that is the
extension point). Verify every step with the command from step 6.

## Step 1 — the panel file

Create `src/ui/series-inventory-panel.js`:

```js
// Series counter by modality for the open study.
import { KINDS, register } from '../core/registry.js';
import { get, subscribeTo } from '../core/state.js';
import { t, onLanguageChange } from '../core/i18n.js';

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function render(root) {
  const { series } = get();
  if (!series || !series.length) {
    root.innerHTML = `<p class="muted">${esc(t('inv.none', 'No study open.'))}</p>`;
    return;
  }
  const byModality = {};
  for (const row of series) {
    const m = (row['00080060'] && row['00080060'].Value[0]) || '?';
    byModality[m] = (byModality[m] || 0) + 1;
  }
  root.innerHTML = '<ul class="muted">' + Object.entries(byModality)
    .map(([m, n]) => `<li>${esc(m)} — ${n}</li>`).join('') + '</ul>';
}

export default register({
  id: 'acme.series-inventory',
  kind: KINDS.PANEL,
  title: 'Series inventory',
  order: 40,
  slot: 'right',
  mount(root) {
    render(root);
    const stop = subscribeTo(['series'], () => render(root));
    const stopLang = onLanguageChange(() => render(root));
    return () => { stop(); stopLang(); };
  },
});
```

30 lines of code. What matters here:

- `register()` is the whole integration. The shell builds the rail section itself
  (`slot`, `order`) and takes the heading from the i18n key `panel.<id>`.
- `mount(root)` receives an element and returns an unsubscribe function. The shell
  calls it on remount — a subscription leak looks like flicker, and the gate
  catches it.
- The panel reads only `core/state`. No imports of `app.js` — the architecture
  gate forbids them (`test_architecture.py` fails on such an import).
- `esc()` before every `innerHTML`. Archive strings are someone else's bytes.
- Translatable labels go through `t()` with an English literal fallback; archive
  values (names, UIDs) are NOT translated — see step 4.

## Step 2 — one line in the shell

In `app.js`, next to the other panel imports:

```js
import './src/ui/series-inventory-panel.js'; // registers the panel
```

An import for the registration side effect — that is how all built-in panels are
wired.

## Step 3 — strings in the locale

The section heading comes from the key `panel.acme.series-inventory`. Add it to
all `i18n/*.json` files (13 languages; there is no English file — English is the
literals in the code):

```json
"panel.acme.series-inventory": "Series"
```

The gate `test_every_language_answers_every_key_the_others_do` fails if the key
is missing from any file — that is a feature: the tables never drift apart.

## Step 4 — the translation rule in one line

Translate the labels you write (`t('inv.none', ...)`). Do not translate values
from DICOM: the patient name in the viewer must match the name in the PACS byte
for byte. The gate `test_translation_never_reaches_a_measured_value_or_the_safety_statement`
watches that boundary from the other side.

## Step 5 — look at it

```bash
docker compose -f medos/deploy/compose/docker-compose.yml up -d web
# open http://localhost:3000/mos-viewer/ and open a study
```

The panel sits in the right rail below "Measurements" (`order: 40` after the
built-in 10/20/30). Deployment can disable it without code edits:
`viewer.config.json` → `"panels": {"disabled": ["acme.series-inventory"]}` (V2).

## Step 6 — the gate test

Copy `viewer/tests/test_plugin_template.py` as a model and add your own checks,
then:

```bash
cd viewer && python -m pytest tests
```

The whole suite — 244 tests, ~2 seconds, no node needed: the tests read the
sources the same way a reviewer does. Rules your code already obeys if you
followed the guide: not a single import of the shell from `src/ui/*`, `mount`
returns its teardown, every UI string — in every locale. Next —
[plugin-template.md](plugin-template.md) (the production form of the panel) and
[testing.md](testing.md) (how to write tests).
