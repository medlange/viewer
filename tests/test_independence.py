# SPDX-License-Identifier: Apache-2.0
"""The viewer is a DICOMweb viewer. MedicalOS is what a host adds to it.

WHAT WAS COMPILED IN. `app.js` built its client against `/dicomweb/${TENANT}` with the
tenant read from the query string, and `dicomweb.js` sent `X-MedicalOS-Surface:
clinical_viewer` on every request. Four lines, and none of them is DICOMweb:

  * PS3.18 defines the service paths under a ROOT and says nothing about what precedes it.
    A tenant segment is one gateway's way of making `MOS-DATA-009` checkable -- the Gateway
    compares that segment against the authenticated principal's tenant -- and a viewer that
    requires one cannot open an Orthanc, a dcm4chee, or anything else conformant.
  * A consumer class is one platform's vocabulary. `MOS-UI-005` gives it a closed value
    space and `MOS-DATA-040` permits `pixel_phi.action: ALLOW` "only when the consumer
    class is clinical_viewer" -- which is a statement the ORIGIN checks, not one a surface
    is entitled to make about itself to an origin that never granted it.

MEASURED, after: a client configured the MedicalOS way sends
`/dicomweb/T1/studies` with `X-MedicalOS-Surface: clinical_viewer`; the viewer's own
default sends `/dicomweb/studies` with nothing but `Accept`.

AND NOTHING GUARDED THE OLD ARRANGEMENT. No gate asserted the surface header, so the one
thing that makes the pixel-PHI permission checkable at the Gateway could have been dropped
from the viewer without a single test going red. This file is that gate as well.
"""

from __future__ import annotations

import re
from pathlib import Path

VIEWER = Path(__file__).resolve().parents[1]

_LINE_COMMENT = re.compile(r"^\s*//.*$", re.M)
_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.S)
_HTML_COMMENT = re.compile(r"<!--.*?-->", re.S)


def _code(text: str) -> str:
    return _HTML_COMMENT.sub("", _LINE_COMMENT.sub("", _BLOCK_COMMENT.sub("", text)))


def _viewer_code() -> dict[str, str]:
    """Every shipped source of the viewer, comments stripped, by relative path."""
    out = {}
    for path in sorted(VIEWER.rglob("*")):
        if path.suffix not in (".js", ".html") or not path.is_file():
            continue
        rel = path.relative_to(VIEWER).as_posix()
        if rel == "viewer-config.js":
            continue          # the seam's own default, checked separately below
        out[rel] = _code(path.read_text(encoding="utf-8"))
    return out


def test_no_deployment_vocabulary_is_compiled_into_the_viewer() -> None:
    """A platform's words in a viewer's code are a viewer only that platform can use."""
    offenders: dict[str, list[str]] = {}
    for rel, code in _viewer_code().items():
        for term in ("clinical_viewer", "X-MedicalOS-Surface"):
            if term in code:
                offenders.setdefault(rel, []).append(term)
        # The tenant-segmented root, in any spelling that builds it from a constant.
        if re.search(r"['\"`]/dicomweb/\$\{", code):
            offenders.setdefault(rel, []).append("/dicomweb/${...}")

    assert not offenders, (
        "these carry a deployment's vocabulary in the viewer's own code, so the viewer "
        "cannot be pointed at a conformant origin that is not this project's Gateway:\n"
        + "\n".join(f"    {rel}: {', '.join(t)}" for rel, t in sorted(offenders.items()))
    )


def test_the_surface_header_is_sent_only_when_a_host_asks_for_it() -> None:
    """An absent consumer class is a statement, not a missing default.

    Declaring `clinical_viewer` to an origin that never granted one asserts a permission
    the surface does not hold -- and `MOS-DATA-040` hangs unredacted pixels on exactly
    that class being true.
    """
    wire = _code((VIEWER / "src" / "dicom" / "dicomweb.js").read_text(encoding="utf-8"))

    # THE NAME IS CONFIGURATION TOO. The first version of this seam moved the VALUE out and
    # left `const SURFACE_HEADER = 'X-MedicalOS-Surface'` behind -- and the gate above
    # caught it, because a constant spelling one vendor's header is the same defect as one
    # spelling its value, a step quieter. The two assertions contradicted each other for
    # one commit, which is what a contradiction between gates is FOR.
    assert "surfaceHeader = null, surface = null" in wire, (
        "the constructor defaults the consumer class or its header to something, so a "
        "viewer nobody configured still declares one"
    )
    assert (
        "this.surfaceHeader = surfaceHeader && surface ? String(surfaceHeader) : null;"
        in wire
    ), (
        "a header name without a value, or a value without a name, is accepted -- the "
        "first sends a blank assertion and the second has nowhere to go"
    )
    assert "if (this.surfaceHeader) h[this.surfaceHeader] = this.surface;" in wire, (
        "the header is sent unconditionally, or under a different condition than having "
        "been configured"
    )


