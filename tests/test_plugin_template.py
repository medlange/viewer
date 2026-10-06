# SPDX-License-Identifier: Apache-2.0
"""The V3 guides are code, and the suite treats them as code.

`docs/getting-started.md` and `docs/plugin-template.md` carry complete, copy-paste
panels inside their fenced blocks. A guide that rots teaches the wrong thing with
authority, so this module extracts those blocks and applies the same gates the
suite applies to shipped panels: the registration contract, the teardown, the
escaping discipline, the no-shell-import rule. If a guide edit breaks the contract
a reader would hit, THIS test is where it surfaces — not in the reader's editor.

Spec: roadmap V3.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"


def _blocks(doc: str, language: str) -> list[str]:
    text = (DOCS / doc).read_text(encoding="utf-8")
    return re.findall(rf"```{language}\n(.*?)```", text, re.DOTALL)


def _js(doc: str) -> str:
    blocks = _blocks(doc, "js")
    assert blocks, f"{doc} carries no js block; the guide is prose without proof"
    return "\n".join(blocks)


def _the_panel_contract_holds(code: str, where: str) -> None:
    assert "import { KINDS, register } from '../core/registry.js'" in code, (
        f"{where}: panels register through core/registry and nothing else"
    )
    assert "import { get, subscribeTo } from '../core/state.js'" in code
    assert "register({" in code and "kind: KINDS.PANEL" in code
    assert re.search(r"id: 'acme\.[\w-]+'", code), (
        f"{where}: the template's id carries a vendor prefix — a reader's first "
        "contribution must not collide with platform namespaces"
    )
    assert "mount(root)" in code, f"{where}: mount is the seam the shell calls"
    assert re.search(r"return \(\) => \{ stop\(\); stopLang\(\); \};", code), (
        f"{where}: mount must return its teardown — a remount without it renders "
        "twice per state change"
    )
    assert "onLanguageChange" in code, (
        f"{where}: a language change is not a state change; labels translate, so "
        "the panel listens for it separately"
    )
    assert "esc(" in code and "innerHTML" in code, (
        f"{where}: every archive string passes through the escape helper before "
        "innerHTML"
    )
    assert "t('" in code, f"{where}: UI strings go through t() with a fallback"
    for forbidden in ("from '../app.js'", "from '../../app.js'", "import app"):
        assert forbidden not in code, f"{where}: {forbidden} — panels never import the shell"


def test_the_getting_started_panel_satisfies_the_contract() -> None:
    _the_panel_contract_holds(_js("getting-started.md"), "getting-started.md")


def test_the_plugin_template_satisfies_the_contract() -> None:
    _the_panel_contract_holds(_js("plugin-template.md"), "plugin-template.md")


def test_the_plugin_template_carries_its_locale_shape() -> None:
    blocks = _blocks("plugin-template.md", "json")
    assert blocks, "plugin-template.md must show the exact locale keys a reader adds"
    data = json.loads(blocks[0])
    assert "panel.acme.dose-notes" in data, (
        "the rail heading comes from panel.<id>; without this key the section "
        "renders its id as the title"
    )
    assert any(k.startswith("dose.") for k in data), (
        "the panel's own strings must be translated too — one missing key in one "
        "locale fails the whole-suite language gate"
    )


def test_the_guides_name_the_rules_a_reader_must_not_relearn() -> None:
    started = (DOCS / "getting-started.md").read_text(encoding="utf-8")
    template = (DOCS / "plugin-template.md").read_text(encoding="utf-8")
    testing = (DOCS / "testing.md").read_text(encoding="utf-8")
    assert "viewer.config.json" in started, (
        "a new panel is disableable by deployment config (V2) — the guide must say "
        "so or readers fork the core to hide a panel"
    )
    assert '"panels"' in started and '"disabled"' in started, (
        "the guide must name the exact viewer.config.json shape that hides the panel"
    )
    for doc, name in ((template, "plugin-template.md"), (testing, "testing.md")):
        names_the_rule = (
            "test_architecture.py" in doc
            or "no-shell-import" in doc
            or "импорта оболочки" in doc
        )
        assert names_the_rule, (
            f"{name} must name the no-shell-import rule — a reader who learns it "
            "from a failing suite learns it late"
        )
    assert "test_plugin_template.py" in testing or "test_plugin_template" in template, (
        "the guides cross-reference each other and the dogfood test that guards them"
    )
