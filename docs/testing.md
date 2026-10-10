# Viewer tests: how the suite is built and how to write your own

The suite — `viewer/tests/`, 244 tests, ~2 seconds, no node and no build. The
tests are written in Python and read the sources the same way a reviewer does:
line by line, with regexes and the AST. That is a deliberate choice over a JS
runner — see the last section.

## Running

```bash
cd viewer && python -m pytest tests           # everything, from the viewer's home directory
python -m pytest viewer/tests/test_upload.py -q   # one file — from the repository root
```

It also works from the repository root (`testpaths` includes `viewer/tests`),
but the viewer's owner lives in `viewer/`.

## The five rules the suite holds for everyone

1. **Not a single shell import from modules.** `src/ui/*` and `src/core/*` never
   import `app.js`. The test — `test_architecture.py::test_every_registered_contribution_module_
   is_imported_by_the_shell` and its neighbors. Your panel gets everything through
   `register()`.
2. **Every UI string — in every locale.** A new key in one `i18n/*.json` fails
   in `test_every_language_answers_every_key_the_others_do`. Thirteen files, one
   pass — the tables never drift apart.
3. **Translation never touches a measured value.** DICOM values and safety
   strings never go through `t()` — `test_translation_never_reaches_a_measured_value_or_the_
   safety_statement`.
4. **A contribution does not exist until something imports it.** Registered a
   module — add the import to `app.js`; the gate compares the registry with the
   imports.
5. **Failure is a sentence, not silence.** A button that silently does nothing
   teaches the reader not to press buttons. Every failure renders as a platform
   sentence (see `ai-dialog.js`, `upload.js`).

## A test skeleton for your contribution

```python
# viewer/tests/test_dose_notes.py
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PANEL = (ROOT / "src" / "ui" / "dose-notes.js").read_text(encoding="utf-8")


def test_the_panel_registers_and_cleans_up() -> None:
    assert "KINDS.PANEL" in PANEL
    assert "register({" in PANEL
    assert "mount(root)" in PANEL
    assert "return () => { stop(); stopLang(); };" in PANEL, (
        "mount must return its teardown: a remount without it draws twice per change"
    )


def test_the_panel_never_reaches_the_shell() -> None:
    assert "from '../app.js'" not in PANEL
    assert "from '../../app.js'" not in PANEL
```

Next — checks of your panel's meaning: which state keys it reads, which strings
it renders, what it shows in the empty state.

## Why not JS tests

The viewer has no build step and no node dependency — the suite must not
introduce one. String gates are cheap, stable, and read like the reviewer reads;
behavioral logic (rendering, DICOM parsing) is covered by platform integration
tests and live runs (see ROADMAP, G-U3/G-U4: every feature was closed with a
browser check). When the first seam appears that requires executing JS (dynamic
plugins) — that is when a JS runner appears, as a separate solution.

## A real-life example

`upload.js` (U4) arrived together with `test_upload.py`: eight gates prod the
multipart STOW-RS form (hand-assembled, not FormData), the `{root}/studies`
target, the FailedSOPSequence display, drag-drop with a mandatory `preventDefault`,
the seam with the shell, and the presence of strings in all 13 locales. Reading
this test, you read the feature's contract.