def test_the_root_is_asked_for_and_the_tenant_is_optional() -> None:
    """`/dicomweb` is the shape every conformant origin answers; a tenant is an extra."""
    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))

    assert "window.VIEWER_CONFIG" in app, "nothing reads a host's configuration"
    assert "CONFIG.dicomWebRoot || '/dicomweb'" in app, (
        "the DICOMweb root is not configurable, or its fallback is not the plain one"
    )
    assert "TENANT ? `${base}/${TENANT}` : base" in app, (
        "the tenant segment is appended unconditionally, so an origin that does not scope "
        "by tenant is asked for a path it does not serve"
    )
    # THE QUERY STRING STILL WINS. It predates this seam and people hold links to it.
    assert "URLSearchParams(location.search).get('tenant')" in app, (
        "`?tenant=` no longer reaches a second tenant without a second deployment"
    )
    assert "surface: CONFIG.surface" in app, (
        "the consumer class is not taken from configuration"
    )


def test_the_viewer_ships_its_own_defaults_and_the_deployment_replaces_them() -> None:
    """A bind mount cannot create a mountpoint inside a read-only directory.

    MEASURED: mounting `viewer-config.js` into the viewer's tree, which this project's own
    compose file mounts `:ro`, failed the container at
    `openat viewer-config.js: read-only file system`. A file that EXISTS can be mounted
    over; a file that does not cannot. So the viewer ships its defaults -- which is the
    right design anyway, because a plain DICOMweb client is what this viewer is when
    nobody has told it otherwise.
    """
    shipped = VIEWER / "viewer-config.js"
    assert shipped.is_file(), (
        "the viewer ships no default configuration, so there is no mountpoint for a "
        "deployment to replace and no answer when nobody configures it"
    )
    defaults = _code(shipped.read_text(encoding="utf-8"))
    assert "'/dicomweb'" in defaults, "the shipped default root is not the plain one"
    assert "surface" not in defaults, (
        "the viewer ships a consumer class, so an unconfigured viewer declares one to an "
        "origin that never granted it"
    )
    assert "tenant" not in defaults, "the viewer ships a tenant of its own"

    markup = (VIEWER / "index.html").read_text(encoding="utf-8")
    code = _code(markup)
    assert '<script src="./viewer-config.js"></script>' in code, (
        "the configuration is not loaded as a plain classic script; `defer`, `async` and "
        "`type=module` all let the module entry point read it before it has run"
    )
    assert code.index('viewer-config.js') < code.index('src="./app.js"'), (
        "the configuration is loaded after the application that reads it"
    )

    # THE OTHER SIDE OF THE SEAM IS NOT THIS FILE'S BUSINESS. That a deployment supplies
    # its own `viewer-config.js` and mounts it over this one is asserted in the platform's
    # suite (`tests/unit/test_viewer_deployment.py`), because it is a fact about a
    # deployment. A viewer whose own tests read `medos/deploy/compose/` is a viewer that knows
    # its host, which is the exact coupling this file exists to forbid.


def test_the_product_name_is_a_hosts_and_the_safety_marking_is_not() -> None:
    """Two pieces of text, two mechanisms, and the difference between them is the point.

    THE NAME goes through `viewer-config.js` and is written by the shell on boot. Showing
    the shipped default for one frame costs nothing, and a name is a name.

    THE FOOTER STATEMENT does not, and must not. `MOS-SAFE-001` requires its sentence
    verbatim in the web UI footer; passing it through the same JavaScript seam would make
    a required safety marking depend on a module loading, which is strictly weaker than
    what the requirement asks for and would look like a refactor. It is substituted into
    the response body by nginx instead -- `test_the_footer_carries_the_statement...` in
    `test_architecture.py` pins that filter to the marker.

    AND THE VIEWER'S OWN MARKING STAYS SHIPPED. "RESEARCH USE ONLY" is not a claim about a
    platform, it is what this software is for, and it is true under any host. A viewer
    showing no marking at all while its host's statement failed to arrive would be worse
    than either of them alone.
    """
    markup = (VIEWER / "index.html").read_text(encoding="utf-8")
    visible = _code(markup)

    assert "MedicalOS" not in visible, (
        "the viewer's markup names this platform again, so a deployment pointed at any "
        "other archive shows somebody else's product name"
    )
    assert 'id="product-name"' in visible, (
        "the heading cannot be addressed, so a host has no way to name the surface"
    )
    assert "RESEARCH USE ONLY" in visible, (
        "the viewer's own research-use marking was removed along with the platform's "
        "name; it is not a claim about a platform and it is true under any host"
    )

    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    assert "CONFIG.productName" in app and "document.title" in app, (
        "nothing applies a host's name to the surface"
    )

    dialogs = _code((VIEWER / "src" / "ui" / "dialogs.js").read_text(encoding="utf-8"))
    assert "MedicalOS" not in dialogs, (
        "the About dialog names this platform in code, so every language's string carries "
        "it too and a translator is handed somebody's trademark to translate"
    )
    assert "'{product}'" in dialogs, (
        "the About title does not take the host's name through a placeholder"
    )

    # AND NO TABLE CARRIES IT EITHER. A product name inside twelve translations is twelve
    # places to change it and twelve chances to miss one.
    import json as _json
    for table in sorted((VIEWER / "i18n").glob("*.json")):
        assert "MedicalOS" not in table.read_text(encoding="utf-8"), (
            f"{table.name} names this platform; the About title takes it from "
            "configuration through `{product}` precisely so that no table has to"
        )
        strings = _json.loads(table.read_text(encoding="utf-8"))
        assert "{product}" in strings["about.title"], (
            f"{table.name}'s About title lost the placeholder, so it names nothing or "
            "names something fixed"
        )
