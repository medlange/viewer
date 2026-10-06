# SPDX-License-Identifier: Apache-2.0
"""The manifest loader: the tree's one dynamic-import site, and the shell's wiring.

WHY A SEPARATE FILE AND NOT PART OF test_architecture
-------------------------------------------------------
The architecture gates pin the STATIC seam: the registry cannot load anything
dynamically (`test_the_registry_cannot_load_a_contribution_dynamically`), and every
registering module under src/ must be imported by the shell
(`test_every_registered_contribution_module_is_imported_by_the_shell`). The plugin
loader is the deliberate exception to the first of those, and it exists so the second
stops being the only way in: a host adds a contribution by naming a URL in
`viewer-config.js`, without editing the shell. That exception is a contract of its
own -- exactly one dynamic-import site, wired exactly once, with the host's
credential handed to the client it already configured -- and a contract that small
deserves its own file the same way the analyze verb's has one.

WHAT IS PINNED HERE
--------------------
That src/core/plugins.js exists and declares PLUGIN_API_VERSION + loadPlugins; that
the version is semver; that no module under src/ dynamic-imports besides it; that
app.js imports it and calls loadPlugins exactly once; that the DicomWebClient the
plugins will share receives the host's authHeaderProvider; that OVERLAY is consumed
at both annotation draw sites under a per-overlay guard; and that the shipped example
is a manifest plugin (imports the registry, exports setup, is NOT imported by the
shell).

Spec: MOS-REL-108 (one designated loader; the registry stays pure), roadmap V3.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
PLUGINS = SRC / "core" / "plugins.js"
SHELL = (ROOT / "app.js").read_text(encoding="utf-8")


def _code(text: str) -> str:
    """Source with comments stripped, so prose about a forbidden thing is not a hit."""
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return "\n".join(
        line for line in text.splitlines() if not line.lstrip().startswith("//")
    )


def test_the_manifest_loader_exists_and_declares_its_contract() -> None:
    assert PLUGINS.is_file(), (
        "src/core/plugins.js is gone; there is no designated plugin loader and the "
        "manifest documented in docs/extensions.md has no implementation"
    )
    code = _code(PLUGINS.read_text(encoding="utf-8"))
    assert "export async function loadPlugins" in code, (
        "loadPlugins is not an async export; the shell's fire-and-forget boot wiring "
        "cannot await it"
    )
    version = re.search(r"PLUGIN_API_VERSION = '(\d+)\.(\d+)\.(\d+)'", code)
    assert version, (
        "PLUGIN_API_VERSION must be declared as a semver literal ('1.0.0') -- the "
        "compatibility rule in docs/extensions.md and the refusal logic both read it"
    )


def test_the_loader_is_the_only_dynamic_import_under_src() -> None:
    """MOS-REL-108's property, kept with the loader named instead of absent.

    The registry stays pure (the existing gate covers it); this gate covers the rest
    of the tree, so `core/plugins.js` remains the one place a reviewer must read to
    audit every dynamically arrived extension.
    """
    offenders = []
    saw_loader = False
    for path in sorted(SRC.rglob("*.js")):
        code = _code(path.read_text(encoding="utf-8"))
        if "import(" not in code:
            continue
        if path == PLUGINS:
            saw_loader = True
        else:
            offenders.append(path.relative_to(ROOT).as_posix())
    assert saw_loader, (
        "core/plugins.js no longer dynamic-imports; if the loader was folded into "
        "another module this scan no longer names the one designated site"
    )
    assert not offenders, (
        f"these modules dynamic-import besides core/plugins.js, so the loader is no "
        f"longer the one designated place a host URL becomes code: {offenders}"
    )


def test_the_shell_imports_the_loader_and_calls_it_exactly_once() -> None:
    assert "from './src/core/plugins.js'" in SHELL, (
        "app.js does not import core/plugins.js; the manifest in viewer-config.js "
        "would name modules nobody loads"
    )
    calls = len(re.findall(r"\bloadPlugins\(\{", SHELL))
    assert calls == 1, (
        f"app.js calls loadPlugins {calls} times; the manifest must load exactly once "
        "per boot or a re-entry doubles every registration (register() refuses a "
        "duplicate id, so the second pass would log a wall of refusals)"
    )


def test_the_shell_hands_the_hosts_credential_to_the_client() -> None:
    """The network seam the whole refactor exists for: without this, a secured PACS
    is unreachable and a plugin's api.dicomweb is anonymous."""
    code = _code(SHELL)
    call = code[code.index("new DicomWebClient({"):]
    call = call[: call.index("});")]
    assert "authHeaderProvider" in call, (
        "app.js still builds the client without authHeaderProvider; the host's "
        "viewer-config.js closure (or authToken) never reaches a request"
    )
    assert "CONFIG.authHeaderProvider" in call and "CONFIG.authToken" in call, (
        "both shapes of the host seam must be wired: a closure when the host has one, "
        "the static token otherwise, null (no header) when neither"
    )


