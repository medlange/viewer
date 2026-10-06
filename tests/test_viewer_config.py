# SPDX-License-Identifier: Apache-2.0
"""viewer.config — the presentation layer, loaded at runtime, replaced by a mount.

WHAT V2 ADDS, and what it deliberately does not. The viewer already had an integration
seam (`viewer-config.js`, a JS global the host replaces: apiRoot, capabilities,
dicomWebRoot) and two data files (presets.json, protocols.json). What it had no way to
say was how the deployment LOOKS and is ARRANGED: which registered panels are on
screen, what the palette is, what the brand mark is, whether `?study=` deep links are
honoured. Those are the four members of `viewer.config.json` — branding, theme, panels,
routing — and the file is data, not code, so a host changes them by mounting a file,
never by rebuilding the viewer.

The seam relationship is pinned too: `viewer-config.js` keeps `productName` (it is the
host's statement about the surface and predates this file); `viewer.config.json` fills
the gap only when the seam named nothing. Two files naming a brand would drift; the
precedence is written down in code and asserted here.

Spec: roadmap V2; MOS-REL-108 (no dynamic import — the config is fetched data, which the
same prohibition makes the only available shape).
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG_JS = (ROOT / "src" / "core" / "config.js").read_text(encoding="utf-8")
SHELL = (ROOT / "app.js").read_text(encoding="utf-8")
INDEX = (ROOT / "index.html").read_text(encoding="utf-8")
SHIPPED = ROOT / "viewer.config.json"


def test_the_viewer_ships_its_own_default_config() -> None:
    """A bind mount cannot create a mountpoint inside a read-only tree — the same
    measured constraint that makes viewer-config.js ship in the tree makes this file
    ship: the deployment's copy mounts OVER this one, and without a shipped file the
    mount fails the container."""
    assert SHIPPED.is_file(), "viewer/ ships no viewer.config.json for a deployment to replace"
    data = json.loads(SHIPPED.read_text(encoding="utf-8"))
    assert set(data) == {"version", "branding", "theme", "panels", "routing"}, (
        "the shipped default must carry exactly the closed schema's top-level keys; a "
        "deployment that mounts over it reads THIS file's shape as the contract"
    )
    assert data["panels"]["disabled"] == []
    assert data["routing"]["deepLinkStudy"] is True


def test_the_config_is_fetched_data_not_code() -> None:
    """MOS-REL-108 forbids dynamic import in this surface; the configuration is runtime
    data, which is the same rule pointing at the shape it permits."""
    assert "('./viewer.config.json')" in CONFIG_JS
    assert "export async function loadViewerConfig" in CONFIG_JS


def test_a_missing_or_broken_config_is_defaults_not_a_refusal() -> None:
    """Every key is optional by design; a viewer that starts unstyled beats a viewer
    that does not start. A `throw` may exist INSIDE the loader's own try (a non-OK
    response is how the fallback is reached); what must not exist is a throw that
    escapes the loader — which is the catch arm assigning the defaults."""
    assert "DEFAULT_VIEWER_CONFIG" in CONFIG_JS
    assert "console.warn" in CONFIG_JS
    assert re.search(
        r"try \{[\s\S]*?throw new Error\(String\(res\.status\)\);[\s\S]*?"
        r"\} catch \(err\) \{[\s\S]*?held = DEFAULT_VIEWER_CONFIG;",
        CONFIG_JS,
    ), (
        "a failed fetch must reach the catch, and the catch must restore the defaults"
    )


def test_the_theme_only_writes_safe_css_custom_properties() -> None:
    """Theme values are written straight onto the document root; the gate is that a
    config value can set a VARIABLE, never a rule. Injection-shaped values are dropped."""
    assert "CSS_VAR_NAME = /^--[A-Za-z0-9-]+$/" in CONFIG_JS
    assert "CSS_VAR_VALUE = /^[^;{}]{1,128}$/" in CONFIG_JS
    assert "setProperty(varName, value)" in CONFIG_JS


def test_the_schema_is_closed_and_types_coerce() -> None:
    assert re.search(r"\['version', 'branding', 'theme', 'panels', 'routing'\]", CONFIG_JS)
    assert "ignoring unknown" in CONFIG_JS
    assert re.search(r"disabledRaw\.filter\(\(x\) => typeof x === 'string'", CONFIG_JS), (
        "panels.disabled normalises to a de-duplicated set of strings"
    )


def test_the_js_seam_wins_for_the_product_name() -> None:
    """Two files naming a brand would drift; the integration seam's productName has
    precedence and viewer.config fills the gap."""
    assert re.search(
        r"\(viewerConfigJs && viewerConfigJs\.productName\) \|\| branding\.productName",
        CONFIG_JS,
    ), "viewer-config.js's productName must win over viewer.config.json's"


def test_the_shell_loads_the_config_before_mounting_panels() -> None:
    assert "loadViewerConfig" in SHELL
    assert re.search(
        r"Promise\.all\(\[loadPresets\(\), loadProtocols\(\), loadViewerConfig\(\)\]\)", SHELL,
    ), "the config rides the same boot batch as presets and protocols"
    assert "applyViewerConfig(document, CONFIG)" in SHELL


def test_a_disabled_panel_is_absent_not_empty() -> None:
    """Turning a panel off removes its section — heading, empty state, tab stops —
    while registration stays untouched."""
    assert "disabledPanels()" in SHELL
    assert re.search(r"if \(off\.has\(panel\.id\)\) \{[\s\S]*?section\.remove\(\);", SHELL)


def test_the_deep_link_is_config_gated_and_boot_time() -> None:
    """`?study=<uid>` opens the case at boot when the deployment allows it; a kiosk
    turns `routing.deepLinkStudy` off and the parameter is ignored."""
    assert "deepLinkStudyEnabled" in SHELL
    assert re.search(
        r"get\('study'\)[\s\S]*?if \(deepLinkedStudy && deepLinkStudyEnabled\(\)\)", SHELL,
    )


def test_the_brand_mark_is_addressable() -> None:
    assert 'id="brand-mark"' in INDEX, (
        "the logo glyph is branding and therefore replaceable from viewer.config.json; "
        "without an id the config has nothing to address"
    )
