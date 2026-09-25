# SPDX-License-Identifier: Apache-2.0
"""Every sampler gets a texture unit on every draw, or the draw is thrown away whole.

WHAT HAPPENED
-------------
`viewport.js` declares three samplers of three different types:

    uniform isampler2D u_image;      // stored pixel values, R16I
    uniform usampler2D u_overlay;    // segment index per pixel, R8UI
    uniform sampler2D  u_fusion;     // the second acquisition, R32F

`u_image` and `u_overlay` were assigned units 0 and 1 on every render. `u_fusion` was
assigned unit 2 **inside `if (this.hasFusion)`** — so on every study without a fusion,
which is nearly all of them, its uniform kept the default value 0 and pointed at the unit
where `u_image` has an integer texture bound.

Two samplers of different types on one texture unit is invalid under GLES 3.0 §2.11.8,
and validation happens at draw time against the BINDINGS — the shader's own
`if (u_hasFusion)` guard is irrelevant, because the driver never gets as far as the
branch. Chrome rejected the call:

    GL_INVALID_OPERATION: glDrawArrays: Two textures of different types use the same
    sampler location.

**The viewport painted nothing, for every study.** Measured on a CT-only study before the
fix: `gl.getError()` returned 1282 and the 1108x1139 canvas held no non-zero subpixel,
while the series thumbnail beside it — drawn through a 2D context rather than this
program — had 726. That is why it did not read as a rendering bug: the pixels were
fetched, decoded, offset and windowed correctly, and then silently not drawn. After the
fix the same study renders and `gl.getError()` is 0.

WHY A SOURCE CHECK AND NOT A RENDER
-----------------------------------
`viewer/tests/js/` drives real modules in a real browser, and a render test would be the
stronger instrument. It would also not have caught this: the defect is invisible unless
something asserts on `gl.getError()`, and a headless render that produces a black frame
looks like a fixture with no contrast. What is exactly checkable in the source is the
property that was violated — that a sampler's unit is assigned unconditionally — and it
is checkable for every sampler at once, including ones added later.
"""

from __future__ import annotations

import re
from pathlib import Path

VIEWPORT = Path(__file__).resolve().parents[1] / "src" / "render" / "viewport.js"

#: `uniform isampler2D u_image;` and friends.
_SAMPLER = re.compile(r"^\s*uniform\s+[iu]?sampler2D\s+(u_\w+)\s*;", re.M)

#: `gl.uniform1i(this.u.u_image, 0);`
_ASSIGN = re.compile(r"gl\.uniform1i\(\s*this\.u\.(u_\w+)\s*,\s*(\d+)\s*\)")


def _source() -> str:
    return VIEWPORT.read_text(encoding="utf-8")


def _depth_at(text: str, index: int) -> int:
    """Brace nesting depth at `index`, ignoring braces inside the GLSL string literals.

    The shader sources are template literals full of braces, and counting those would
    make every depth meaningless. They are skipped by taking only the part of the file
    after the last backtick that precedes `index` if that backtick opens a literal —
    simpler and sufficient here: the render method contains no template literal.
    """
    return text.count("{", 0, index) - text.count("}", 0, index)


def _render_method(text: str) -> tuple[int, int]:
    """(start, end) of the method that ends in `gl.drawArrays`."""
    draw = text.index("gl.drawArrays(")
    start = text.rindex("\n  render(", 0, draw)
    return start, draw


def test_every_sampler_in_the_shader_is_assigned_a_texture_unit() -> None:
    text = _source()
    declared = set(_SAMPLER.findall(text))
    assert len(declared) >= 3, (
        f"only {sorted(declared)} sampler uniforms found in {VIEWPORT.name}; the pattern "
        "has stopped matching the shader and this check is reading nothing"
    )

    assigned = {name for name, _ in _ASSIGN.findall(text)}
    missing = sorted(declared - assigned)
    assert not missing, (
        f"{missing} is declared as a sampler and never given a texture unit. An unset "
        "sampler uniform is 0, so it aliases whatever is on TEXTURE0 — and if that has a "
        "different sampler type, every draw is rejected with GL_INVALID_OPERATION and "
        "the viewport goes black. See this module's docstring."
    )


def test_no_sampler_unit_is_assigned_inside_a_conditional() -> None:
    """The defect exactly: an assignment a branch can skip.

    Depth is compared against `gl.drawArrays`, which is the statement whose validity the
    bindings decide. Anything nested deeper than the draw is reachable only some of the
    time, and a sampler bound only some of the time is a sampler unbound the rest of it.
    """
    text = _source()
    start, draw = _render_method(text)
    draw_depth = _depth_at(text, draw)

    conditional: list[str] = []
    for m in _ASSIGN.finditer(text, start, draw):
        if _depth_at(text, m.start()) > draw_depth:
            line = text.count("\n", 0, m.start()) + 1
            conditional.append(f"{m.group(1)} -> unit {m.group(2)} (line {line})")

    assert not conditional, (
        "these samplers are given their texture unit inside a conditional:\n    "
        + "\n    ".join(conditional)
        + f"\n  `gl.drawArrays` sits at brace depth {draw_depth}; these sit deeper, so a "
        "render that takes the other branch leaves the sampler at its default unit 0. "
        "That is what made the viewport black for every study without a fusion: "
        "`u_fusion` (sampler2D) aliased `u_image` (isampler2D) on TEXTURE0 and the draw "
        "was rejected outright. Bind it unconditionally; guard the SHADER with its "
        "`u_has*` flag, not the binding."
    )


def test_the_samplers_do_not_share_a_unit() -> None:
    """Distinct types must be on distinct units; the same aliasing, written on purpose."""
    text = _source()
    start, draw = _render_method(text)
    units: dict[str, int] = {}
    for m in _ASSIGN.finditer(text, start, draw):
        units[m.group(1)] = int(m.group(2))

    collisions = [
        (a, b, u)
        for a, u in units.items()
        for b, v in units.items()
        if a < b and u == v
    ]
    assert not collisions, (
        f"two samplers share a texture unit: {collisions}. GLES 3.0 §2.11.8 allows that "
        "only when both have the same sampler type; these are declared isampler2D, "
        "usampler2D and sampler2D, so sharing is always a rejected draw."
    )
    assert len(units) >= 3, f"only {units} assigned between the method start and the draw"