def test_overlay_is_consumed_at_both_draw_sites() -> None:
    """OVERLAY was a dead kind -- registered by nobody consumable, drawing nothing.
    The audit found zero call sites; this gate needs two (draw, drawOverlays)."""
    code = _code(SHELL)
    sites = code.count("contributions(KINDS.OVERLAY)")
    assert sites >= 2, (
        f"app.js consumes OVERLAY at {sites} site(s); the contract needs the draw "
        "site in draw() AND the one in drawOverlays() (selection and measurement "
        "changes redraw annotations without redrawing the image)"
    )


def test_a_throwing_overlay_cannot_break_the_draw() -> None:
    """An overlay is decoration; a throwing one must never take the picture down.
    Each draw site wraps the loop in try/catch and logs by overlay id."""
    code = _code(SHELL)
    at = 0
    for _ in range(code.count("contributions(KINDS.OVERLAY)")):
        at = code.index("contributions(KINDS.OVERLAY)", at)
        window = code[at:at + 900]
        assert "try {" in window and "catch" in window, (
            "an OVERLAY draw loop without a per-overlay guard: one bad plugin blanks "
            "every panel it is registered on"
        )
        at += 1


def test_the_example_plugin_is_a_manifest_plugin_not_a_shell_import() -> None:
    """examples/ is outside src/, so the registry gates never scan it -- which is
    exactly why it must prove, here, that it is wired the plugin way: it imports the
    registry itself, exports setup, and the shell does NOT import it."""
    example = ROOT / "examples" / "hello-plugin.js"
    assert example.is_file(), (
        "examples/hello-plugin.js is gone; docs/extensions.md and README.md point "
        "readers at it as the working plugin"
    )
    code = example.read_text(encoding="utf-8")
    assert "from '../src/core/registry.js'" in code, (
        "the example must import register from the real registry -- a plugin "
        "registering into a registry of its own would draw nothing anywhere"
    )
    assert re.search(r"export (async )?function setup|export default", code), (
        "the example must export setup (named or default); the loader refuses a "
        "module without one"
    )
    assert "register({" in code and "KINDS.ACTION" in code and "KINDS.OVERLAY" in code
    assert "hello-plugin" not in SHELL, (
        "app.js imports the example plugin directly; examples/ must stay loadable "
        "ONLY through the manifest or the architecture gates' import story comes "
        "apart"
    )


def test_the_docs_describe_the_manifest_the_loader_reads() -> None:
    """The doc gate: the manifest shape a reader copies out of docs/extensions.md
    must be the shape loadPlugins reads (id/src/api), and the warnings the loader
    enforces (version refusal, failure isolation, credentials) must be stated where
    a plugin author meets them."""
    doc = (ROOT / "docs" / "extensions.md").read_text(encoding="utf-8")
    assert re.search(r"plugins:\s*\[\s*\{", doc), (
        "docs/extensions.md shows no plugins manifest block; a reader has nothing "
        "to copy into viewer-config.js"
    )
    for key in ("`id`", "`src`", "`api`"):
        assert key in doc, f"the manifest documentation never names the {key} key"
    for phrase in ("MAJOR", "never aborts", "credentials"):
        assert phrase in doc, (
            f"docs/extensions.md does not state the {phrase!r} rule the loader "
            "enforces; the doc and the code have come apart"
        )
    api_doc = (ROOT / "docs" / "api.md").read_text(encoding="utf-8")
    for member in ("register", "KINDS", "state", "dicomweb", "context", "notice"):
        assert member in api_doc, f"docs/api.md does not document api.{member}"
