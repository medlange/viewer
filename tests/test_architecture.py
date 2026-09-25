# SPDX-License-Identifier: Apache-2.0
"""The viewer's contribution seam is static, and a panel does not reach into app.js.

WHY A PYTHON TEST FOR JAVASCRIPT
----------------------------------
This repository has no JavaScript toolchain and `viewer/` deliberately has no build
step -- that absence IS the argument for building the viewer at all
(`docs/adr/BUILD_VS_ADOPT.md`: every dependency is a SOUP item under IEC 62304 8.1.2). So
the properties worth gating are the STRUCTURAL ones, and those are readable from source:
whether a module imports what it claims, whether the registry can be reached dynamically,
whether a panel calls back into the god object.

`tests/unit/test_declared_dependencies.py` already establishes the precedent -- it reads
imports rather than trusting them. This does the same for the browser side.

WHAT IS NOT CLAIMED HERE
-------------------------
That the panels render correctly. That needs a browser, and the rendering-correctness
harness the ADR records as owed is where it belongs. A structural gate that implied
otherwise would be the "green check measuring the wrong thing" this codebase keeps finding.

Spec: MOS-REL-108, MOS-UI-204, MOS-UI-010.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

# THE VIEWER IS THE ONLY THING THIS FILE MAY ADDRESS, and there is no name here for the
# repository on purpose. Two tests that used to live below reached the checkout by walking
# UP from the viewer -- `VIEWER.parents[1]` -- which was the repository root only for as
# long as the tree sat at `web/viewer/`. After the move it was the parent of the checkout:
# one of them read a specification chapter and failed loudly, the other looped over roots
# that no longer existed and REPORTED A PASS. Both now live in the platform's suite, where
# their subject actually is. Nothing in this file walks up.
VIEWER = Path(__file__).resolve().parents[1]
SRC = VIEWER / "src"


def _js(*parts: str) -> str:
    return (SRC.joinpath(*parts)).read_text(encoding="utf-8")


def _regex_starts_here(out: list[str]) -> bool:
    """Whether a `/` at this point opens a regex literal rather than dividing.

    The heuristic every small JavaScript tokeniser uses: look at the last significant
    character emitted. A division follows a VALUE -- an identifier, a number, a closing
    bracket; a regex follows an OPERATOR, a separator, or nothing. `return`, `typeof` and
    friends end in a letter and would read as identifiers, so they are named.
    """
    seen = "".join(out[-16:]).rstrip()
    if not seen:
        return True
    for word in ("return", "typeof", "case", "in", "of", "delete", "void", "instanceof"):
        if seen.endswith(word) and (len(seen) == len(word) or not seen[-len(word) - 1].isalnum()):
            return True
    return seen[-1] in "(,=:[!&|?{};+-*%<>~^"


def _fnbody(code: str, signature: str) -> str:
    """The text of one function, ending at the next top-level close or the end of the file.

    A FUNCTION THAT IS LAST IN ITS MODULE HAS NO CLOSING MARKER AFTER IT. Slicing to
    `chr(10) + "}" + chr(10)` raised `substring not found` three separate times in this
    suite as functions were added at the end of `measure.js`, `sync.js` and `reference.js` --
    each time a gate that was testing the right property failed for a reason that had
    nothing to do with the property.
    """
    body = code[code.index(signature):]
    end = body.find(chr(10) + "}" + chr(10))
    return body if end < 0 else body[: end]


def _expressions(text: str) -> str:
    """JavaScript with comments and string CONTENTS removed, leaving only real code.

    WHY IT EXISTS. `test_no_measurement_helper_is_exported_without_a_caller` searched the
    raw source for the identifier, and an identifier is a very common thing for a string to
    contain: `measurements-panel.js` and `annotations.js` both branch on `kind === 'angle'`,
    so the word appeared 18 times inside string literals and the gate could not fail
    whatever was deleted.

    WHY IT IS A SCANNER AND NOT A REGEX. The first attempt matched quoted runs with
    `'(?:[^'])*'` and reported every export of `transform.js` as dead. A trailing
    `// don't` leaves one apostrophe behind, the next quote is hundreds of lines away, and
    everything between them vanishes -- including the calls being looked for. A gate that
    fails wrongly is the same defect as one that passes wrongly; only the direction differs.

    A template literal keeps its `${...}` parts, because a call inside an interpolation is a
    real call.
    """
    # Spelled with chr() so this file carries no quote character that its own scanner,
    # or any gate that greps this suite, has to reason about.
    Q, DQ, BT, BS = chr(39), chr(34), chr(96), chr(92)
    out = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        two = text[i:i + 2]
        if two == "//":
            i = text.find("\n", i)
            if i < 0:
                break
        elif two == "/*":
            j = text.find("*/", i + 2)
            i = n if j < 0 else j + 2
        elif c == "/" and _regex_starts_here(out):
            # A REGEX LITERAL IS NOT DIVISION, AND IT CAN CONTAIN QUOTES.
            #
            # `measurementsCSV` tests a field with `/[",\\n]/` -- and the `"` inside that
            # character class opened a string this scanner then ran to the end of the next
            # quote, somewhere in another file, swallowing every call in between. The gate
            # that reads this reported two `transform.js` exports as reached by nothing
            # while app.js called them three times.
            #
            # Telling a regex from a division is the classic JavaScript lexing ambiguity
            # and it cannot be settled without parsing. `_regex_starts_here` uses the
            # standard heuristic -- what can legally precede a regex cannot precede a
            # division -- which is exact for every form this codebase writes.
            i += 1
            while i < n and text[i] != "/":
                if text[i] == BS:
                    i += 2
                    continue
                if text[i] == "[":                      # `/` inside a class is literal
                    while i < n and text[i] != "]":
                        i += 2 if text[i] == BS else 1
                if text[i] == chr(10):                  # a regex cannot span a line
                    break
                i += 1
            i += 1
            out.append(" ")
        elif c in (Q, DQ):
            i += 1
            while i < n and text[i] != c:
                # A string cannot span a line break in JavaScript; stopping at one keeps a
                # stray apostrophe from consuming the rest of the file.
                if text[i] == "\n":
                    break
                i += 2 if text[i] == BS else 1
            i += 1
            out.append(" ")
        elif c == BT:
            i += 1
            while i < n and text[i] != BT:
                if text[i:i + 2] == "${":
                    depth, i = 1, i + 2
                    while i < n and depth:
                        if text[i] == "{":
                            depth += 1
                        elif text[i] == "}":
                            depth -= 1
                        if depth:
                            out.append(text[i])
                        i += 1
                    out.append(" ")
                else:
                    i += 2 if text[i] == BS else 1
            i += 1
        else:
            out.append(c)
            i += 1
    return "".join(out)


def _code(text: str) -> str:
    """Source with comments stripped, so prose discussing a forbidden thing is not a hit."""
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return "\n".join(
        line for line in text.splitlines() if not line.lstrip().startswith("//")
    )


# --------------------------------------------------------------------------------------
# MOS-REL-108: contributions are imported, never fetched
# --------------------------------------------------------------------------------------


def test_the_registry_cannot_load_a_contribution_dynamically() -> None:
    """The property `services/catalogue.py` protects on the Python side.

    Whether MOS-REL-108 reaches a static page is arguable -- the clause is about a platform
    PROCESS. The position taken is that the property it buys is worth the same here: a
    reviewer can read the complete set of executable contributions with `grep import`.
    """
    code = _code(_js("core", "registry.js"))
    forbidden = ("import(", "eval(", "new Function", "fetch(", "importScripts")
    found = [f for f in forbidden if f in code]
    assert not found, (
        f"registry.js reaches for {found}. A contribution is an object a module already "
        f"imported; there is no URL loader and no import() over a configuration string."
    )


def test_a_duplicate_id_is_refused_rather_than_overwritten() -> None:
    """Two contributions on one id resolve by import order and the loser is invisible --
    which looks like a rendering bug rather than a registration one."""
    code = _code(_js("core", "registry.js"))
    assert "already registered" in code
    assert "bucket.has(id)" in code


# --------------------------------------------------------------------------------------
# the seam actually holds
# --------------------------------------------------------------------------------------


def test_a_panel_does_not_reach_into_the_application_shell() -> None:
    """THE POINT OF THE REFACTOR. A panel that imports app.js has not been decoupled from
    it; it has been moved."""
    offenders: list[str] = []
    ui = SRC / "ui"
    if not ui.is_dir():
        pytest.skip("no ui/ modules yet")
    for path in sorted(ui.glob("*.js")):
        code = _code(path.read_text(encoding="utf-8"))
        for m in re.finditer(r"from\s+'([^']+)'", code):
            target = m.group(1)
            if "app.js" in target:
                offenders.append(f"{path.name} imports {target}")
    assert not offenders, (
        "these panels import the application shell:\n  " + "\n  ".join(offenders)
        + "\nA panel receives an element and subscribes to state. If it needs something "
        "app.js has, that thing belongs in src/core/ or src/services/."
    )


def test_a_panel_returns_its_own_teardown() -> None:
    """A layout change must not leave a subscriber attached to a detached element -- the
    leak that turns a long reading session into a page repainting panels nobody can see."""
    ui = SRC / "ui"
    if not ui.is_dir():
        pytest.skip("no ui/ modules yet")
    for path in sorted(ui.glob("*-panel.js")):
        code = _code(path.read_text(encoding="utf-8"))
        assert "mount(" in code, f"{path.name} has no mount()"
        assert "subscribeTo(" in code or "subscribe(" in code, (
            f"{path.name} never subscribes; it will render once and go stale"
        )
        # RETURNS A TEARDOWN, in either of the two honest shapes: the unsubscribe itself,
        # or a closure that calls several. The first version of this gate demanded the
        # literal `return subscribe`, which failed a panel holding TWO subscriptions and
        # returning `() => { stop(); stopLang(); }` -- a more careful teardown than the one
        # the gate was written for. What must be true is that mount() hands back something
        # callable, not that it is spelled one particular way.
        returns_unsub = "return subscribe" in code
        returns_closure = "return () =>" in code or "return function" in code
        assert returns_unsub or returns_closure, (
            f"{path.name}'s mount() does not return the unsubscribe, so nothing can tear "
            f"it down"
        )


# --------------------------------------------------------------------------------------
# MOS-UI-204 / MOS-UI-010: no editing primitives, anywhere on this surface
# --------------------------------------------------------------------------------------


FORBIDDEN_PRIMITIVES = (
    "brush", "eraser", "scissors", "regionGrow", "region_grow",
    "floodFill", "flood_fill", "interpolateLabel", "undoStack",
)


def test_no_module_implements_a_segmentation_editing_primitive() -> None:
    """`MOS-UI-204`: "forbidden regardless of how small the first version looks, because
    the second version is a segmentation editor"."""
    offenders: list[str] = []
    for path in sorted(VIEWER.rglob("*.js")):
        code = _code(path.read_text(encoding="utf-8"))
        for word in FORBIDDEN_PRIMITIVES:
            if re.search(rf"\b{word}\b", code):
                offenders.append(f"{path.relative_to(VIEWER)} contains {word!r}")
    assert not offenders, (
        "segmentation editing primitives on the clinician surface:\n  "
        + "\n  ".join(offenders)
        + "\nMOS-UI-204 and MOS-UI-010 forbid these outright. A reviewer who disagrees with "
        "a generated SEG records a ResultReview with action MODIFIED (MOS-SAFE-069); they "
        "do not redraw it."
    )


def test_the_segments_panel_toggles_visibility_and_nothing_else() -> None:
    """Named specifically, because a segment list is where an editor would first appear."""
    panel = SRC / "ui" / "segments-panel.js"
    if not panel.is_file():
        pytest.skip("segments panel not written yet")
    code = _code(panel.read_text(encoding="utf-8"))
    for word in ("setPixel", "putImageData", "paint", "draw_mask", "writeSegment"):
        assert word not in code, f"the segments panel contains {word!r}"


# --------------------------------------------------------------------------------------
# the state module's own promises
# --------------------------------------------------------------------------------------


def test_state_notification_is_synchronous() -> None:
    """A batched repaint can show a state no single `set()` produced. On a surface where a
    repaint is a segmentation overlay on a slice, an intermediate state is a wrong
    picture."""
    code = _code(_js("core", "state.js"))
    for deferred in ("queueMicrotask", "setTimeout", "requestAnimationFrame", "Promise.resolve"):
        assert deferred not in code, (
            f"state.js defers notification via {deferred}; subscribers can then observe a "
            f"state no single set() produced"
        )


def test_one_broken_subscriber_does_not_stop_the_others() -> None:
    """Otherwise a panel that throws while rendering prevents every later subscriber --
    including the viewport -- from seeing the change, and the reader is left looking at the
    previous slice with no indication anything failed."""
    code = _code(_js("core", "state.js"))
    assert "try {" in code and "catch" in code, "state.js does not isolate subscribers"


# --------------------------------------------------------------------------------------
# measurements: MOS-IMG-039 governs where the number comes from
# --------------------------------------------------------------------------------------


def test_measurements_read_the_source_array_and_never_the_canvas() -> None:
    """`MOS-IMG-039`/`MOS-IMG-041`: a measurement computed anywhere but the source array
    "is a defect, not an approximation".

    A mean HU read off the display would change when the reader changed the window -- a
    measurement that depends on how you were looking at it.
    """
    measure = SRC / "image" / "measure.js"
    if not measure.is_file():
        pytest.skip("measurement module not written yet")
    code = _code(measure.read_text(encoding="utf-8"))
    for forbidden in ("getImageData", "readPixels", "toDataURL", "getContext", "canvas"):
        assert forbidden not in code, (
            f"measure.js reaches for {forbidden!r}; the number must come from the stored "
            f"Int16Array through slope*stored+intercept, not from what is on screen"
        )
    assert "frame.slope" in code and "frame.intercept" in code, (
        "measure.js does not apply the rescale, so its numbers are stored values and not HU"
    )


def test_measurements_take_spacing_from_the_frame() -> None:
    """A caliper assuming square pixels is right on axial and wrong by a factor of three on
    a coronal reconstruction of a 3 mm study -- and looks identical."""
    measure = SRC / "image" / "measure.js"
    if not measure.is_file():
        pytest.skip("measurement module not written yet")
    code = _code(measure.read_text(encoding="utf-8"))
    assert "frame.pixelSpacing" in code, "measure.js does not read the frame's spacing"
    assert re.search(r"\[rowMm,\s*colMm\]\s*=\s*frame\.pixelSpacing", code), (
        "measure.js does not destructure PixelSpacing as [row, column]. DICOM (0028,0030) "
        "is [row spacing, column spacing] and reversing them is the easiest way to produce "
        "a caliper that is plausible on square pixels and wrong on every anisotropic study."
    )


def test_a_measurement_records_which_slice_it_is_of() -> None:
    """A number without its slice is not reproducible: the same ROI one slice along is a
    different number, and nobody can check a panel row that does not say where it came
    from."""
    measure = SRC / "image" / "measure.js"
    if not measure.is_file():
        pytest.skip("measurement module not written yet")
    code = _code(measure.read_text(encoding="utf-8"))
    for field in ("plane", "sliceIndex", "sopInstanceUID", "clinicalUse"):
        assert field in code, f"a measurement does not carry {field!r}"


def test_the_screen_to_image_transform_has_exactly_one_implementation() -> None:
    """`readout()` used to invert `viewport.render()`'s fit inline, and its own comment
    admitted the risk: "kept in step with it by hand ... if the two ever disagree the
    reported HU is for a pixel the reader is not pointing at". Measurements would have made
    that a third copy, and a caliper anchored a pixel from where the reader clicked is a
    wrong number that looks right.
    """
    app = VIEWER / "app.js"
    code = _code(app.read_text(encoding="utf-8"))
    assert "screenToImage" in code, "app.js does not use the shared transform"
    # the tell-tale of a private re-derivation
    assert "canvasAspect" not in code, (
        "app.js computes its own aspect fit again; the fit lives in src/render/transform.js "
        "and both directions must come from the same numbers"
    )


def test_the_transform_refuses_a_degenerate_canvas() -> None:
    """A hidden, mid-layout or zero-height pane gives width/0 = Infinity, so the scale
    collapses to 0 and every later division yields NaN -- which sails past a
    `Math.abs(u) > 1` bounds check, because NaN > 1 is false. The reader then sees
    "NaN HU (NaN, NaN)" where a number belongs. Observed live with the pane collapsed.
    """
    code = _code(_js("render", "transform.js"))
    assert "canvas.width > 0" in code and "canvas.height > 0" in code, (
        "transform.js does not guard a degenerate canvas"
    )
    assert code.count("if (!fit) return") >= 2, (
        "callers of fitOf() do not handle its null, so the guard only moves the NaN"
    )


# --------------------------------------------------------------------------------------
# the annotation layer
# --------------------------------------------------------------------------------------


def test_the_annotation_layer_never_intercepts_pointer_events() -> None:
    """`MOS-UI-207` requires the default window/level binding to be live "the moment the
    case opens, without the reader selecting a mode". A layer that swallowed pointer events
    would break it the moment one measurement existed."""
    code = _code(_js("render", "annotations.js"))
    assert "pointerEvents = 'none'" in code or 'pointerEvents = "none"' in code, (
        "annotations.js does not disable pointer events on its layer"
    )


def test_annotations_are_positioned_only_through_the_shared_transform() -> None:
    """A caliper drawn with its own arithmetic sits BESIDE the pixels its number came from:
    the number is right and the line is wrong."""
    code = _code(_js("render", "annotations.js"))
    assert "imageToScreen" in code
    for private in ("canvasAspect", "pixelSpacing["):
        assert private not in code, (
            f"annotations.js derives geometry itself ({private!r}); positions must come "
            f"from transform.js, whose two directions are exact inverses"
        )


def test_a_measurement_tool_is_armed_for_one_use_not_a_mode() -> None:
    """`MOS-UI-207`: "A surface on which window/level is a tool the reader must first pick
    is a surface in which the single most frequent action in thoracic reading costs two
    clicks, and the reader will notice within the first case."
    """
    tools = SRC / "tools" / "measure-tools.js"
    if not tools.is_file():
        pytest.skip("measurement tools not written yet")
    code = _code(tools.read_text(encoding="utf-8"))
    assert "event.button !== 0" in code, (
        "the tool does not leave middle and right drag alone; pan and zoom are how a "
        "reader positions the thing they are about to measure"
    )
    assert "onCancel" in code, "no way to disarm a tool without measuring"


def test_a_degenerate_drag_does_not_become_a_measurement() -> None:
    """A click with no movement gives a 0.0 mm caliper or a zero-pixel ROI whose mean is
    NaN. A panel row reading "NaN HU" looks like a measurement that failed rather than one
    that was never made."""
    tools = SRC / "tools" / "measure-tools.js"
    if not tools.is_file():
        pytest.skip("measurement tools not written yet")
    code = _code(tools.read_text(encoding="utf-8"))
    assert re.search(r"Math\.abs\(end\.\w+ - start\.\w+\) < 1", code), (
        "measure-tools.js commits a measurement from a zero-length drag"
    )


# --------------------------------------------------------------------------------------
# The seam is ADOPTED, not merely present
#
# These three gates exist because the same defect landed three times, each time wearing a
# different hat, and each time a comment asserted the behaviour nobody had measured:
#
#   readout()            a call site survived the deletion of its definition, and three
#                        commit messages claimed the HU readout worked.
#   measurements panel   converted to state, but the annotation layer still drew from the
#                        old source -- the panel removed a row and the image kept the shape.
#   segments panel       registered, given a slot in mountPanels, carrying a header that
#                        said "a real panel can live on them without app.js reaching in"
#                        -- and never imported by app.js at all. The proof never ran.
#
# The common shape is a DECLARATION WITH NO CONSUMER, or a consumer with no declaration. A
# structural gate can see exactly that, and it is the cheapest place to see it.
# --------------------------------------------------------------------------------------


def _balanced(text: str, open_at: int) -> str:
    """The `{...}` beginning at `open_at`, brace-matched. Good enough for object literals."""
    depth = 0
    for i in range(open_at, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[open_at : i + 1]
    return ""


def _state_keys_written() -> set[str]:
    """Every key any `set({...})` / `setState({...})` call writes, across the viewer."""
    keys: set[str] = set()
    for path in sorted(VIEWER.rglob("*.js")):
        code = _code(path.read_text(encoding="utf-8"))
        for match in re.finditer(r"\b(?:setState|set)\(\s*\{", code):
            body = _balanced(code, code.index("{", match.start()))
            if not body:
                continue
            inner = body[1:-1]
            keys |= set(re.findall(r"(?:^|[,{])\s*([A-Za-z_]\w*)\s*:", inner))
            keys |= set(re.findall(r"(?:^|,)\s*([A-Za-z_]\w*)\s*(?=[,}]|$)", inner))
    return keys


def _state_keys_subscribed() -> dict[str, set[str]]:
    """Every key each module passes to `subscribeTo([...])`, by module path."""
    out: dict[str, set[str]] = {}
    for path in sorted(VIEWER.rglob("*.js")):
        code = _code(path.read_text(encoding="utf-8"))
        found: set[str] = set()
        for match in re.finditer(r"subscribeTo\(\s*\[([^\]]*)\]", code):
            found |= set(re.findall(r"['\"]([^'\"]+)['\"]", match.group(1)))
        if found:
            out[path.name] = found
    return out


def test_every_subscribed_state_key_is_actually_written_somewhere() -> None:
    """A subscription to a key nobody writes is a panel that renders once and then freezes.

    This is the gate that would have caught the segments panel. It subscribed to `panels`
    and `active` -- names that exist in `core/state.js` AND as module locals in `app.js` --
    and nothing ever called `set({panels})`. The panel would have rendered once at mount,
    when `state.panels` was still `[]`, and never again. Two variables of the same name in
    two modules, with nothing connecting them, is how a dead subscription looks from the
    inside: entirely reasonable.
    """
    written = _state_keys_written()
    subscribed = _state_keys_subscribed()

    # TEETH. This gate was green for three commits against a codebase that had the defect,
    # because nothing was subscribing yet. An empty check is not a passing check.
    assert subscribed, "no module subscribes to any state key -- this gate is checking nothing"
    assert len(written) >= 2, f"only {written} is ever written; the scan is broken, not the code"

    dead = {
        module: sorted(keys - written)
        for module, keys in subscribed.items()
        if keys - written
    }
    assert not dead, (
        "these modules subscribe to state keys that no set() call ever writes, so they "
        f"render once and then freeze: {dead}. Keys actually written: {sorted(written)}"
    )


def test_every_registered_contribution_module_is_imported_by_the_shell() -> None:
    """A contribution nobody imports is not registered, whatever its header says.

    `segments-panel.js` was written, committed, given a slot in `mountPanels()` and
    described in its own header as the proof that the registry worked. `app.js` never
    imported it, so `contributions(KINDS.PANEL)` never yielded it and the slot was never
    filled -- the static "none loaded" markup stayed on screen for the whole of its life.

    MOS-REL-108 is what makes this checkable: because the only way to register is a
    top-level import, the complete set of live contributions IS the import list.
    """
    shell = (VIEWER / "app.js").read_text(encoding="utf-8")
    imported = set(re.findall(r"from\s+['\"][^'\"]*?/([\w-]+\.js)|import\s+['\"][^'\"]*?/([\w-]+\.js)", shell))
    imported = {a or b for a, b in imported}

    registering = {
        path.name
        for path in sorted(SRC.rglob("*.js"))
        if re.search(r"\bregister\(\s*\{", _code(path.read_text(encoding="utf-8")))
    }

    assert registering, "no module calls register() -- this gate is checking nothing"
    orphans = sorted(registering - imported)
    assert not orphans, (
        f"these modules call register() but app.js never imports them, so their "
        f"contributions do not exist at runtime: {orphans}"
    )


def test_the_shell_does_not_render_into_a_panel_slot() -> None:
    """The slots belong to the panels mounted in them, and to nothing else.

    Both renderers wrote `el.segments`: the registered panel on mount, and app.js's
    `renderSidePanels` on every series and layout change. Whichever ran last won, and it was
    always app.js -- whose version printed the alignment counts with no warning state at
    all. A SEG with forty unmatched frames read as muted grey text indistinguishable from a
    clean match, which `MOS-SAFE-069` needs a reviewer to be able to tell apart before they
    can sensibly record a MODIFIED review.
    """
    shell = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    slots = re.findall(r"el\.(segments|measurements)\s*(?:\.innerHTML|\.appendChild)", shell)
    assert not slots, (
        f"app.js renders directly into panel slot(s) {sorted(set(slots))}; those elements "
        "belong to the registered panels mounted into them. Two renderers on one element "
        "resolve by ordering, and the loser is invisible."
    )


def test_every_class_a_panel_chooses_conditionally_is_actually_styled() -> None:
    """A class picked to make something look different must have a rule, or it does not.

    `segments-panel.js` chose `warn-text` for a SEG with unplaced frames and `muted` for a
    clean one. `warn-text` had no rule in `styles.css`, so the sentence "this overlay is
    incomplete, which is not the same as the model finding nothing there" rendered in plain
    body text -- the distinction existed in the DOM and nowhere the reader could see it.

    Only CONDITIONAL classes are checked. A class written unconditionally is decoration and
    its absence is cosmetic; a class chosen by a ternary exists precisely to signal that two
    states differ, and an unstyled one silently collapses them back together.
    """
    styles = (VIEWER / "styles.css").read_text(encoding="utf-8")
    styled = set(re.findall(r"\.([a-z][\w-]*)", styles))

    chosen: set[str] = set()
    for path in sorted(SRC.rglob("*.js")):
        code = _code(path.read_text(encoding="utf-8"))
        # A TERNARY IN A CLASS CONTEXT, not any ternary. "Only plausible class names" was
        # doing the filtering, and `'yes' : 'no'` in a CSV writer is a plausible class name
        # -- so exporting a column of yes/no made this gate demand CSS rules for `yes` and
        # `no`. What makes a string a class is where it is used, not what it looks like.
        for ternary in re.finditer(
            r"class(?:Name|List)?[^;\n]{0,90}?\?\s*'([^']*)'\s*:\s*'([^']*)'",
            code,
        ):
            for branch in ternary.groups():
                if re.fullmatch(r"[a-z][\w-]*(?:\s+[a-z][\w-]*)*", branch or ""):
                    chosen |= set(branch.split())

    # AND CLASSES TOGGLED ON A CONDITION. `classList.toggle('projecting', Boolean(x))` is
    # exactly as much a state signal as a ternary is, and the first version of this gate
    # read only ternaries -- so the marker that says a panel is showing a PROJECTION rather
    # than a slice could have gone unstyled without the gate noticing.
    for path in sorted(SRC.rglob("*.js")) + [VIEWER / "app.js"]:
        code = _code(path.read_text(encoding="utf-8"))
        for m in re.finditer(r"classList\.toggle\(\s*'([a-z][\w-]*)'\s*,", code):
            chosen.add(m.group(1))

    assert chosen, "no conditional class names found -- this gate is checking nothing"
    unstyled = sorted(c for c in chosen if c not in styled)
    assert not unstyled, (
        f"these classes are chosen conditionally but have no rule in styles.css, so the "
        f"states they distinguish look identical: {unstyled}"
    )


# --------------------------------------------------------------------------------------
# (0028,0004) PhotometricInterpretation: which end of the ramp is white
#
# Until this was added the viewer did not read the attribute at all. MONOCHROME1 -- the
# usual encoding for CR, DX and MG -- means the MINIMUM stored value displays as WHITE.
# Rendered as MONOCHROME2 the image comes out as its own negative: bone black, air white.
# Nothing crashes and nothing looks broken, which is what makes it the dangerous kind.
#
# Verified in a browser against a paired control: two DX instances with byte-identical
# pixel data differing only in (0028,0004), sampled across a row of the rendered canvas.
#
#     MONOCHROME1 as stored    252 -> 239 -> 229 -> 220 -> 207     descending
#     MONOCHROME2 as stored      3 ->  16 ->  26 ->  35 ->  48     ascending
#     MONOCHROME1 + invert       3 ->  16 ->  26 ->  35 ->  48     identical to MONO2
#     MONOCHROME2 + invert     252 -> 239 -> 229 -> 220 -> 207     identical to MONO1
#
# The two inverted rows are byte-identical to the two as-stored rows, which is what makes
# the composition an exact XOR rather than approximately one.
# --------------------------------------------------------------------------------------


def test_the_loader_reads_photometric_interpretation() -> None:
    """(0028,0004) decides polarity, and a viewer that does not read it guesses."""
    code = _code(_js("image", "volume.js"))
    assert "00280004" in code, (
        "volume.js does not read (0028,0004) PhotometricInterpretation. Every MONOCHROME1 "
        "series -- which is most CR, DX and MG -- then renders as its own negative."
    )
    assert "MONOCHROME1" in code, "the loader reads the tag but never names the value"


def test_polarity_is_applied_at_display_and_never_to_the_stored_array() -> None:
    """Inverting the stored array would silently negate every measurement in the viewer.

    `measure.js` computes HU from `frame.pixels` through slope and intercept. If the
    loader flipped the array to "fix" MONOCHROME1, every ROI mean and every caliper's
    underlying sample would be a number about a picture rather than about the patient --
    and it would look entirely reasonable. Polarity belongs to the display transform, and
    the shader already had the exact place for it: one line after windowing.
    """
    loader = _code(_js("image", "volume.js"))
    pixel_loop = loader[loader.index("const view = signed") : loader.index("const spacing")]
    for forbidden in ("1.0 -", "- view[", "invert", "~"):
        assert forbidden not in pixel_loop, (
            f"volume.js appears to alter stored values ({forbidden!r}) while reading pixel "
            "data. Stored values must reach measure.js exactly as the archive holds them."
        )
    assert "photometric" in _code(_js("render", "viewport.js")), (
        "viewport.js does not consider photometric interpretation, so the loader's reading "
        "of (0028,0004) reaches nothing that draws."
    )


def test_reader_invert_composes_with_photometric_rather_than_replacing_it() -> None:
    """A MONOCHROME1 image shown per spec is CORRECT, not inverted.

    So the invert button must still mean "show me the other polarity" rather than becoming
    a no-op on half the modalities. The two facts XOR: what the data says, and what the
    reader asked for. Assigning either one directly to the uniform would break one of them.
    """
    code = _code(_js("render", "viewport.js"))
    line = next(
        (ln for ln in code.splitlines() if "u_invert" in ln and "uniform1i" in ln), ""
    )
    assert line, "viewport.js no longer sets the u_invert uniform"
    assert "!==" in line or "^" in line, (
        f"u_invert is set from {line.strip()!r}, which is not a composition of the reader's "
        "toggle with the data's own encoding. One of the two is being ignored."
    )


def test_a_series_mixing_photometric_interpretations_is_refused() -> None:
    """One invert flag covers the stack, so a mixed series renders half of itself negated.

    And scrolling through it would look like a window change rather than a fault, which is
    why this is refused the way mixed geometry is rather than rendered with a warning.
    """
    code = _code(_js("image", "volume.js"))
    assert "mixed_photometric_interpretation" in code, (
        "buildStack does not refuse a series that mixes MONOCHROME1 and MONOCHROME2"
    )


def test_a_non_grayscale_image_is_refused_rather_than_read_as_grayscale() -> None:
    """PALETTE COLOR or RGB read as one channel is not a degraded picture, it is a different one."""
    code = _code(_js("image", "volume.js"))
    assert "unsupported_photometric_interpretation" in code, (
        "buildStack accepts any photometric interpretation it does not recognise"
    )
    assert "unsupported_samples_per_pixel" in code, (
        "buildStack does not check (0028,0002) SamplesPerPixel; interleaved samples read "
        "as a single channel produce a plausible-looking stripe pattern"
    )


# --------------------------------------------------------------------------------------
# (0028,0008) NumberOfFrames: one instance can be a whole acquisition
#
# The loader computed `rows * columns` and read exactly that many values, so an Enhanced CT
# or MR instance became a stack of depth 1 and the other N-1 frames were discarded in
# silence. `seg.js` has read the tag since it was written, because a SEG is always
# multi-frame -- so a multi-frame image carrying a segmentation would have matched a
# hundred SEG frames against a stack one slice deep.
#
# Verified against a paired control (tests/_support/multiframe_probe.py): two instances,
# identical pixel data and frame counts, differing only in whether the frames carry
# positions. Frame k is filled with k*100, so one sample proves both count and order.
#
#                        enhanced                      cine
#     depth              12       (was 1)              12       (was 1)
#     frame k centre     0,100,500,1100               0,100,500,1100
#     spatial            true                         false
#     sliceSpacing       2.5 mm                       0
#     coronal            built 64x12, [2.5, 0.7]      REFUSED
#
# The cine's sliceSpacing of 0 is the whole argument for the refusal: mpr.js would have
# built a reconstruction on a zero-millimetre axis and labelled the result in millimetres.
# --------------------------------------------------------------------------------------


def test_the_loader_reads_number_of_frames() -> None:
    """One instance can carry N frames, and a loader that assumes one shows 1 of N."""
    code = _code(_js("image", "volume.js"))
    assert "00280008" in code, (
        "volume.js does not read (0028,0008) NumberOfFrames, so every multi-frame instance "
        "-- Enhanced CT and MR, US cine, XA -- renders as a single slice with the rest "
        "silently discarded. seg.js has always read it; the image loader did not."
    )


def test_multi_frame_geometry_follows_the_functional_group_precedence() -> None:
    """Per-frame group, then shared group, then the top-level dataset. PS3.3 C.7.6.16.

    Falling back to the top level is what lets a single-frame instance run through the
    same code path rather than a parallel one, and a parallel path is how the two drift.
    """
    code = _code(_js("image", "volume.js"))
    for tag, what in (("52009230", "PerFrameFunctionalGroupsSequence"),
                      ("52009229", "SharedFunctionalGroupsSequence")):
        assert tag in code, f"volume.js does not read ({tag}) {what}"


def test_a_truncated_multi_frame_is_refused_rather_than_read_as_far_as_it_goes() -> None:
    """A short read gives a stack whose depth disagrees with its own header.

    And every position-matched overlay after the cut lands on the wrong slice, which is
    the failure `seg.js` spends its whole alignment section preventing.
    """
    assert "truncated_pixel_data" in _code(_js("image", "volume.js"))


def test_a_reconstruction_is_refused_when_frames_are_separated_by_time() -> None:
    """A cine loop reslices into seconds-as-millimetres, and it looks like anatomy.

    `mpr.js` resamples the third axis using `sliceSpacing`. On a stack with no per-frame
    positions that value is 0 and the axis is time, so the coronal view is one image row
    plotted against seconds, drawn with a millimetre scale. A caliper across it returns a
    distance for a duration -- a number about nothing, presented exactly like a number
    about the patient.
    """
    code = _code(_js("image", "mpr.js"))
    assert "spatial" in code, (
        "mpr.js reslices without checking whether the frames are separated by distance"
    )
    assert "reconstruction_needs_spatial_frames" in code


def test_the_reconstruction_guard_is_on_the_action_not_only_the_control() -> None:
    """Disabling the button and leaving the keyboard live is a half-conversion.

    `setPlane` has two call sites: the toolbar button and the `c`/`s` shortcuts. Guarding
    only the button would produce a surface that looks like it refuses while the shortcut
    still throws -- the same shape as the measurements panel updating while the annotation
    layer kept drawing, and as the segments panel that was registered but never imported.
    """
    shell = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    body = shell[shell.index("function setPlane(") : shell.index("function buildPlaneButtons(")]
    # THROUGH THE ENUMERATION. setPlane used to restate two of the four conditions inline,
    # which is how the other two came to have no guard on the action at all -- a Coronal
    # key on a series with a per-frame Modality LUT threw straight out of draw.
    assert "reconstructionRefusal(p.stack, plane)" in body, (
        "setPlane does not ask the module why a plane is refused, so the c/s shortcuts "
        "bypass whatever the toolbar does about reconstructions the data cannot support"
    )
    assert re.search(r"if \(refusal\)", body), (
        "setPlane asks for the refusal and then proceeds anyway"
    )


# --------------------------------------------------------------------------------------
# reslice() hand-picked its fields, and everything it forgot was lost in silence
#
# `app.js:268` draws `reslice()`'s output, never a frame from `buildStack` directly. The
# function used to construct a NEW object listing the fields it copied -- pixels, rows,
# columns, pixelSpacing, overlay, slope, intercept -- so every field added to a frame in
# volume.js was a field somebody had to remember to add here as well. Three defects came
# out of that single habit:
#
#   photometric      dropped, so viewport read undefined and drew every MONOCHROME1 study
#                    as MONOCHROME2. The polarity fix in 1e061bf was dead on the real draw
#                    path from the moment it was committed, because it was verified against
#                    `stack.frames[0]` -- which is not what the application draws.
#   slope/intercept  taken from slice 0 even on the axial plane, where the frame's own
#                    values were to hand.
#   sopInstanceUID   dropped, so every measurement recorded provenance of null.
#
# Measured on the real path, before and after:
#
#     direct frame (what the old probe tested)   252 -> 229 -> 207
#     via reslice  (what app.js draws)  before     3 ->  26 ->  48    <- inverted
#     via reslice                        after   252 -> 229 -> 207
# --------------------------------------------------------------------------------------


def _reslice_body() -> str:
    code = _code(_js("image", "mpr.js"))
    return code[code.index("export function reslice("):]


def test_the_axial_plane_is_the_frame_itself_not_a_copy_of_chosen_fields() -> None:
    """A spread cannot forget a field that does not exist yet. That is the whole argument.

    The axial plane IS a frame -- `reslice` selects it rather than resampling anything --
    so rebuilding it from a list of remembered names buys nothing and costs a silent drop
    every time a frame gains a property.
    """
    body = _reslice_body()
    axial = body[body.index("if (plane === PLANES.AXIAL)"):]
    axial = axial[: axial.index("return") + 220]
    assert "...f" in axial, (
        "reslice's axial branch rebuilds the frame from named fields instead of spreading "
        "it. Every property volume.js adds to a frame then has to be remembered here, and "
        "forgetting one is invisible -- that is how the MONOCHROME1 fix shipped dead."
    )


def test_a_reconstructed_plane_carries_every_property_the_renderer_reads() -> None:
    """A coronal plane is built, not selected, so what it carries is a deliberate list.

    This gate reads that list against what `viewport.js` actually reaches for on a frame,
    so a new uniform the shader starts consuming cannot silently arrive as undefined on
    two planes out of three.
    """
    renderer = _code(_js("render", "viewport.js"))
    read = set(re.findall(r"this\.frame\.(\w+)", renderer))
    assert read, "viewport.js reads nothing off this.frame -- the scan is broken"

    body = _reslice_body()
    missing = sorted(p for p in read if p not in body)
    assert not missing, (
        f"viewport.js reads {missing} off the frame, and reslice() never sets it on a "
        "reconstructed plane, so those planes get undefined. photometric was exactly this."
    )


def test_a_reconstructed_plane_disclaims_the_provenance_it_does_not_have() -> None:
    """A plane cut through every slice belongs to no instance, and must say so.

    Inheriting slice 0's SOPInstanceUID would attach one instance's identity to a plane
    drawn from all of them -- a provenance claim that is simply false, and `measure.js`
    records it as the source of a measurement.
    """
    body = _reslice_body()
    assert re.search(r"sopInstanceUID:\s*null", body), (
        "reslice() does not explicitly null sopInstanceUID for a reconstructed plane, so "
        "it either inherits slice 0's identity or arrives undefined"
    )


def test_a_reconstruction_checks_the_rescale_it_used_to_assume() -> None:
    """The old code asserted uniform rescale in a comment and used slice 0's without looking.

    Resampling across frames that map stored values differently produces a plane whose
    voxels are in two scales at once, and one HU readout over it describes neither.
    """
    body = _reslice_body()
    # THE ENUMERATION, and that reslice raises from it. The check moved out of reslice's
    # body so the toolbar could ask the same question -- two of the four refusals had no
    # surface guard at all, so a Coronal button was offered on a series reslice would throw
    # on, and `draw` has no try.
    whole = _code(_js("image", "mpr.js"))
    refusals = whole[whole.index("export function reconstructionRefusal("):]
    refusals = refusals[: refusals.index("\nexport function")]
    for code in (
        "reconstruction_needs_spatial_frames", "spacing_non_uniform",
        "gantry_tilt_uncorrectable", "reconstruction_needs_uniform_rescale",
    ):
        assert code in refusals, (
            f"reconstructionRefusal does not enumerate {code}, so whichever caller checks "
            f"it separately is the only one that knows about it"
        )
    assert "reconstructionRefusal(stack, plane)" in body, (
        "reslice() resamples across frames without asking the enumeration, so it and the "
        "toolbar can refuse different things"
    )


def test_the_modality_lut_and_window_come_from_the_functional_groups_too() -> None:
    """Geometry was read from the groups and rescale from the dataset. Half a precedence.

    On an Enhanced instance the Modality LUT lives in (0028,9145)
    PixelValueTransformationSequence and the window in (0028,9132) FrameVOILUTSequence,
    and both are usually ABSENT from the top level. A loader that resolves position,
    orientation and spacing through the functional groups but reaches for the dataset for
    slope and intercept produces perfect geometry and slope 1 / intercept 0 -- raw stored
    values wearing a Hounsfield label, which is the same wrong-number class as labelling
    a PET activity concentration "HU".

    Measured with tests/_support/multiframe_probe.py, whose enhanced member carries
    rescale and window ONLY in the groups:

        enhanced   1 / -1024   stored 500 -> -524 HU   window 350/1500
        cine       1 / 0       stored 500 ->  500      window 600/1400  (top level)
    """
    code = _code(_js("image", "volume.js"))
    for tag, what in (("00289145", "PixelValueTransformationSequence"),
                      ("00289132", "FrameVOILUTSequence")):
        assert tag in code, f"volume.js does not read ({tag}) {what}"

    # The tags being present is not enough: they have to be routed through the SAME
    # precedence helper the geometry uses, or they resolve from the top level anyway.
    for element in ("RESCALE_SLOPE", "RESCALE_INTERCEPT", "WINDOW_CENTER", "WINDOW_WIDTH"):
        assert re.search(rf"fromGroups\([^)]*{element}\)", code), (
            f"{element} is not resolved through fromGroups, so it reads the top-level "
            "dataset and ignores the functional group that actually carries it"
        )


# --------------------------------------------------------------------------------------
# (0028,0103) PixelRepresentation = 0: unsigned values do not fit a signed texture
#
# The loader read the attribute and built the correct Uint16Array. Then the renderer did
# `new Int16Array(frame.pixels)` on the way to an R16I texture, and `volumeOf` allocated an
# Int16Array for the MPR volume. Both conversions are element-wise and WRAP: a stored 49344
# becomes -16192. Measured on a full-range unsigned ramp, the cliff is exactly at 32768:
#
#     stored 28784 -> expected 112, rendered 112
#     stored 32896 -> expected 128, rendered   0      <- everything above here was black
#     stored 61680 -> expected 240, rendered   0
#
# After the fix, worst error across the whole range: 0.
#
# THE FIX IS AN OFFSET, NOT A WIDER TEXTURE. Storing (u - 32768) fits every unsigned value
# in Int16 exactly, and the shader recovers the original meaning by adding slope * 32768 to
# the intercept. An R16UI texture would need a second sampler and a second shader path,
# which is two things to keep agreeing about windowing.
#
# This was not exotic: the demo phantom's CT is itself Uint16Array with intercept -1024.
# It never tripped the wrap only because its values stay under 32767.
# --------------------------------------------------------------------------------------


def test_unsigned_pixels_are_not_wrapped_on_the_way_to_a_signed_texture() -> None:
    """`new Int16Array(uint16)` converts element-wise and says nothing when it wraps."""
    code = _code(_js("render", "viewport.js"))
    assert not re.search(r"new Int16Array\(\s*frame\.pixels\s*\)", code), (
        "viewport.js converts the stored array straight into Int16Array, which wraps every "
        "unsigned value above 32767 into a large negative and renders it black"
    )
    assert "storedOffset" in code, (
        "viewport.js has no offset for unsigned data, so either it wraps or it silently "
        "depends on the values happening to stay under 32767"
    )


def test_the_offset_is_undone_in_the_intercept_so_hu_is_unchanged() -> None:
    """slope*(u-32768) + (intercept + slope*32768) == slope*u + intercept, exactly.

    An offset applied to the texture and NOT undone in the uniform would shift every
    displayed value by 32768 * slope -- a picture that is uniformly wrong rather than
    half wrong, which is easier to notice but no more correct.
    """
    code = _code(_js("render", "viewport.js"))
    line = next((ln for ln in code.splitlines() if "u_intercept" in ln and "uniform1f" in ln), "")
    assert "storedOffset" in line, (
        f"the intercept uniform is set from {line.strip()!r}, which does not undo the "
        "offset setFrame applied, so every unsigned study renders shifted by 32768*slope"
    )


def test_the_offset_never_reaches_the_array_measurements_are_taken_from() -> None:
    """`measure.js` reads frame.pixels for every ROI and caliper.

    Offsetting there would move the defect out of the picture and into the numbers, which
    is strictly worse: a wrong image is looked at, a wrong measurement is recorded.
    """
    code = _code(_js("render", "viewport.js"))
    assert not re.search(r"frame\.pixels\[\w+\]\s*(?:-=|\+=|=)", code), (
        "viewport.js writes into frame.pixels; that array is what measure.js reports HU "
        "from, and the display offset must not touch it"
    )


def test_the_reconstruction_volume_follows_the_source_array_type() -> None:
    """A hardcoded Int16Array volume wraps unsigned data on every reconstructed plane.

    And the wrapped value is what the HU readout reports there, so the defect reaches the
    numbers rather than only the picture.
    """
    code = _code(_js("image", "mpr.js"))
    assert not re.search(r"new Int16Array\(frame \* depth\)", code), (
        "volumeOf allocates a hardcoded Int16Array, so unsigned stacks wrap into it"
    )
    assert not re.search(r"new Int16Array\((?:columns|rows) \* depth\)", code), (
        "a reconstruction buffer is hardcoded to Int16Array, so unsigned values wrap"
    )


# --------------------------------------------------------------------------------------
# What the numbers are numbers OF — (0008,0060), (0028,1054), (0054,1001)
#
# The viewer wrote the literal "HU" in three places and none of them consulted the
# modality. (0008,0060) sat in the tag table read by nothing; Units and RescaleType were
# not read at all. So a PET activity concentration rendered as "12500 HU" and an MR's
# arbitrary stored value rendered as "1044 HU" — arithmetically correct numbers under
# labels that are a category error, since there is no Hounsfield scale on either.
#
# Measured on three instances with IDENTICAL pixels and identical rescale, differing only
# in what the header says about units (tests/_support/units_probe.py):
#
#     CT   RescaleType HU            ->  20 HU
#     PT   Units BQML                ->  20 BQML
#     MR   RescaleType US, no Units  ->  20 · unit not recorded
#
# One number, three labels. Before the change, three identical labels.
# --------------------------------------------------------------------------------------


def test_the_unit_is_read_from_the_header_not_assumed_from_the_pipeline() -> None:
    """Three attributes decide this, and none of them was read."""
    loader = _code(_js("image", "volume.js"))
    for tag, what in (("00080060", "Modality"),
                      ("00281054", "RescaleType"),
                      ("00541001", "Units")):
        assert tag in loader, f"volume.js does not read ({tag}) {what}"
    assert "valueUnit" in loader, "the loader reads the attributes but derives no unit from them"


def test_no_renderer_hardcodes_a_unit() -> None:
    """A unit written into a template string is a unit nothing can correct.

    All three renderers had "HU" inline. They are not three bugs — they are one decision
    taken three times, which is why the fix is one function they all ask.
    """
    offenders = []
    for path in sorted(list(SRC.rglob("*.js")) + [VIEWER / "app.js"]):
        if path.name == "units.js":
            continue          # the one module allowed to name a unit is the one deriving it
        code = _code(path.read_text(encoding="utf-8"))
        for match in re.finditer(r"[`'\"][^`'\"]*\bHU\b[^`'\"]*[`'\"]", code):
            offenders.append(f"{path.name}: {match.group(0)[:60]}")
    assert not offenders, (
        "these render a hardcoded unit instead of asking units.js, so they print it on "
        f"every modality the viewer can open: {offenders}"
    )


def test_the_default_window_is_on_the_scale_the_series_is_on() -> None:
    """400/40 is a Hounsfield answer and it was given to everything.

    The gate above stops a unit being RENDERED without asking. This is the same decision
    one layer down and it went the other way for longer: `pickWindow` returned
    `{center: 40, width: 400}` for any series with no (0028,1050)/(0028,1051), on any
    modality, on any scale. It is a soft-tissue window in HU and it is right on CT.

    MEASURED on the synthetic PET this repository now seeds -- a concentration in BQML
    with a body background of 1200 and a lesion at 24000. W 400 / L 40 puts every one of
    those past the top of the ramp, and the panel rendered as a WHITE RECTANGLE.
    `presets.json` records the identical failure from the other side: the Brain window on
    brain MR "whites the panel out entirely". The machinery added then refuses a HU PRESET
    on a non-HU series, while the DEFAULT went on handing one out.

    WHAT REPLACED IT, and the two things that were wrong with the first attempt:

      1. ONE SLICE IS NOT A VOLUME. Reading `frames[0]` put the window on the PET's first
         slice, which is uniform background: both percentiles came out 1200, the width
         came out 0, and the lesion -- on four slices out of thirty-two -- was invisible
         to the window meant to show it.
      2. A PERCENTILE TOP ERASES THE SIGNAL. The lesion is about 0.011% of the volume, so
         the 98th percentile is the background and so is the 99.9th. On PET the signal IS
         the rare bright thing; a robust estimator of the bulk estimates the part nobody
         is looking at. The bottom still takes a percentile, where robustness is what is
         wanted.
    """
    loader = _code(_js("image", "volume.js"))

    assert "function windowFromData(" in loader, (
        "there is no data-derived window, so a series on a scale with no convention gets "
        "a Hounsfield one"
    )
    assert "deriveUnit(frame) === HOUNSFIELD" in loader, (
        "`pickWindow` does not ask what scale the series is on before returning the CT "
        "soft-tissue pair"
    )
    assert "pickWindow(frames[0], frames)" in loader, (
        "the default window is derived from one slice; the lesion on a PET lives on a "
        "handful of them and a window taken from the first is a window of the background"
    )

    derived = _fnbody(loader, "function windowFromData(")
    assert "frames.length" in derived, "the derivation never looks past one frame"
    assert "kept[kept.length - 1]" in derived, (
        "the top of the window is a percentile, which on PET is the background: the "
        "lesion is a fraction of a percent of the volume and every percentile robust "
        "enough to reject an outlier also rejects it"
    )
    assert "at(0.02)" in derived, (
        "the bottom of the window is not a percentile, so one dead voxel sets it"
    )
    assert "if (v !== 0) kept.push(v)" in derived, (
        "zero-valued background is included, so the low end of the window lands outside "
        "the patient and half the ramp is spent on air"
    )
    assert "width: 1" in derived, (
        "a frame with no spread returns width 0, which the shader divides by"
    )


def test_a_measurement_carries_the_unit_it_was_taken_in() -> None:
    """A row in the panel outlives the frame it was taken on.

    The reader scrolls and changes series; the row stays. A panel that looked the unit up
    from the CURRENT frame would silently relabel an old measurement — which is worse than
    the bug being fixed, because it changes a number's meaning after it was recorded.
    """
    code = _code(_js("image", "measure.js"))
    body = code[code.index("export function describeMeasurement("):]
    assert "valueUnit" in body[:800], (
        "describeMeasurement does not record the unit on the measurement, so the panel has "
        "to guess it from whatever frame is on screen when it renders"
    )


#: Fields derived on the STACK rather than carried on a frame, so a spread cannot supply
#: them and each of reslice's branches has to name them explicitly. `photometric` is NOT
#: one of them — volume.js writes it onto every frame, so `...f` carries it — and putting
#: it here made this gate demand it be named twice over.
_STACK_DERIVED = frozenset({"valueUnit"})


def test_every_frame_consumer_reads_only_fields_reslice_sets() -> None:
    """The general form of the defect that killed the MONOCHROME1 fix.

    An earlier gate checked this for `viewport.js` alone, and `valueUnit` proved that was
    too narrow: it is derived on the STACK, so the axial spread cannot carry it and it has
    to be named in both of reslice's branches. measure.js and annotations.js read it and
    viewport.js does not, so a viewport-only gate would have watched the wrong file.
    """
    body = _reslice_body()
    consumers = ["image/measure.js", "render/annotations.js", "render/transform.js",
                 "render/viewport.js"]
    read: set[str] = set()
    for rel in consumers:
        code = _code(_js(*rel.split("/")))
        read |= set(re.findall(r"\bframe\.(\w+)", code))
        read |= set(re.findall(r"this\.frame\.(\w+)", code))
        # AND THROUGH AN ALIAS. `render()` does `const f = this.frame` and then reads
        # `f.voiFunction`, which the two patterns above do not see — so the gate passed
        # while a reconstructed plane was getting `undefined` for the transfer function its
        # own axial rendered with. A gate that only recognises one spelling of a read is a
        # gate that can be walked around without meaning to.
        for alias in set(re.findall(r"const (\w+) = this\.frame;", code)):
            read |= set(re.findall(rf"\b{alias}\.(\w+)", code))

    assert len(read) >= 4, f"only {read} read off a frame anywhere — the scan is broken"

    # EACH BRANCH SEPARATELY, and the first version of this gate did not do that. It asked
    # whether the name appeared anywhere in reslice, so a field set in the axial branch and
    # forgotten in the reconstruction branch passed — which is the exact defect shape being
    # guarded against, one plane out of three silently undefined. The proof-by-breaking run
    # caught it: deleting `valueUnit` from the reconstruction branch left the gate green.
    # The split is `common` — the object both reconstruction branches spread — which sits
    # immediately after the axial branch returns. It used to be the uniform-rescale check,
    # until that moved into `reconstructionRefusal` so the toolbar could ask it too, and
    # this gate went looking for a line that no longer existed. Splitting at `volumeOf`
    # instead would cut `common` out of the section that spreads it.
    cut = body.index("if (plane === PLANES.AXIAL)")
    recon = body.index("const common = {")
    axial = body[cut:recon]
    reconstruction = body[recon:]

    for label, section in (("axial", axial), ("reconstruction", reconstruction)):
        # The axial branch spreads the frame, so anything the frame itself carries is
        # covered there; only stack-derived fields have to be named.
        #
        # MATCHED PRECISELY, because `"...f" in section` was true of `...fill` — a spread
        # introduced by the padding work — and that silently turned this whole check off
        # for the reconstruction branch. The gate then passed while `voiFunction` was
        # missing from it, which is exactly the omission it exists to catch. A substring
        # test on a spread operator is a gate with a wildcard in it.
        spreads = bool(re.search(r"\.\.\.f\b", section))
        missing = sorted(
            f for f in read
            if f not in section and not (spreads and f not in _STACK_DERIVED)
        )
        assert not missing, (
            f"frame consumers read {missing}, and reslice()'s {label} branch does not set "
            "it, so those fields arrive undefined on the planes that branch draws"
        )


# --------------------------------------------------------------------------------------
# A segmentation whose bitstream stops half way
#
# `decodeSegmentation` unpacks one bit per pixel out of a Uint8Array. Past its end the
# index is `undefined`, `undefined >> n` is 0, and every remaining pixel becomes
# background. So a short bitstream drew fully on the early slices and not at all on the
# late ones, threw nothing, and incremented nothing — `matchedBy` counted every frame as
# matched and `unmatched` stayed 0.
#
# Measured on a SEG declaring four frames and carrying two (tests/_support/
# seg_truncation_probe.py), against the same object carrying all four:
#
#     whole    pixels per slice  1024, 1024, 1024, 1024    unmatched 0
#     short    pixels per slice  1024, 1024,    0,    0    unmatched 0
#
# Both printed "aligned: 4 by SOP reference, 0 by position, 0 unmatched". The panel's
# reassurance was identical over a complete mask and a mask that stopped.
# --------------------------------------------------------------------------------------


def test_the_segmentation_bitstream_is_long_enough_for_the_frames_it_claims() -> None:
    """Unpacking past the end of a Uint8Array yields background, not an error."""
    code = _code(_js("image", "seg.js"))
    assert "truncated_segmentation_pixels" in code, (
        "seg.js unpacks the bitstream without checking its length, so a short one leaves "
        "the last frames blank while every counter reports a complete overlay"
    )


def test_the_declared_frame_count_is_cross_checked_against_the_functional_groups() -> None:
    """(0028,0008) and the per-frame groups can disagree, and guessing is not available.

    The loop iterates the groups; the header says how many frames there are. When they
    differ, one of the two is wrong and picking either would put a mask on slices nothing
    in the object accounts for.
    """
    code = _code(_js("image", "seg.js"))
    assert "segmentation_frame_count_disagrees" in code, (
        "seg.js does not compare (0028,0008) with the per-frame functional group count"
    )


def test_the_image_and_segmentation_paths_agree_about_truncation() -> None:
    """One of these refused a short bitstream by name and the other did not.

    `volume.js` has refused `truncated_pixel_data` since multi-frame support landed. The
    SEG path had the identical failure and no check, which is the worse half of the pair:
    an image that silently loses frames is visibly shorter, and a mask that silently loses
    frames looks like a model that found less.
    """
    for module, reason in (("volume.js", "truncated_pixel_data"),
                           ("seg.js", "truncated_segmentation_pixels")):
        code = _code(_js("image", module))
        assert reason in code, f"{module} does not refuse a truncated bitstream"


def test_no_module_declares_a_dicom_tag_it_never_reads() -> None:
    """A tag in the table and in no code path is an attribute somebody meant to honour.

    This is the general form of two defects already fixed. `MODALITY` sat in volume.js's
    table read by nothing while three renderers hardcoded "HU"; `NUMBER_OF_FRAMES` sat in
    seg.js's table read by nothing while the unpack loop ran off the end of its array. In
    both cases the table recorded an intention the code had not carried out, and the table
    is exactly where that is cheap to see.
    """
    unread: dict[str, list[str]] = {}
    scanned = 0
    for path in sorted(SRC.rglob("*.js")):
        code = _code(path.read_text(encoding="utf-8"))
        table = re.search(r"const T = \{(.*?)\n\};", code, re.S)
        if not table:
            continue
        scanned += 1
        # A tag MAY stay unread when the source says why, on a `// unread:` comment right
        # above it. That keeps the justification where a reviewer meets the tag instead of
        # in a test file nobody reads while editing the table — and it keeps the gate from
        # being satisfied by silence.
        raw = re.search(
            r"const T = \{(.*?)\n\};", path.read_text(encoding="utf-8"), re.S
        )
        justified = set(
            re.findall(
                r"// unread:(?:[^\n]*\n)(?:\s*//[^\n]*\n)*\s*([A-Z][A-Z0-9_]*)\s*:",
                raw.group(1),
            )
        )
        names = re.findall(r"^\s*([A-Z][A-Z0-9_]*)\s*:", table.group(1), re.M)
        body = code[table.end():]
        missing = sorted(n for n in names if f"T.{n}" not in body and n not in justified)
        if missing:
            unread[path.name] = missing

    # TEETH ON THE SCAN, not on the finding. An earlier version asserted that unread tags
    # were FOUND, which meant the gate failed the moment every tag was read or justified --
    # it could only pass while the defect existed. What has to be non-empty is the set of
    # tables looked at.
    assert scanned >= 3, f"only {scanned} tag table(s) scanned — the scan is broken, not the code"
    assert not unread, (
        f"these modules declare DICOM tags that no code path reads: {unread}. A tag in the "
        "table and nowhere else records an intention nobody carried out."
    )


# --------------------------------------------------------------------------------------
# (0028,0120) PixelPaddingValue: pixels that carry no measurement
#
# A CT pads outside the reconstruction circle, and an ROI that overlaps it averaged those
# pixels into the mean. Measured on one image with the attribute declared and the same
# pixels with it absent, using the identical ROI (tests/_support/padding_probe.py):
#
#     declares (0028,0120)      20 HU ± 0     489 measured, 140 excluded
#     declares nothing        −212 HU ± 434   629 measured,   0 excluded
#
# The second is the average of tissue and not-tissue. It is arithmetically correct, looks
# like fat or fluid, and describes nothing.
# --------------------------------------------------------------------------------------


def test_pixel_padding_is_read_and_excluded_from_region_statistics() -> None:
    """Padding is not tissue, and a mean that includes it is about nothing."""
    loader = _code(_js("image", "volume.js"))
    assert "00280120" in loader, "volume.js does not read (0028,0120) PixelPaddingValue"
    assert "00280121" in loader, (
        "volume.js does not read (0028,0121) PixelPaddingRangeLimit, so a padding RANGE "
        "is treated as a single value and most of it enters the mean"
    )
    # INSIDE regionStatistics, not merely defined in the file. The first version of this
    # gate asked whether `isPadding` existed anywhere in the module, so deleting the CALL
    # and leaving the function passed it — a gate satisfied by a definition nothing uses,
    # which is the same shape as the tag tables it sits beside.
    stats = _code(_js("image", "measure.js"))
    body = stats[stats.index("export function regionStatistics("):]
    body = body[: body.index("\n}")]
    assert "notMeasuredAt(frame)" in body, (
        "regionStatistics never builds the not-measured predicate, so padding still enters "
        "the mean however the predicate is written"
    )
    assert re.search(r"notMeasured\(y \* frame\.columns \+ x\)", body), (
        "regionStatistics never applies the predicate, so padding still enters the mean"
    )

    # BOTH KINDS. A declared (0028,0120) is a VALUE; a resampled plane's overhang is a
    # per-pixel MASK, because the only values available to fill it with are the declared
    # padding or the volume's minimum -- and that minimum is real acquired air.
    units = _code(_js("image", "units.js"))
    pred = units[units.index("export function notMeasuredAt("):]
    pred = pred[: pred.index("\n}")]
    assert "paddingTest(frame)" in pred, "the declared padding value is no longer consulted"
    assert "outside[index] === 1" in pred, (
        "the out-of-volume mask is ignored, so either the overhang is averaged in as tissue "
        "or -- if it is declared by value instead -- real air at the volume minimum is "
        "excluded from every ROI on the plane"
    )


def test_the_padding_test_is_on_the_stored_value_not_the_rescaled_one() -> None:
    """(0028,0120) is defined in stored units.

    Comparing it against a rescaled value is comparing two scales — right on a slope of 1
    and wrong everywhere else, which is the kind of defect that survives every test written
    against CT and appears the first time a PET is opened.
    """
    code = _code(_js("image", "units.js"))
    body = code[code.index("export function paddingTest("):]
    body = body[: body.index("\n}")]
    for scale in ("slope", "intercept", "huAt"):
        assert scale not in body, (
            f"paddingTest mentions `{scale}`, so it is rescaling before comparing against a "
            f"threshold that is defined in stored units"
        )

    # AND EVERY CALLER HANDS IT A STORED VALUE. A pure predicate is half of it; a caller
    # that rescaled first would reintroduce the defect from the other side, and the
    # predicate has no way to notice.
    fed = {
        "measure.js": ["notMeasuredAt(frame)"],
        "mpr.js": ["isPad(out[", "isPad(v)"],
    }
    for name, forms in fed.items():
        consumer = _code(_js("image", name))
        assert re.search(r"(paddingTest|notMeasuredAt)\(", consumer), (
            f"{name} no longer asks the shared predicate"
        )
        assert any(f in consumer for f in forms), (
            f"{name} builds the padding predicate but no call site applies it to a raw "
            f"stored array, so what it is testing cannot be told from the code"
        )


def test_padding_is_decided_by_one_predicate_and_not_reimplemented() -> None:
    """Two spellings of "is this padding" is how two answers to it come about.

    `measure.js` excluded padding from an ROI mean for nine commits before `mpr.js` needed
    the same question answered for slab projection. Had the second consumer written its own
    comparison, the range-limit case — (0028,0121), a padding RANGE rather than a single
    value — would have been handled in one and not the other, and a min-IP would have drawn
    the out-of-field corner over the anatomy while the ROI on top of it read clean.

    Same argument `MOS-UI-029` makes for REJECTED/FAILED: one decision point, every
    consumer asks it.
    """
    assert "export function paddingTest(" in _js("image", "units.js")

    offenders = []
    for path in sorted(SRC.rglob("*.js")):
        if path.name == "units.js":
            continue
        code = _code(path.read_text(encoding="utf-8"))
        # BOTH SIDES. The first version of this scan only matched `paddingValue ===`,
        # and its own break test -- `v === declaring.paddingValue` -- walked straight
        # through it. A gate that has not been shown red is a gate with no teeth.
        op = r"===|!==|==|!=|<=|>=|<|>"
        both = rf"(?:[\w.]*paddingValue\s*(?:{op})|(?:{op})\s*[\w.]*paddingValue)"
        for m in re.finditer(both, code):
            near = code[max(0, m.start() - 60):m.end() + 60]
            # A comparison of two DECLARATIONS is not a padding test. A comparison against
            # something read out of the pixel data is.
            if re.search(r"(pixels|volume|px|out|stored)\s*\[|\bstored\b", near):
                offenders.append(f"{path.name}: {m.group(0).strip()!r}")

    assert not offenders, (
        "these compare against paddingValue directly instead of calling paddingTest, so "
        f"there is more than one answer to what padding is: {offenders}"
    )


def test_excluded_pixels_are_reported_rather_than_silently_dropped() -> None:
    """Dropping them silently makes the area disagree with the shape on screen.

    The area beside the mean is the measured count times the pixel area, so an ROI drawn
    over 629 pixels that reports 489 has to say where the other 140 went — otherwise the
    number and the drawing contradict each other and the reader cannot tell which is wrong.
    """
    assert "excluded" in _code(_js("image", "measure.js")), (
        "regionStatistics does not report how many pixels it left out"
    )
    assert "paddingNote" in _code(_js("image", "units.js")), (
        "there is no shared formatter for the exclusion, so the two renderers would each "
        "decide separately whether to mention it"
    )
    for module in (("render", "annotations.js"), ("ui", "measurements-panel.js")):
        assert "paddingNote" in _code(_js(*module)), (
            f"{module[1]} does not surface the excluded count, so an ROI that measured "
            "fewer pixels than it covers says nothing about why"
        )


# --------------------------------------------------------------------------------------
# Slice pitch measured from the first two slices and applied to all of them
#
# `sliceSpacing` was `abs(frames[1].depth - frames[0].depth)`. It feeds the reconstruction's
# craniocaudal axis, the SEG position-matching tolerance and the HUD, so a series with a gap
# reported the pitch of its first pair and closed the gap silently.
#
# Measured on two stacks of six slices with identical pixels (tests/_support/spacing_probe.py):
#
#     even    z = 0,2,4,6,8,10     gaps 2–2 mm    uniform    extent 10 mm, true 10 mm
#     gapped  z = 0,2,4,14,16,18   gaps 2–10 mm   not        extent 10 mm, true 18 mm
#
# Both report sliceSpacing 2, which is what the old code computed from the first pair. The
# number was never wrong; what was missing was knowing it does not apply. A caliper down
# that reconstruction would have read 10 mm where the anatomy spans 18.
# --------------------------------------------------------------------------------------


def test_slice_pitch_is_measured_from_every_gap_not_the_first_pair() -> None:
    """Two slices cannot tell you whether the third is where you expect it."""
    code = _code(_js("image", "volume.js"))
    assert not re.search(r"Math\.abs\(frames\[1\]\.depth - frames\[0\]\.depth\)", code), (
        "sliceSpacing is taken from the first pair and applied to the whole stack, so a "
        "gap anywhere after slice 1 is closed silently"
    )
    assert "function spacingOf(" in code, "volume.js does not measure the gaps"
    assert "uniformSpacing" in code, "the stack does not record whether its sampling is even"


def test_the_reported_pitch_is_the_median_not_the_mean() -> None:
    """One 10 mm gap in a 2 mm series drags a mean to 2.3 and leaves it looking plausible.

    The median stays 2 and `uniform` goes false, so the number a reader sees is not quietly
    bent by the outlier that makes it unsafe.
    """
    code = _code(_js("image", "volume.js"))
    body = code[code.index("function spacingOf("):]
    body = body[: body.index("\n}")]
    assert "median" in body, "spacingOf does not compute a median"
    assert "reduce(" not in body, (
        "spacingOf appears to average the gaps; a mean is pulled by the outlier that is "
        "the reason to distrust it"
    )


def test_a_stack_with_uneven_gaps_refuses_reconstruction() -> None:
    """Resampling lays every slice one pitch from the last, so a wide gap is drawn narrow.

    Interpolating across it is worse than refusing: it would draw tissue boundaries the
    scanner never measured, exactly where the reader has least reason to suspect them.
    """
    code = _code(_js("image", "mpr.js"))
    # The word is the platform's, not this module's invention. MOS-SVC-095 fixes a closed
    # rejection vocabulary containing `spacing_non_uniform`, and a viewer that says
    # `reconstruction_needs_even_sampling` for the same physical fact teaches a reader two
    # names for one thing -- which is the objection MOS-UI-310 makes about metric synonyms.
    assert "spacing_non_uniform" in code, (
        "mpr.js reslices without checking that the third axis is evenly sampled, or names "
        "the condition something other than the word the platform already uses"
    )
    assert "uniformSpacing" in code


def test_the_uneven_spacing_guard_is_on_the_action_and_says_which_reason() -> None:
    """"Not reconstructable" covers two different facts, and the wrong one misdirects.

    A stack with no positions and a stack with a gap both fail to reconstruct, for reasons
    that need different fixes. And the guard belongs on `setPlane`, which the c/s shortcuts
    also reach — disabling only the button is the half-conversion this file already gates.
    """
    shell = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    body = shell[shell.index("function setPlane(") : shell.index("function buildPlaneButtons(")]
    assert "reconstructionRefusal(p.stack, plane)" in body, (
        "setPlane does not check stack.uniformSpacing, so the c/s shortcuts bypass it"
    )
    # THE REASON REACHES THE READER, and it is the module's own sentence rather than a
    # second wording kept in the shell -- a refusal added to `reconstructionRefusal` shows
    # up here without anybody remembering to restate it.
    assert "refusal.code" in body and "refusal.message" in body, (
        "setPlane refuses without telling the reader which of the reasons applied"
    )


# --------------------------------------------------------------------------------------
# Gantry tilt: the slices are offset within their own plane
#
# With the gantry tilted the table steps along the patient's z axis while the imaging
# plane's normal leans away from it, so consecutive slices are displaced from each other
# WITHIN the plane. A contiguous copy packs that as a sheared volume: the axial is fine,
# because it is the acquired plane, and the coronal and sagittal lean.
#
# Measured with a marker written at ONE patient point, whose row therefore walks up the
# frame as the table advances (tests/_support/tilt_probe.py). A correct reconstruction puts
# every one of those back on the same volume row, so a coronal cut there catches it across
# the whole depth:
#
#                        volume rows   sliceSpacing   depth columns holding the marker
#     flat                    64          3.000                 20 of 20
#     tilted, corrected       92          2.598                 20 of 20
#     tilted, uncorrected     92          2.598                  3 of 20
#
# 2.598 is 3·cos(30°), which is the spacing along the normal rather than along the table --
# the same projection the sort key uses, and evidence the geometry is being read correctly.
# --------------------------------------------------------------------------------------


def test_the_shear_is_measured_from_the_positions_not_read_from_the_tilt_angle() -> None:
    """(0018,1120) states an angle; the positions state what the scanner did.

    They agree on conformant data, and the positions are what the reconstruction has to
    match — the same argument that makes sliceSpacing a measurement rather than a reading
    of (0018,0088).
    """
    code = _code(_js("image", "mpr.js"))
    assert "function shearOf(" in code, "mpr.js does not measure the in-plane displacement"
    assert "00181120" not in code, (
        "mpr.js reads the tilt angle from the header instead of measuring the displacement "
        "the positions actually describe"
    )
    assert "orientation.slice(0, 3)" in code and "orientation.slice(3, 6)" in code, (
        "shearOf does not project onto the row and column direction cosines, so whatever it "
        "computes is not an in-plane displacement"
    )


def test_the_volume_grows_so_the_correction_displaces_nothing_off_the_end() -> None:
    """Shearing inside the original height would push the far slices out of the array.

    Those rows would be dropped silently, which trades a leaning reconstruction for a
    truncated one — the same wrong answer with less to see.
    """
    code = _code(_js("image", "mpr.js"))
    assert "volumeRows" in code, "the volume height is not derived from the shear"
    body = code[code.index("function geometryOf("):]
    body = body[: body.index("\n}")]
    assert "stack.rows + (hi - lo)" in body, (
        "geometryOf does not grow the volume by the shear span, so the correction pushes "
        "the outermost slices past the end of the array"
    )


def test_the_overlay_is_sheared_with_the_image() -> None:
    """A mask displaced by a few millimetres still looks like a mask.

    This is the one failure a segmentation viewer must never produce: correcting the image
    and not the overlay would slide the mask off the anatomy it was computed on, and the
    result reads as a model that segmented the wrong thing.
    """
    code = _code(_js("image", "mpr.js"))
    body = code[code.index("function overlayVolumeOf("):]
    body = body[: body.index("\n}")]
    assert "geometryOf(stack)" in body and "rowStart" in body, (
        "overlayVolumeOf packs the mask without the shear the image got, so on a tilted "
        "study the overlay lands beside the anatomy rather than on it"
    )


def test_the_shear_fill_declares_itself_as_padding() -> None:
    """The vacated corners are outside the acquired field, which is what padding means.

    Declaring the fill lets `measure.js` drop it, so an ROI over a corner of a corrected
    reconstruction cannot average in a value the correction invented.
    """
    code = _code(_js("image", "mpr.js"))
    assert "fillValueOf" in code, "there is no defined fill for the vacated region"
    assert re.search(r"paddingValue:\s*stack\._fill", code), (
        "the reconstructed frame does not declare its fill as padding, so an ROI over a "
        "sheared corner averages in a value no scanner produced"
    )


# --------------------------------------------------------------------------------------
# (0028,0301) BurnedInAnnotation: the one PHI this surface can show without noticing
#
# Every other identifier the viewer handles is a header field it chooses whether to render.
# A name burned into the pixels arrives with the anatomy — and MOS-DATA-040 permits exactly
# that: `pixel_phi.action: ALLOW` is "no modification; permitted only when the consumer
# class is clinical_viewer". The platform deliberately lets unredacted pixels reach here.
#
# Measured on three secondary captures differing only in the declaration
# (tests/_support/burned_in_probe.py):
#
#     declares YES      error-level notice: the pixels DO carry identifiers
#     declares NO       silent
#     omits the tag     warning: unknown, and this surface has not screened
# --------------------------------------------------------------------------------------


def test_the_viewer_reads_whether_its_pixels_carry_identifiers() -> None:
    """MOS-DATA-040 names this surface as the one allowed to receive unredacted pixels."""
    code = _code(_js("image", "volume.js"))
    assert "00280301" in code, (
        "volume.js does not read (0028,0301), so the one consumer class permitted to "
        "receive unredacted burned-in PHI cannot tell the reader it has"
    )


def test_an_absent_declaration_is_not_treated_as_a_denial() -> None:
    """(0028,0301) is Type 1C, and a study that omits it did not declare itself clean.

    Folding absent into NO reports a clean study nobody checked. Folding it into YES cries
    wolf on every secondary capture, and a warning that fires on everything is read as
    noise at the moment it fires on the one that matters. Three states, because the data
    has three.
    """
    code = _code(_js("image", "volume.js"))
    assert "burnedInUnknown" in code, (
        "the stack does not distinguish 'declared absent' from 'declared NO'"
    )
    # MOS-DATA-041's presumption is what keeps the unknown case from firing on every CT.
    assert "ORIGINAL" in code and "PRIMARY" in code, (
        "the unknown case does not take MOS-DATA-041's presumption for an ORIGINAL/PRIMARY "
        "acquisition, so it warns on every CT in the archive"
    )


def test_the_shell_separates_declared_from_unknown() -> None:
    """"Does" and "may" send a reader to different places, so they are different notices."""
    shell = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    assert "burnedInUnknown" in shell and "'YES'" in shell, (
        "app.js does not act on the burned-in declaration, so the reader is not told before "
        "the pixels reach the screen"
    )


def test_a_dicom_multi_valued_string_is_split_on_the_right_character() -> None:
    """DICOM separates values with a backslash (PS3.5 6.2), and a literal one is easy to lose.

    An earlier version of this split on `'\'` — a single backslash, which escapes the
    closing quote and broke the module outright. That failed loudly. The dangerous version
    is the one that splits on the wrong character and silently yields a single-element list,
    which would make every ImageType check quietly false.
    """
    code = _code(_js("image", "volume.js"))
    assert "function textValues(" in code, (
        "there is no one place that knows how a multi-valued string is separated"
    )
    body = code[code.index("function textValues("):]
    body = body[: body.index("\n}")]
    assert "String.fromCharCode(92)" in body, (
        "textValues does not split on a backslash by character code; a literal in a string "
        "literal is exactly where this separator gets lost"
    )


# --------------------------------------------------------------------------------------
# (0028,1056) VOILUTFunction: three transfer functions, one implemented
#
# LINEAR is the standard's default and the only one a CT normally carries, so the shader's
# single hardcoded ramp was right for the corpus and wrong for MR, where several vendors
# ship SIGMOID. Rendered as LINEAR a SIGMOID window clips both tails, discarding exactly
# the tissue the acquisition chose that function to keep.
#
# Measured on one ramp with three declarations and an identical window
# (tests/_support/voi_probe.py):
#
#     LINEAR         0 -> 0 -> 128 -> 255 -> 255     129 of 256 pixels clamped
#     LINEAR_EXACT   0 -> 0 -> 128 -> 255 -> 255     129 of 256 pixels clamped
#     SIGMOID        6 -> 31 -> 128 -> 225 -> 249      0 of 256 pixels clamped
#
# Half the ramp was being thrown away and is now kept. LINEAR and LINEAR_EXACT agree here
# because their difference is 0.5/(w-1) — below one grey level at any practical width — so
# the routing was verified by reading `u_voiFunction` back off the program instead: 0, 1, 2
# for the three declarations and 0 for a frame that declares nothing.
# --------------------------------------------------------------------------------------


def test_the_viewer_reads_which_transfer_function_the_window_was_authored_for() -> None:
    """A window without its function is half a statement."""
    code = _code(_js("image", "volume.js"))
    assert "00281056" in code, "volume.js does not read (0028,1056) VOILUTFunction"
    assert "voiFunction" in code, "the frame carries no transfer function"


def test_the_shader_implements_every_function_it_claims_to_route() -> None:
    """Routing to a branch that is not there is worse than not routing at all."""
    code = _js("render", "viewport.js")
    assert "u_voiFunction" in code, "the shader has no transfer-function uniform"
    # SIGMOID is C.11.2.1.3.1: 1 / (1 + exp(-4(x-c)/w)). The -4 is the whole shape.
    assert re.search(r"exp\(\s*-4\.0\s*\*", code), (
        "the shader has no sigmoid transfer function, so a SIGMOID window still renders "
        "with the linear ramp"
    )
    # LINEAR_EXACT is C.11.2.1.3.2: centred on c over w, WITHOUT the half-unit offsets that
    # LINEAR carries because LINEAR is defined over stored integers.
    assert "u_voiFunction == 1" in code, "the shader does not distinguish LINEAR_EXACT"


def test_an_unrecognised_transfer_function_falls_to_the_standard_default() -> None:
    """LINEAR is the default when (0028,1056) is absent, and refusing would be worse.

    A viewer that refused an unknown value would refuse studies it can render correctly;
    the standard already says what to do when the attribute says nothing.
    """
    code = _code(_js("render", "viewport.js"))
    line = next((ln for ln in code.splitlines() if "u_voiFunction," in ln and "uniform1i" in ln), "")
    assert line, "the transfer function is never sent to the shader"
    table = code[code.index("const voi ="):]
    table = table[: table.index(";")]
    assert "?? 0" in table, (
        "an absent or unrecognised VOILUTFunction does not fall to LINEAR, so it reaches "
        "the shader as undefined"
    )


# --------------------------------------------------------------------------------------
# Reference lines: where one panel's slice cuts another panel's plane
#
# Two panels showing the same anatomy from different angles are two pictures until the
# reader can see how they relate. MOS-UI-211 states the clinical version for the annotation
# surface: "a segmentation authored on axial slices alone with no cross-plane check
# produces a mask that is correct slice by slice and wrong in the craniocaudal direction,
# and the reader cannot see it."
#
# Verified against the phantom. An axial slice k drawn onto the coronal must be a
# horizontal line at output row depth-1-k, because rows are written bottom-up:
#
#     axial 10 -> row 53.0    axial 32 -> row 31.0    axial 50 -> row 13.0
#
# all spanning the full width, and the sagittal likewise. Every prediction exact.
# --------------------------------------------------------------------------------------


def test_a_reference_line_needs_a_shared_frame_of_reference() -> None:
    """The line is computed from patient coordinates, which two series need not share.

    PS3.3 C.7.4.1: different (0020,0052) values make no assertion that the coordinates have
    a common origin, so a line computed across that boundary is arithmetic on two unrelated
    systems. It produces a plausible line, in the wrong place, and nothing about it looks
    wrong — which is why this returns null rather than a best effort. There is no honest
    approximate version of a claim about where something is.
    """
    code = _code(_js("image", "reference.js"))
    assert "frameOfReferenceUID" in code, (
        "reference.js does not check the frame of reference, so it will draw a line between "
        "two series whose coordinates share no origin"
    )
    body = code[code.index("export function comparable("):]
    body = body[: body.index("\n}")]
    assert "!source.frameOfReferenceUID" in body or "!source.frameOfReferenceUID" in code, (
        "a MISSING frame of reference is not treated as a mismatch; absent is not the same "
        "as equal, and sync.js already makes that distinction for position linking"
    )


def test_a_reconstructed_plane_knows_where_it_is() -> None:
    """A plane with no position, orientation or normal is a picture with no place.

    `reslice` set `sopInstanceUID: null` from the start but carried no geometry at all, so
    nothing downstream could relate a coronal to anything. A reference line onto one was not
    wrong — it was impossible.
    """
    code = _code(_js("image", "mpr.js"))
    assert "function reconstructedGeometry(" in code, (
        "reslice gives a reconstructed plane no patient-space geometry"
    )
    body = code[code.index("function reconstructedGeometry("):]
    body = body[: body.index("\nfunction ")] if "\nfunction " in body else body
    for field in ("position", "orientation", "normal"):
        assert f"{field}:" in body, f"a reconstructed plane carries no {field}"


def test_parallel_planes_produce_no_line_rather_than_a_fabricated_one() -> None:
    """Two parallel planes either miss entirely or coincide. Neither is a line.

    An axial referencing its own axial is the degenerate case, and drawing anything there
    would be inventing a locator for a relationship that has none.
    """
    code = _code(_js("image", "reference.js"))
    assert re.search(r"Math\.abs\(a\) < EPS && Math\.abs\(b\) < EPS", code), (
        "reference.js does not detect parallel planes, so a coincident pair yields a "
        "division by something near zero rather than nothing at all"
    )


def test_a_panel_does_not_reference_itself() -> None:
    """A plane does not usefully locate itself, and a line along nothing is still a line."""
    shell = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    body = shell[shell.index("function referencesOnto("):]
    body = body[: body.index("\n}")]
    assert "other === target" in body, (
        "referencesOnto does not skip the target panel, so every panel draws its own plane "
        "across itself"
    )


# --------------------------------------------------------------------------------------
# Slab projection: a picture of no single plane
#
# A MIP is the densest voxel somewhere along each ray. That makes a nodule visible that a
# single slice cuts through the edge of, which is the whole reason radiologists ask for
# one. It also makes every number taken off it a number about a ray rather than about
# tissue, and makes the picture belong to no slice position at all.
#
# MEASURED against this project's own phantom -- a 30 HU sphere of radius 4 mm, occupying
# slices 26-30 and rows 145-155, in a 64-slice series of 2.0 mm slices and 0.7 mm pixels.
# The test is a boundary rather than a smoke check: the nodule must appear at the exact
# thickness that first reaches it and NOT one step sooner, which is what separates a
# projection from a blur.
#
#   AXIAL, plane at slice 20, needs to reach slice 26 -> half >= 6 -> mm >= 26
#     asked  2 mm    no slab (thinner than three positions)     -820 HU
#     asked 20 mm    18 mm, 9 slices                            -820 HU
#     asked 25 mm    22 mm, 11 slices                           -820 HU
#     asked 26 mm    26 mm, 13 slices                             30 HU   <- found here
#
#   CORONAL, plane at row 120, needs to reach row 145 -> half >= 25 -> mm >= 36
#     asked 35 mm    34.3 mm, 49 slices                         -820 HU
#     asked 36 mm    35.7 mm, 51 slices                           30 HU   <- found here
#
# The two boundaries are 26 mm and 36 mm for the same sphere because the axes have
# different spacing -- 2.0 mm against 0.7 mm. A slab quoted in slice counts, or quoted in
# millimetres computed from slice spacing on every plane, would agree with neither.
#
# Two further properties were measured across every request above:
#   * the achieved thickness NEVER exceeds the requested one (an earlier `floor(mm/2/step)`
#     returned 22 mm for a 20 mm request, measured, before the form was corrected);
#   * a slab clipped by the end of the volume reports what it projected -- 50 mm requested
#     at slice 1 returns "14 slices / 28 mm", not 50.
def test_slab_thickness_is_measured_along_the_axis_it_projects() -> None:
    """A slab runs along the normal of the plane being drawn, and each plane has its own.

    Axial steps by slice spacing, coronal by row spacing, sagittal by column spacing. On
    this phantom those are 2.0 mm, 0.7 mm and 0.7 mm, so quoting slice spacing on a coronal
    reports a 51-slice slab as 102 mm when it is 35.7 — a label wrong by nearly three times,
    printed beside an image that cannot contradict it.
    """
    code = _code(_js("image", "mpr.js"))

    # The step is decided ONCE. The HUD prints it and the slab measures with it, and they
    # were separately written before this function existed.
    body = code[code.index("export function planeStepMm("):]
    body = body[: body.index("\n}")]
    returns = re.findall(r"return ([^;]+);", body)
    # An oblique steps by its own pitch and is answered first; the three NAMED planes are
    # the rest, and they must still be three different things in their own order. Falling
    # through to `stack.sliceSpacing` on an oblique is what makes a 10 mm slab report the
    # suspiciously round "over 10.0 mm".
    assert "grid.stepMm" in returns[0], (
        f"planeStepMm does not give an oblique its own pitch: {returns}"
    )
    named = returns[1:]
    assert len(named) == 3 and len(set(named)) == 3, (
        f"planeStepMm does not give the three named planes three different steps: {named}"
    )
    assert "pixelSpacing[0]" in named[0], f"coronal steps by row spacing: {named}"
    assert "pixelSpacing[1]" in named[1], f"sagittal steps by column spacing: {named}"
    assert "sliceSpacing" in named[2], f"axial steps by slice spacing: {named}"

    # And each slab asks for ITS OWN plane. Passing one function three times is no help if
    # two of the callers name the same plane.
    steps = re.findall(r"(?<!function )slabPlan\([^)]*?,\s*planeStepMm\(stack,\s*([^)]+)\)", code)
    assert steps == ["PLANES.AXIAL", "PLANES.CORONAL", "PLANES.SAGITTAL"], (
        f"the three slab plans do not each measure along their own plane's axis: {steps}"
    )

    # The HUD asks the same function rather than repeating the three-way choice.
    # A CALL, not the import line. The first version of this assertion looked for the bare
    # name, and its own break test -- replacing the call with `p.stack.sliceSpacing` --
    # left `planeStepMm` sitting in the import and walked straight through.
    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    assert re.search(r"planeStepMm\(\s*\w+\.stack", app), (
        "app.js never CALLS planeStepMm, so whatever the HUD prints beside the slice "
        "counter is computed somewhere other than where the slab measures itself"
    )
    handrolled = re.findall(r"\w*\.(?:sliceSpacing|pixelSpacing\[\d\])", app)
    assert not handrolled, (
        f"app.js picks a plane's spacing itself instead of asking planeStepMm, so the HUD "
        f"figure and the slab thickness can drift apart with nothing on screen showing "
        f"which one moved: {handrolled}"
    )


def test_the_projection_extreme_follows_the_sign_of_the_rescale_slope() -> None:
    """"Maximum intensity" is a claim about output values, not stored ones.

    A negative (0028,1053) RescaleSlope reverses the order of the two, so a maximum taken
    on the stored array returns the LEAST dense voxel along every ray. The result is the
    exact opposite of what the label says, and nothing about it looks wrong.
    """
    code = _code(_js("image", "mpr.js"))
    body = code[code.index("function slabPlan("):]
    body = body[: body.index("\n}")]
    assert "slope" in body, (
        "slabPlan never consults the rescale slope, so the comparison assumes a rising "
        "scale and inverts on every study that does not have one"
    )
    assert re.search(r"wantHigher:.*slope", body, re.S), (
        "the slope is mentioned but does not reach the comparison direction"
    )


def test_a_projection_skips_padding_on_every_plane() -> None:
    """Padding is the lowest value in most volumes, so a min-IP that keeps it draws it.

    Every ray touching an out-of-field corner would return the padding value, painting the
    region outside the reconstruction circle over the anatomy at full contrast — and it
    would look like a finding rather than like a bug.
    """
    code = _code(_js("image", "mpr.js"))
    assert "paddingTest(" in code, "mpr.js does not ask what padding is"
    skips = len(re.findall(r"if \(isPad\((?:v|out\[i\])\)\) continue;", code))
    assert skips == 4, (
        f"expected each of the four projection loops -- axial, coronal, sagittal and "
        f"oblique -- to skip padding, found {skips}"
    )


def test_a_measurement_records_whether_its_pixels_were_projected() -> None:
    """An ROI on a MIP is a mean of maxima, which is a real number describing no tissue.

    It is recorded at the moment the measurement is taken rather than looked up at render
    time, so a row cannot be relabelled by the reader switching the slab off afterwards —
    the same reason `valueUnit` travels with the measurement.
    """
    measure = _code(_js("image", "measure.js"))
    assert re.search(r"projection:\s*frame\.projection", measure), (
        "measure.js does not record the projection on the measurement, so a mean of "
        "maxima is stored as indistinguishable from a mean of tissue"
    )

    # BOTH renderers, for the reason MOS-UI-029 gives: a surface that decides a state in
    # more than one component eventually disagrees with itself.
    # THE ROI BRANCH, named. Asking whether the module mentions `projectionNote` anywhere
    # stopped discriminating the moment the caliper path gained its own call: deleting the
    # note from the ROI left the name in the file and the gate green.
    for module, name in (("render", "annotations.js"), ("ui", "measurements-panel.js")):
        code = _code(_js(module, name))
        roi = code[code.index("kind === 'roi'"):]
        roi = roi[: roi.index("\n  }")]
        assert "projectionNote(" in roi, (
            f"{name} renders an ROI without saying whether it came off a projection, so a "
            f"mean of maxima reads as a tissue density"
        )


def test_every_control_that_depends_on_the_stack_is_rebuilt_when_one_arrives() -> None:
    """A toolbar built before the pixels is a toolbar built against no series.

    `buildSlabButtons` disables a thickness that cannot be built from the current plane's
    spacing, which it can only know from the stack. It ran once at start-up, when there was
    none, and every button came out disabled — including `Off`. The strip looked deliberate:
    greyed controls read as "not available for this study" rather than as "never asked
    again". It was rebuilt on three events and not on the one that matters.

    `buildPlaneButtons` had exactly the same dependency and three call sites, one of which
    was the load path. That is the set this gate keeps in agreement.
    """
    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))

    # DISABLED-from-the-stack, not merely mentioning it. `buildLinkButtons` reads
    # `p.stack` too, but only inside a click handler that runs long after a series has
    # arrived — so it builds correctly with none, and is not this gate's subject. The
    # defect is a control whose GREYING is decided from a stack that is not there yet.
    dependent = set()
    for m in re.finditer(r"function (build\w*Buttons)\(\) \{", app):
        body = app[m.end(): app.index("\n}", m.end())]
        if ".stack" in body and re.search(r"\.disabled\s*=", body):
            dependent.add(m.group(1))
    assert len(dependent) >= 2, (
        f"expected several stack-dependent control builders, found {dependent}"
    )

    # The block that runs once a series has finished loading into the active panel.
    load = re.search(r"if \(panelIndex === active\) \{([^}]*)\}", app)
    assert load, "the post-load toolbar refresh is no longer recognisable"
    rebuilt = set(re.findall(r"(build\w*Buttons)\(\)", load.group(1)))

    missing = sorted(dependent - rebuilt)
    assert not missing, (
        f"these controls decide what to disable from the stack but are never rebuilt once "
        f"one arrives, so they keep the verdict they reached with no series loaded: {missing}"
    )


def test_a_slab_refuses_a_varying_modality_lut_in_the_module_and_in_the_control() -> None:
    """Projecting across frames with different rescale compares two scales, not two densities.

    `reslice` already refuses a RECONSTRUCTION for this reason. A slab crosses frames in
    exactly the same way, so it inherits the refusal — and the refusal has to exist twice,
    because the two halves answer different questions:

      * the module refuses the SPAN, which is the correct unit and which moves as the
        reader scrolls;
      * the control refuses the SERIES, because a thickness enabled at slice 10 that throws
        at slice 40 is a control that works until it does not.

    Dropping either half leaves the other looking sufficient. Without the module check the
    projection is silently wrong; without the control check pressing an offered button
    breaks the panel.
    """
    mpr = _code(_js("image", "mpr.js"))
    assert "export function rescaleVariesOver(" in mpr, (
        "the slab has no uniform-rescale check, so it projects across frames in two scales"
    )
    # THE CALL, not the definition. The first version of this gate asked whether the
    # function and the refusal string existed anywhere in the module, and its own break
    # test -- replacing the call with `null` -- left both in place and walked through. That
    # is the same defect the tag-table gates exist for: a declaration nothing reaches.
    assert re.search(r"rescaleVariesOver\(stack\.frames,\s*plan\.", mpr), (
        "nothing in reslice asks whether the slab's own span shares a Modality LUT, so the "
        "refusal below it is unreachable"
    )
    # Named like every other refusal this platform raises, so it reads as one.
    assert re.search(r"'projection_needs_uniform_rescale: ", mpr), (
        "the refusal carries no sentence saying what was wrong with the data"
    )

    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    assert "rescaleVariesOver(" in app, (
        "the toolbar offers a slab on any series, so on one with a varying Modality LUT "
        "the button throws out of reslice at whatever slice the reader has reached"
    )
    # THE THICKNESS BUTTONS, named. `mode.disabled = Boolean(mixed)` sits in the same
    # function and satisfied a looser `\.disabled\s*=.*mixed` while every thickness was
    # still offered -- the gate matched a line that was not the one under test.
    builder = app[app.index("function buildSlabButtons()"):]
    builder = builder[: builder.index("\n}")]
    assert re.search(r"\bb\.disabled\s*=[^;]*\bmixed\b", builder), (
        "the builder computes whether the rescale varies and then offers every thickness "
        "anyway, so pressing one throws out of reslice at whatever slice is on screen"
    )


# --------------------------------------------------------------------------------------
# (0020,0037) ImageOrientationPatient: which side of the picture is the patient's left
#
# A CT slice is very nearly symmetric. Left lung and right lung are the same shape in the
# same place, and nothing in the greyscale says which is which — the letter at the edge of
# the viewport is the only mark on screen that does. This viewer drew none at all, so
# laterality could not be checked against the image by any means.
#
# MEASURED in a browser against the demo phantom, which is head-first supine:
#
#     axial      top A   bottom P   left R   right L
#     coronal    top H   bottom F   left R   right L
#     sagittal   top H   bottom F   left A   right P
#
# Those are the three conventional readings, and each is derived from that plane's OWN
# (0020,0037) — the reconstructed planes have one because `reconstructedGeometry` builds
# it, which is why a coronal does not report the source axial's edges.
# --------------------------------------------------------------------------------------


def test_orientation_letters_come_from_the_header_and_are_never_assumed() -> None:
    """Without (0020,0037) the image has no stated relationship to the patient.

    A viewer that assumed the usual one — head-first supine, rows anterior to posterior —
    would print `R` on the left edge of a prone or feet-first study with total confidence.
    So an absent orientation yields null, and the surface renders that absence rather than
    omitting it: a blank edge is indistinguishable from a viewer that has no markers, which
    is what this one was.
    """
    code = _code(_js("image", "orientation.js"))
    body = code[code.index("export function edgeLetters("):]
    body = body[: body.index("\n}")]
    assert re.search(r"if \(!o \|\| o\.length !== 6\) return null;", body), (
        "edgeLetters does not refuse a frame with no ImageOrientationPatient, so it "
        "derives letters from whatever is there"
    )

    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    assert "orientation not recorded" in app, (
        "the absence of an orientation is not rendered, so a study that states none looks "
        "the same as one whose markers have not been drawn yet"
    )


def test_the_row_and_column_cosines_are_not_swapped() -> None:
    """(0020,0037) states the COLUMN direction first and the ROW direction second.

    PS3.3 C.7.6.2.1.1: the first triplet runs along increasing column index and the second
    along increasing row index — so the first is the image's RIGHT edge and the second is
    its BOTTOM. Reversing the pair produces markers that are self-consistent, plausible,
    and rotated ninety degrees from the truth, which no picture can contradict.
    """
    code = _code(_js("image", "orientation.js"))
    body = code[code.index("export function edgeLetters("):]
    body = body[: body.index("\n}")]
    assert re.search(r"alongColumns = \[o\[0\], o\[1\], o\[2\]\]", body), body[:200]
    assert re.search(r"alongRows = \[o\[3\], o\[4\], o\[5\]\]", body), body[:200]
    # right comes from the column cosine, bottom from the row cosine.
    assert re.search(r"const right = directionLetters\(alongColumns\)", body), (
        "the image's right edge is not derived from the column direction cosine"
    )
    assert re.search(r"const bottom = directionLetters\(alongRows\)", body), (
        "the image's bottom edge is not derived from the row direction cosine"
    )


def test_an_oblique_direction_is_not_rounded_to_a_single_letter_in_silence() -> None:
    """A direction 40 degrees off the left-right axis is genuinely both, and `L` alone
    would be a simplification the picture contradicts. A direction 10 degrees off is `L`,
    and `LP` would suggest an obliquity the reader cannot see and need not correct for.

    The threshold is therefore an ANGLE with a stated meaning rather than a tuned constant.
    """
    code = _code(_js("image", "orientation.js"))
    assert re.search(r"Math\.sin\(\(15 \* Math\.PI\) / 180\)", code), (
        "the second-letter threshold is not expressed as an angle, so what obliquity it "
        "calls visible cannot be read off the code"
    )
    body = code[code.index("export function directionLetters("):]
    body = body[: body.index("\n}")]
    assert "sort(" in body, (
        "the letters are not ordered by magnitude, so `AL` and `LA` — which say different "
        "things about which direction dominates — cannot be told apart"
    )


def test_every_edge_marker_has_a_rule_placing_it_on_that_edge() -> None:
    """A marker at a corner belongs to two edges and says which way neither of them points.

    Four classes, four rules, and the `unknown` state must look unlike a letter: the
    sentence `orientation not recorded` sitting where an `R` goes, in the same weight,
    reads as an anatomical marker at a glance.
    """
    styles = (VIEWER / "styles.css").read_text(encoding="utf-8")
    for side in ("top", "bottom", "left", "right"):
        assert re.search(rf"\.hud-{side}\s*{{", styles), (
            f"the {side} orientation marker has no rule, so it renders wherever the .hud "
            f"default puts it — which is a corner"
        )
    assert re.search(r"\.hud-edge\.unknown\s*{", styles), (
        "the not-recorded state is styled the same as a letter"
    )


# --------------------------------------------------------------------------------------
# Rotate and flip: one matrix, three consumers
#
# `flipH`, `flipV` and `rotate` interact — flip horizontally then rotate twice IS flipping
# vertically — so a viewer holding three separate flags has to pick an order of application
# and then apply that same order in the shader, in the hit-testing, and in the orientation
# markers. Written three times, it will eventually be written differently once, and the
# failure is invisible: the picture, the caliper and the letters each look internally
# consistent while disagreeing with each other.
#
# MEASURED in a browser across all eight reachable states (identity, three rotations, two
# flips, a flip composed with a rotation, and four rotations back to identity):
#
#     round-trip image -> screen -> image      <= 5.7e-14 px in every state
#     four rotations                            returns exactly [1, 0, 0, 1]
#     flip horizontal                           right edge R, left edge L — swapped
#     rotate right                              image top A lands on the screen's right
#
# And on a deliberately anisotropic frame (3.0 mm rows, 0.7 mm columns), 10 mm along rows
# and 10 mm along columns map to the SAME screen distance in every rotation — 28.699 px
# unrotated, 19.133 px on its side, equal to 1e-9 both times. That isotropy is what makes a
# caliper drawn diagonally across a rotated frame the right length.
# --------------------------------------------------------------------------------------


def test_the_view_transform_is_one_matrix_rather_than_three_flags() -> None:
    """Three flags need a composition rule, and a rule gets written three times."""
    code = _code(_js("render", "transform.js"))
    assert "export const NO_TRANSFORM = [1, 0, 0, 1];" in code, (
        "there is no single identity transform to compose onto"
    )
    assert "function compose(" in code, (
        "the operations do not compose, so each one must decide how it combines with "
        "whatever is already applied"
    )
    for op in ("rotatedRight", "flippedHorizontally", "flippedVertically"):
        body = code[code.index("export function " + op + "("):]
        body = body[: body.index("\n}")]
        assert "compose(" in body and "m)" in body, (
            op + " does not compose onto the current transform, so it either replaces it "
            "or applies in a fixed order the other operations do not share"
        )

    # No parallel representation anywhere. A boolean beside the matrix is a second source
    # of truth, and the two will disagree the first time one is set without the other.
    for path in sorted(SRC.rglob("*.js")) + [VIEWER / "app.js"]:
        text = _code(path.read_text(encoding="utf-8"))
        offenders = set(re.findall(r"\.(flipH|flipV|rotation)\b", text))
        assert not offenders, f"{path.name} keeps a second representation: {offenders}"


def test_the_fit_uses_the_displayed_extent_so_a_rotation_does_not_stretch() -> None:
    """A quarter turn puts the frame's height along the screen's width.

    `fitOf` fits the PHYSICAL rectangle, which is what makes millimetres map to screen
    distance by one uniform scale in both directions — the property a diagonal caliper on
    an anisotropic frame depends on. Fitting the unrotated rectangle while the shader draws
    the rotated one stretches every shape on screen by the aspect ratio, and the caliper
    reports a length that matches the picture and not the patient.
    """
    code = _code(_js("render", "transform.js"))
    body = code[code.index("export function fitOf("):]
    body = body[: body.index("\n}")]
    assert re.search(r"shownW\s*=\s*Math\.abs\(m\[0\]\)", body), (
        "the fit does not derive its width from the transform, so a rotated image is "
        "fitted against the axis it is no longer along"
    )
    assert re.search(r"shownH\s*=\s*Math\.abs\(m\[2\]\)", body), body[-300:]
    assert "imageAspect = shownW / shownH" in body, (
        "the aspect is not taken from the displayed extent"
    )

    mm = code[code.index("function millimetresPerScreenPixel("):]
    mm = mm[: mm.index("\n}")]
    assert "fit.shownW" in mm, (
        "millimetres per screen pixel is measured from the stored width, so after a "
        "quarter turn it measures the wrong side of the picture"
    )


def test_the_two_directions_apply_the_transform_opposite_ways() -> None:
    """They are exact inverses, and the inverse of an orthogonal matrix is its transpose.

    Written as a transpose rather than a general 2x2 inversion so the orthogonality is
    stated in the code instead of being silently relied on by a division that would also
    appear to work.
    """
    code = _code(_js("render", "transform.js"))
    fwd = code[code.index("export function imageToScreen("):]
    fwd = fwd[: fwd.index("\n}")]
    back = code[code.index("export function screenToImage("):]
    back = back[: back.index("\n}")]
    assert "applyTransform(fit.transform" in fwd, "imageToScreen ignores the transform"
    assert "unapplyTransform(fit.transform" in back, "screenToImage ignores the transform"

    un = code[code.index("function unapplyTransform("):]
    un = un[: un.index("\n}")]
    assert re.search(r"m\[0\] \* x \+ m\[2\] \* y", un), (
        "the reverse direction is not the transpose, so the two stop being exact inverses"
    )

    # The bounds check must happen in IMAGE space, or a click outside a rotated image is
    # tested against the screen-aligned box around it and lands on a pixel never clicked.
    assert back.index("unapplyTransform") < back.index("Math.abs(u) > 1"), (
        "screenToImage bounds-checks before undoing the transform"
    )


def test_the_orientation_letters_follow_the_view_transform() -> None:
    """A flip that leaves `R` where it was says `R` on the patient's left.

    That is strictly worse than the viewer having no markers, which is what it had until
    the commit before this one: an absent marker sends a reader to the header, and a wrong
    one does not send them anywhere. It is the reason these controls did not exist earlier.
    """
    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    assert re.search(r"screenEdges\(edgeLetters\(frame\),\s*p\.viewport\.transform\)", app), (
        "the markers are computed from the frame alone, so they keep pointing where the "
        "picture used to be"
    )

    code = _code(_js("image", "orientation.js"))
    body = code[code.index("export function screenEdges("):]
    body = body[: body.index("\n}")]
    assert re.search(r"m\[0\] \* sx \+ m\[2\] \* sy", body), (
        "screenEdges does not use the transpose, so the letters permute by a different "
        "rule than the one the pixels were drawn with"
    )


def test_resetting_the_view_also_resets_the_orientation() -> None:
    """Otherwise `reset` means reset everything except which side is which."""
    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    body = app[app.index("function resetView()"):]
    body = body[: body.index("\n}")]
    assert "transform = NO_TRANSFORM" in body, (
        "resetView leaves a flip or rotation applied, so the control a reader reaches for "
        "to get back to a known state does not reach the one that changes laterality"
    )


def test_every_consumer_reads_the_view_from_one_place() -> None:
    """Three call sites built a view object by hand before the transform existed.

    Adding a third field meant editing three literals, and forgetting one would leave a
    caliper that lands where the picture is not — the shader would rotate and the
    hit-testing would not. There is one literal now, in `viewOf`.

    THE SUBJECT IS THE ARGUMENT, not the shape. The first version of this gate flagged any
    `{zoom, pan}` literal anywhere, and `setLayout` legitimately snapshots exactly those
    fields to restore them across a grid rebuild — a snapshot is not a view, and a gate
    that cannot tell the difference gets an exclusion bolted on for each new one until it
    is excluding the thing it was written to catch. What must never happen is a view built
    by hand and HANDED TO the geometry, because that is the one that can be missing a field
    the shader already applies.
    """
    consumers = (
        "fitOf", "screenToImage", "imageToScreen", "millimetresPerScreenPixel",
        "scaleBarOf", "zoomForOneToOne",
    )
    offenders = []
    for path in sorted(SRC.rglob("*.js")) + [VIEWER / "app.js"]:
        if path.name == "transform.js":
            continue
        text = _code(path.read_text(encoding="utf-8"))
        for name in consumers:
            for m in re.finditer(rf"\b{name}\(", text):
                # The argument list, bounded: long enough to hold a view literal, short
                # enough not to run into the next statement.
                window = text[m.end(): m.end() + 400]
                window = window[: window.find(";") + 1 or len(window)]
                if re.search(r"\{\s*zoom:", window):
                    offenders.append(f"{path.name}: {name}(... {window[:70].strip()}")

    assert not offenders, (
        f"these hand a view object straight to the geometry instead of calling viewOf, so "
        f"a field added to the view reaches some consumers and not others: {offenders}"
    )


def test_the_shader_and_the_hit_testing_share_one_fit() -> None:
    """`viewport.js` had its own copy of the fit arithmetic.

    Two implementations of where the image goes is how a rotation the shader applies and
    the hit-testing does not ends up putting every caliper a quarter turn from the pixel it
    measured — with both halves looking right in isolation.
    """
    code = _code(_js("render", "viewport.js"))
    assert "fitOf(" in code, "viewport.js does not ask transform.js where the image goes"
    assert "imageAspect" not in code, (
        "viewport.js still computes its own aspect fit, so there are two answers to where "
        "the image is drawn"
    )
    assert "u_transform" in code, "the shader never receives the transform"
    # GLSL mat2 takes columns; the row-major store must be transposed on upload exactly once.
    assert re.search(r"\[m\[0\], m\[2\], m\[1\], m\[3\]\]", code), (
        "the matrix is uploaded without the row-major to column-major swap, which is a "
        "rotation the other way that looks entirely deliberate"
    )


# --------------------------------------------------------------------------------------
# Scale bar and 1:1 — the two answers to "how big is that", and the one that is knowable
#
# ACTUAL SIZE is not. It needs the display's physical dimensions, and no browser reports
# them: `devicePixelRatio` is a ratio to the CSS pixel, which is defined against a NOTIONAL
# 96 dpi rather than a measured one. A 27-inch 4K panel and a 13-inch laptop can report the
# same numbers and differ by more than a factor of two. A viewer printing "actual size" from
# that asserts a physical fact it has no source for — and it would be believed, because the
# whole point of the control is that the reader stops drawing a caliper.
#
# A SCALE BAR needs nothing about the display. RadiAnt solves the first problem by asking
# the user to calibrate their monitor against a real ruler; the bar is what stays correct
# when nobody has.
#
# MEASURED on the demo phantom, 0.70 mm axial pixels:
#
#     Fit        100%   bar 50 mm = 127.4 px      0.393 mm per screen pixel
#     1:1         56%   bar 50 mm =  71.4 px      0.700 — one image pixel, exactly
#     then rotate 78%   bar 50 mm =  71.4 px      0.700 — unchanged
#     coronal      —    1:1 refused               pixels are 2.00 x 0.70 mm
#
# The third row is the point of making 1:1 a MODE rather than a number: the rotation changed
# the fit, so the zoom went 56% -> 78%, and the physical scale did not move at all. Stored as
# the scalar it happened to work out to, it drifted — measured at 438 of the 448 device
# pixels the control promises, a 2% error in the one control whose entire claim is exactness.
# --------------------------------------------------------------------------------------


def test_the_viewer_does_not_claim_an_actual_size_it_cannot_know() -> None:
    """No browser knows the display's physical size, so no control may imply it."""
    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    html = (VIEWER / "index.html").read_text(encoding="utf-8")
    for claim in ("actual size", "true size", "life size", "1 mm = 1 mm"):
        assert claim not in app.lower(), f"app.js offers `{claim}`, which it cannot compute"
        assert claim not in html.lower(), f"index.html offers `{claim}`"

    # And devicePixelRatio may not be turned into a millimetre. It is a ratio to the CSS
    # pixel, not to an inch.
    for path in sorted(SRC.rglob("*.js")) + [VIEWER / "app.js"]:
        text = _code(path.read_text(encoding="utf-8"))
        for m in re.finditer(r"devicePixelRatio", text):
            near = text[max(0, m.start() - 200): m.end() + 200]
            assert not re.search(r"\bmm\b|millimetre|25\.4|\b96\b", near), (
                f"{path.name} derives a physical length from devicePixelRatio, which is a "
                f"ratio to the CSS pixel and says nothing about the display's real size"
            )

    assert "scaleBarOf(" in app, (
        "there is no scale bar, so the viewer offers no way to size a finding without "
        "drawing a caliper on it"
    )


def test_the_scale_bar_is_a_round_length_that_fits_inside_the_picture() -> None:
    """A bar labelled 37 mm is finer and useless: readers estimate by halving and doubling.

    And the allowance is a fraction of the PICTURE, not of the panel. A wide, short pane
    fits the image by its height, so the image can occupy a third of the panel's width with
    black either side — measured against the panel, a bar inside its allowance came out at
    64% of the anatomy, longer than the thorax it sat under.
    """
    code = _code(_js("render", "transform.js"))
    nice = re.search(r"const NICE_MM = \[([^\]]+)\]", code)
    assert nice, "the scale bar has no table of allowed lengths"
    values = [float(v) for v in nice.group(1).split(",")]
    assert values == sorted(values), "the lengths are not in order"
    # A 1-2-5 progression: every step is either double or two-and-a-half times the last.
    for a, b in zip(values, values[1:]):
        assert abs(b / a - 2) < 1e-9 or abs(b / a - 2.5) < 1e-9, (
            f"{a} -> {b} is not a 1-2-5 step, so the bar can show a length a reader cannot "
            f"halve or double in their head"
        )

    body = code[code.index("export function scaleBarOf("):]
    body = body[: body.index("\n}")]
    assert "fit.sx * canvas.width" in body, (
        "the bar's allowance is measured against the panel rather than against the drawn "
        "picture, so on a wide short pane it is longer than the anatomy"
    )
    assert "Math.min(" in body, (
        "zoomed in the picture is wider than the panel, and the bar must stay inside "
        "whichever of the two is smaller"
    )


def test_one_to_one_is_a_mode_re_derived_every_draw() -> None:
    """`Fit` survives a resize because zoom 1 MEANS fit. 1:1 must too.

    Stored as the number it happened to work out to at the moment of the click, it drifted
    when the layout moved between the click and the draw — 438 of 448 device pixels,
    measured. 2% is invisible, and exactness is the whole of what the control claims.
    """
    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    body = app[app.index("function draw(p) {"):]
    body = body[: body.index("\nfunction ")]
    assert "if (p.viewport.oneToOne)" in body, (
        "draw does not re-derive 1:1, so it is whatever zoom the layout gave at click time"
    )
    # BEFORE the render and before the readout, or the HUD reports a zoom the picture is
    # not drawn at — observed as 100% over a picture at 56%.
    assert body.index("p.viewport.oneToOne") < body.index("p.viewport.render()"), (
        "1:1 is re-derived after the render, so the frame on screen is one zoom behind"
    )
    assert body.index("p.viewport.oneToOne") < body.index("Math.round(p.viewport.zoom * 100)"), (
        "1:1 is re-derived after the readout is written, so the percentage beside the "
        "picture is not the zoom the picture is drawn at"
    )


def test_one_to_one_refuses_pixels_that_are_not_square() -> None:
    """On a 2.00 x 0.70 mm coronal there is no zoom at which both directions are 1:1.

    Forcing it would mean abandoning the physical fit, which is what makes millimetres map
    to screen distance by one uniform scale — every shape would stretch and every caliper on
    the picture would be wrong, to satisfy a button. So it is refused and says why.
    """
    code = _code(_js("render", "transform.js"))
    body = code[code.index("export function zoomForOneToOne("):]
    body = body[: body.index("\n}")]
    assert re.search(r"Math\.abs\(rowMm - colMm\)[^\n]*return null", body), (
        "zoomForOneToOne does not refuse anisotropic pixels, so on a reconstructed plane "
        "it offers a 1:1 that is 1:1 in one direction only"
    )

    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    builder = app[app.index("function buildZoomButtons()"):]
    builder = builder[: builder.index("\n}")]
    assert re.search(r"one\.disabled = !target", builder), (
        "the control is offered even where the geometry refuses it"
    )
    assert "cannot be one screen pixel in both directions" in builder, (
        "the refusal gives no reason, so a greyed button reads as 'not implemented'"
    )
    # And the mode must drop when the reader moves to such a plane with it already on.
    draw_body = app[app.index("function draw(p) {"):]
    draw_body = draw_body[: draw_body.index("\nfunction ")]
    assert "p.viewport.oneToOne = false" in draw_body, (
        "switching to a plane that cannot be 1:1 leaves the mode set, so the viewer goes "
        "on claiming one image pixel per screen pixel where that is impossible"
    )


def test_choosing_a_zoom_by_hand_leaves_the_one_to_one_mode() -> None:
    """Otherwise the next draw snaps the reader's chosen magnification back."""
    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    drag = app[app.index("d.zoom * Math.exp") - 400: app.index("d.zoom * Math.exp")]
    assert "oneToOne = false" in drag, (
        "the zoom drag does not leave 1:1, so dragging is undone by the next redraw"
    )
    for control in ("function resetView()", "buildZoomButtons()"):
        pass
    reset = app[app.index("function resetView()"):]
    reset = reset[: reset.index("\n}")]
    assert "oneToOne = false" in reset, "reset leaves the 1:1 mode set"


def test_no_module_exports_a_geometry_helper_nothing_calls() -> None:
    """The tag-table rule, one directory along.

    `millimetresPerScreenPixel` was written for "a scale bar and a hit tolerance", kept
    through a correction, and had no caller at all until the bar existed — a declaration
    nothing reaches, which is the exact shape
    `test_no_module_declares_a_dicom_tag_it_never_reads` gates for attributes.
    """
    module = _js("render", "transform.js")
    exported = set(re.findall(r"export function (\w+)", module))
    assert exported, "transform.js exports nothing, which cannot be right"

    callers = "".join(
        path.read_text(encoding="utf-8")
        for path in sorted(SRC.rglob("*.js")) + [VIEWER / "app.js"]
        if path.name != "transform.js"
    )
    # WITHOUT the import statements. A name listed in an import and called nowhere is
    # exactly the case this gate is for, and counting the import as a use would let every
    # dead export through — the same hole that let `planeStepMm` pass a gate while app.js
    # had stopped calling it.
    callers = re.sub(r"import\s*\{[^}]*\}\s*from\s*'[^']*';", "", callers)
    # A BARE NAME counts: `rotatedRight` is passed by reference into a table of controls
    # and never appears as `rotatedRight(`.
    unused = sorted(n for n in exported if not re.search(rf"\b{n}\b", callers))
    assert not unused, (
        f"these are exported from transform.js and called by nothing outside it, so they "
        f"are kept for a consumer that does not exist: {unused}"
    )


def test_a_frame_that_never_stated_its_pixel_spacing_says_so() -> None:
    """(0028,0030) is absent on CR and DX, which state (0018,1164) instead.

    `volume.js` substitutes [1, 1] so the fit has an aspect to work with, and every
    millimetre derived from that is a pixel count wearing a unit. The scale bar is drawn
    unbidden on every frame, so on a 2048-column CR whose real detector pitch is 0.143 mm
    it printed a round number of fabricated millimetres — wrong by a factor of seven, with
    nothing on screen distinguishing it from a bar derived from a stated spacing.

    `scaleBarOf`'s own docstring already promised to refuse this. The code did not.
    """
    loader = _code(_js("image", "volume.js"))
    assert "hasPixelSpacing:" in loader, (
        "volume.js substitutes a pixel spacing and records nothing, so nothing downstream "
        "can tell a measured millimetre from an assumed one"
    )

    geometry = _code(_js("render", "transform.js"))
    bar = geometry[geometry.index("export function scaleBarOf("):]
    bar = bar[: bar.index("\n}")]
    assert "hasPixelSpacing === false" in bar, (
        "scaleBarOf draws a bar from the substituted spacing, which its own docstring says "
        "it must not"
    )
    one = geometry[geometry.index("export function zoomForOneToOne("):]
    one = one[: one.index("\n}")]
    assert "hasPixelSpacing === false" in one, (
        "1:1 is derived from a fit built on a spacing nobody stated"
    )

    # A reconstruction inherits it: the in-plane axis comes straight from (0028,0030).
    mpr = _code(_js("image", "mpr.js"))
    assert "hasPixelSpacing: first.hasPixelSpacing" in mpr, (
        "the reconstruction branch drops the flag, so a coronal of an uncalibrated series "
        "reports millimetres again"
    )

    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    assert "pixel spacing not recorded" in app, (
        "the absence is hidden rather than rendered, so a series that did not state its "
        "spacing looks the same as a viewer with no scale bar"
    )


def test_a_distance_is_only_called_millimetres_when_something_measured_them() -> None:
    """A caliper on an uncalibrated frame measured pixels. Saying `84.0 mm` is the same
    category error as printing `HU` on a PET, and both renderers must make it once."""
    units = _code(_js("image", "units.js"))
    assert "export function distanceText(" in units and "export function areaText(" in units
    body = units[units.index("export function distanceText("):]
    body = body[: body.index("\n}")]
    assert "px" in body and "NO_SCALE" in body, (
        "distanceText does not fall back to the pixel distance, so there is nothing "
        "honest for it to show"
    )

    measure = _code(_js("image", "measure.js"))
    assert "spacingStated:" in measure, "the flag does not travel with the measurement"
    body = measure[measure.index("export function length("):]
    body = body[: body.index("\n}")]
    assert re.search(r"Math\.hypot\(b\.x - a\.x, b\.y - a\.y\)", body) and "px }" in body, (
        "length() does not report the pixel distance, which is the only one it measured "
        "on a frame with no stated spacing"
    )

    for module, name in (("render", "annotations.js"), ("ui", "measurements-panel.js")):
        code = _code(_js(module, name))
        assert "distanceText(" in code, f"{name} prints mm without asking whether they are mm"


def test_an_roi_that_measured_nothing_is_not_reported_as_a_number() -> None:
    """An ROI inside the out-of-field corner excludes every pixel it encloses.

    The running mean is then never updated and the row read `NaN +/- NaN HU`. `NaN` is what
    a program prints when it has lost a number; it is not a statement about the region, and
    a reader cannot tell it from a bug in the viewer.
    """
    units = _code(_js("image", "units.js"))
    assert "export function emptyRegionNote(" in units
    body = units[units.index("export function emptyRegionNote("):]
    body = body[: body.index("\n}")]
    assert "count > 0" in body, "the empty case is not detected from the measured count"
    assert "padding" in body, "the note does not say why nothing was measured"

    for module, name in (("render", "annotations.js"), ("ui", "measurements-panel.js")):
        code = _code(_js(module, name))
        assert "emptyRegionNote(" in code, (
            f"{name} renders an all-padding ROI as a number"
        )


def test_the_slab_strip_asks_the_module_whether_a_thickness_can_be_built() -> None:
    """The toolbar had its own copy of `slabPlan`'s refusal and the two disagreed.

    In both directions: a MIP button lit over a slice no projection had touched, because
    the lit state was keyed on a slab having been REQUESTED; and a thickness buildable on a
    0.70 mm coronal was carried to a 3.0 mm axial where `slabPlan` returns null, leaving the
    control on over an unprojected slice.
    """
    mpr = _code(_js("image", "mpr.js"))
    assert "export function slabHalf(" in mpr, (
        "there is no shared feasibility test, so the toolbar must re-derive one"
    )
    plan = mpr[mpr.index("function slabPlan("):]
    plan = plan[: plan.index("\n}")]
    assert "slabHalf(" in plan, "slabPlan does not use the function it exports for this"

    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    builder = app[app.index("function buildSlabButtons()"):]
    builder = builder[: builder.index("\n}")]
    assert "slabHalf(" in builder, (
        "the strip still decides feasibility itself, so it can disagree with the module "
        "that actually refuses"
    )
    assert re.search(r"Math\.floor\(\(mm / step", builder) is None, (
        "the strip kept a second copy of the arithmetic"
    )
    assert "p.frame.projection" in builder, (
        "the lit state is keyed on what was asked for rather than on what was drawn"
    )


def test_a_slab_refuses_a_series_whose_slices_are_unevenly_spaced() -> None:
    """The axial PLANE is exempt from that refusal because it selects a frame. A slab is
    not: it crosses them, and quotes its thickness as positions times the MEDIAN gap, so a
    slab straddling a two-block join states a distance the rays did not travel."""
    mpr = _code(_js("image", "mpr.js"))
    assert "projection_needs_uniform_spacing" in mpr, (
        "a slab on a non-uniformly spaced series is projected and labelled at the median "
        "spacing"
    )
    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    builder = app[app.index("function buildSlabButtons()"):]
    builder = builder[: builder.index("\n}")]
    assert "uniformSpacing === false" in builder, (
        "the toolbar offers a thickness that reslice will throw on"
    )


def test_a_layout_change_carries_everything_a_panel_is() -> None:
    """Anything missing from the carried list resets while the toolbar describes the old
    panel. `slab` and the view transform were both absent: a reader in a 20 mm MIP who
    pressed 2x2 got an unprojected slice under a lit MIP button."""
    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    body = app[app.index("function setLayout("):]
    body = body[: body.index("\n}")]
    # BOTH HALVES. A field named only in the restore is not carried: the snapshot has to
    # capture it too, and `slab` appearing in the Object.assign satisfied a looser check
    # while the snapshot had dropped it.
    snapshot = body[: body.index("el.grid.innerHTML")]
    restore = body[body.index("el.grid.innerHTML"):]
    for field in ("slab", "transform", "oneToOne", "zoom", "pan"):
        assert field in snapshot, f"setLayout does not SNAPSHOT {field} before the rebuild"
    # And the snapshot has to be APPLIED. Naming a field in the capture and never putting
    # it back is the same reset with an extra step, so both carriers are named here: the
    # panel field directly, and the viewport's whole view object in one assign.
    assert "slab: old.slab" in restore, "the captured slab is never put back"
    assert re.search(r"Object\.assign\(p\.viewport, old\.view\)", restore), (
        "the captured view is never put back, so zoom, pan, transform and the 1:1 mode all "
        "return to a fresh viewport's defaults while the toolbar describes the old panel"
    )
    for builder in ("buildSlabButtons()", "buildOrientButtons()", "buildZoomButtons()"):
        assert builder in body, (
            f"setLayout never calls {builder}, so that strip keeps whatever it said before "
            f"the layout changed under it"
        )


def test_linking_the_zoom_clears_the_target_panel_s_own_zoom_mode() -> None:
    """`draw` re-derives 1:1 from the target's own geometry, so a linked panel still in
    that mode overwrote the zoom it was just handed — and went on showing a different
    magnification while the control said the panels were linked."""
    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    body = app[app.index("function applyViewFrom("):]
    body = body[: body.index("\n}")]
    assert "oneToOne = false" in body, (
        "the propagated zoom is discarded by the target's next draw"
    )


def test_the_one_to_one_zoom_asks_for_the_size_the_canvas_is_about_to_have() -> None:
    """The backing store is resized inside `render`, which runs after this. Reading
    `canvas.width` there gave the PREVIOUS frame's size, so a window resize magnified the
    picture by the ratio of the two while the control still claimed 1:1."""
    viewport = _code(_js("render", "viewport.js"))
    assert "deviceSize()" in viewport, "there is no way to ask the size before the render"
    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    assert "p.viewport.deviceSize()" in app, (
        "app.js reads the stale backing store to derive a zoom it calls exact"
    )
    body = app[app.index("function draw(p) {"):]
    body = body[: body.index("\nfunction ")]
    assert "p.canvas.width" not in body, (
        "draw still reads the backing store directly, which is a frame behind on any resize"
    )


def test_the_shear_flag_means_what_the_volume_layout_does() -> None:
    """`sheared` gated the fill; `Math.round` decided the layout. At a row offset of exactly
    0.5 they disagreed: the volume grew a row and every slice moved down one, while
    `sheared` said false — so `volumeOf` skipped the fill and the vacated rows stayed
    zero-initialised and UNDECLARED. Not padding, so an ROI over them averaged in a value
    no scanner produced."""
    mpr = _code(_js("image", "mpr.js"))
    body = mpr[mpr.index("function shearOf("):]
    body = body[: body.index("\nfunction ")]
    assert re.search(r"sheared:\s*Math\.max\(\.\.\.rounded\)\s*!==\s*Math\.min\(\.\.\.rounded\)", body), (
        "the shear flag is decided from a threshold on the raw offsets rather than from "
        "the rounded displacement the volume layout applies"
    )
    assert mpr.count("Math.round(o)") == 1, (
        "the offsets are rounded in more than one place, which is how the flag and the "
        "layout came to disagree in the first place"
    )


def test_draw_never_leaves_the_previous_plane_under_the_new_plane_s_label() -> None:
    """`draw` had no try, and two of reslice's four refusals had no surface guard.

    Press Coronal on a series with a per-frame Modality LUT and the throw went straight out
    of draw: the canvas kept the PREVIOUS plane's pixels while the HUD, the orientation
    letters, the scale bar and the toolbar all described the new one. A picture of one
    plane labelled as another is the worst shape a refusal can fail in.

    Every reachable refusal is guarded before the control that reaches it, so this should
    never fire — which is exactly what was true of the two guards that turned out to be
    missing.
    """
    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    body = app[app.index("function draw(p) {"):]
    body = body[: body.index("\nfunction ")]
    assert re.search(r"try \{\s*frame = reslice\(", body), (
        "draw calls reslice outside a try, so a refusal leaves the last picture on screen"
    )
    catch = body[body.index("} catch"):]
    catch = catch[: catch.index("\n  }")]
    assert "setFrame(null)" in catch, (
        "the catch does not clear the viewport, so the stale pixels stay drawn"
    )
    assert "p.frame = null" in catch, (
        "the catch leaves p.frame set, so the annotation layer goes on measuring a frame "
        "the panel is no longer showing"
    )
    assert "notice(" in catch, "the refusal is swallowed and the reader is told nothing"


def test_a_projected_axial_records_no_single_instance() -> None:
    """The axial branch spreads the centre frame, which carries its SOPInstanceUID.

    A slab crosses eleven of them, so a measurement taken on the projection recorded the
    provenance of whichever slice happened to be in the middle — a claim about where the
    number came from that is false for ten of the eleven instances it came from. The
    reconstruction branch already says null here, and an axial slab is no more a single
    instance than a coronal is.
    """
    body = _reslice_body()
    axial = body[body.index("if (plane === PLANES.AXIAL)"):]
    axial = axial[: axial.index("const common = {")]
    assert re.search(r"projection: \{ \.\.\.plan\.note", axial), axial[:200]
    plan_branch = axial[axial.index("...(plan ?"):]
    assert "sopInstanceUID: null" in plan_branch, (
        "a projected axial keeps the centre slice's instance UID, so a measurement over a "
        "slab claims the provenance of one of the slices it crossed"
    )
    assert "frameNumber: null" in plan_branch, (
        "the frame number survives the projection for the same reason"
    )


# --------------------------------------------------------------------------------------
# Three the skeptics refuted and should not have
#
# The audit's adversarial verification erred in BOTH directions. Three of its twelve
# confirmations rested on a claim that a one-character edit left all 95 gates green — the
# named gates went red when run. And three of its eight refutations were wrong: the defects
# below all reproduce from the code, and each is gated here.
# --------------------------------------------------------------------------------------


def test_a_caliper_on_a_projection_says_it_was_taken_on_one() -> None:
    """The ROI path carried the note from the start; the length path never did.

    The omission was justified by a comment in mpr.js claiming an in-plane caliper on a MIP
    is "as valid as on a slice". The in-plane GEOMETRY is unchanged, which is what that was
    reaching for — but a projection composites structures from different slices, so the two
    points the reader clicked may be 12 mm apart in z while the caliper reports only their
    separation in the plane. The number is a projected distance and reads as a distance
    between two structures.
    """
    for module, name in (("render", "annotations.js"), ("ui", "measurements-panel.js")):
        code = _code(_js(module, name))
        block = code[code.index("kind === 'length'"):]
        block = block[: block.index("}")]
        assert "projectionNote" in block, (
            f"{name} renders a caliper without saying whether it was taken on a projection, "
            f"so a distance across a 26 mm slab is indistinguishable from one on a slice"
        )

    # And the comment that justified leaving it out must not still claim otherwise.
    mpr = _js("image", "mpr.js")
    assert "as valid as on a slice" not in mpr, (
        "mpr.js still asserts that an in-plane caliper on a projection is as valid as one "
        "on a slice, which is the claim that kept the note off the length path"
    )


def test_a_measurement_is_drawn_only_on_the_series_it_was_taken_from() -> None:
    """A plane and a slice number are not an address.

    `onThisSlice` matched those two fields alone, so in a 2x2 with two series loaded a
    caliper taken on series A at axial slice 33 was drawn again over series B's slice 33 —
    on anatomy it was never taken from, at full fidelity, with its number beside it.
    """
    measure = _code(_js("image", "measure.js"))
    assert "seriesUID: location.seriesUID" in measure, (
        "a measurement does not record which series it was taken from"
    )

    annotations = _code(_js("render", "annotations.js"))
    body = annotations[annotations.index("const onThisSlice"):]
    body = body[: body.index(";")]
    assert "seriesUID" in body, (
        "the annotation layer selects by plane and slice index alone, so a measurement is "
        "drawn on every panel that happens to show the same slice number"
    )

    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    # The annotation layer still receives a literal; the TOOL receives a live view of the
    # panel. Both must carry the series, and the tool's must be read when the reader draws
    # rather than captured when the button was pressed -- see the next test.
    assert "seriesUID: p.seriesUID }" in app, (
        "the annotation layer is not told which series the panel is showing"
    )
    assert "get seriesUID() { return p.seriesUID; }" in app, (
        "the armed tool cannot tell which series a measurement belongs to"
    )


def test_an_armed_tool_reads_its_address_when_the_reader_draws_not_when_it_was_armed() -> None:
    """A tool is armed and then used, and the panel can move in between.

    `armTool` passed `{ plane: p.plane, index: p.index, seriesUID: p.seriesUID }` -- an
    object literal, evaluated once, at the moment the toolbar button was pressed. Every
    field of the committed record then came from one of two different times: `sliceIndex`,
    `plane` and `seriesUID` from arm time; `sopInstanceUID`, `pixelSpacing`, `valueUnit` and
    the arithmetic itself from `panel.frame` at commit time.

    `dragTool`'s exposure was bounded -- press, drag, release -- so the window was one
    gesture long. `angleTool` is the first gesture in this viewer that spans arbitrary time:
    three separate clicks with the tool armed throughout, which makes scrolling between them
    an ordinary thing to do rather than a contrivance. Nothing stopped it, and
    `annotations.js` draws the preview UNFILTERED while committed measurements are filtered
    by slice -- so the half-placed angle followed the reader to the new slice, they aimed the
    vertex at what they could see, and the finished measurement was filed on the slice they
    had left and drawn there across anatomy it was never measured on.

    Two things are asserted because either alone is insufficient: the address must be live,
    AND a gesture must not be allowed to span slices at all. A live address on a gesture
    spanning two slices would file it on the last one, which is no more true than the first.
    """
    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    # SCOPED TO `armTool`. The same literal appears in the `annotations.render` call and is
    # correct there: that runs on every draw, so it is built fresh each frame. What matters
    # is the one handed to a tool that outlives the moment it was created.
    arm = app[app.index("function armTool(tool)"):]
    arm = arm[: arm.index("\nfunction ")]
    for field in ("plane", "index", "seriesUID"):
        assert f"get {field}() {{ return p.{field}; }}" in arm, (
            f"the tool's {field} is captured when the tool is armed rather than read when "
            f"the reader commits"
        )
    assert "{ plane: p.plane, index: p.index, seriesUID: p.seriesUID }" not in arm, (
        "the arm-time snapshot is still handed to the tool"
    )
    assert "armed.panel === source" in app, (
        "scrolling does not discard a half-placed measurement, so its points end up spread "
        "across two slices"
    )
    assert "armed.panel === p" in app, (
        "changing plane does not discard a half-placed measurement, and its points mean "
        "something else entirely on a different plane"
    )

    # AND CHANGING WHICH PANEL IS ACTIVE. The handlers close over the panel that was active
    # when the tool was armed, so afterwards `pixelAt(panel, event)` resolves a click on the
    # new panel against the old panel's viewport -- and `draw` shows the preview on whichever
    # panel is active, so a half-placed measurement appears over a different series.
    active = app[app.index("function setActive(i)"):]
    active = active[: active.index("\n}")]
    assert "if (armed) armTool(armed.tool);" in active, (
        "switching panels leaves the armed tool bound to the panel the reader has left"
    )

    # The preview is filtered by the same predicate as a committed measurement. With the
    # three discards above it should never reject anything, which is the point: an invariant
    # nothing checks is one that stops holding quietly, and this one held for exactly as
    # long as no tool had a gesture that outlived a single press.
    annotations = _code(_js("render", "annotations.js"))
    assert "if (preview && onThisSlice(preview))" in annotations, (
        "the in-progress shape escapes the slice filter that committed measurements obey"
    )


def test_a_click_to_place_tool_gets_its_pointer_moves() -> None:
    """`onMove` was dispatched only while a button was held.

    `p._measuring` is set in `onDown` and cleared in `onUp`, so the condition described a
    press-and-hold exactly -- and `angleTool` not at all. Its three points are placed with
    three separate clicks, and between them the button is up, so its `onMove` never ran: the
    ray did not follow the cursor and the reader placed the vertex with nothing to aim at.

    Both tools already guard themselves -- `dragTool` returns false without an anchor and
    `angleTool` without a point -- so the gate was redundant as well as wrong, and removing
    it leaves pan and window reached exactly as before by the tools' own false answer.
    """
    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    assert "if (armed && armed.handlers.onMove(e))" in app, (
        "pointer moves are gated on a held button, so a click-to-place tool never sees one"
    )
    assert "p._measuring && armed" not in app, "the drag-only gate is still in place"


def test_a_one_frame_series_does_not_print_a_slice_pitch_it_never_measured() -> None:
    """`spacingOf` stands 1 mm in when there are fewer than two frames, because there are
    no gaps to measure. The HUD printed it as "1.00 mm" beside the slice counter — the same
    defect as the substituted pixel spacing, one field along."""
    loader = _code(_js("image", "volume.js"))
    assert "hasSliceSpacing" in loader, (
        "the loader does not record whether the slice pitch was measured or stood in"
    )
    body = loader[loader.index("function spacingOf("):]
    body = body[: body.index("\n}")]
    assert "stated: false" in body and "stated: true" in body, (
        "spacingOf reports the same shape whether it measured the gaps or invented one"
    )

    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    assert "slice pitch not recorded" in app, (
        "the HUD prints the stand-in as a measured distance"
    )


def test_the_measurements_list_says_when_a_row_belongs_to_another_series() -> None:
    """The annotation layer stopped DRAWING across series; the list cannot stop showing.

    A plane and a slice number are not an address, so with two series loaded "length axial
    33" names a row in each and the two are identical. The overlay's answer — draw it only
    on the series it came from — is wrong for a list, because the list is the session's
    record and a measurement does not cease to exist when the reader looks elsewhere. So
    the row is shown and marked.
    """
    code = _code(_js("ui", "measurements-panel.js"))
    assert "another series" in code, (
        "a row from a series other than the one on screen is indistinguishable from one "
        "taken on it"
    )
    assert re.search(r"panels\[active\]", code), (
        "the panel has no idea which series is on screen, so it cannot mark the rows that "
        "are not from it"
    )
    sub = code[code.index("subscribeTo("):]
    sub = sub[: sub.index(")")]
    for key in ("panels", "active"):
        assert key in sub, (
            f"the panel does not re-render on `{key}`, so the marks go stale the moment "
            f"the reader switches panel"
        )


def test_every_reachable_view_transform_is_a_signed_permutation() -> None:
    """This is the invariant `unapplyTransform` rests on, and it was never written down.

    `screenToImage` inverts the view transform by TRANSPOSING it, which is exact only for an
    orthogonal matrix. The comment says so; nothing checked it. The check is a closure
    argument rather than a search, and it is short enough to be mechanical:

      * `NO_TRANSFORM` is the identity, which is a signed permutation;
      * each of the three generators is a signed permutation;
      * signed permutations are closed under matrix product;
      * `compose` IS the matrix product, and it is the only way a transform is built.

    Therefore every matrix the viewer can reach has exactly one non-zero entry per row and
    per column, that entry is ±1, and its transpose is its inverse exactly — in integers,
    with no division and no float error. A generator that broke this would make a caliper
    land at a point the picture is not, on a rotation that still looked right.
    """
    code = _code(_js("render", "transform.js"))

    def signed_permutation(m: list[float]) -> bool:
        a, b, c, d = m
        rows_ok = (abs(a) == 1 and b == 0) or (a == 0 and abs(b) == 1)
        cols_ok = (abs(c) == 1 and d == 0) or (c == 0 and abs(d) == 1)
        # and the two non-zeros must not share a column
        distinct = (a != 0) != (c != 0)
        return rows_ok and cols_ok and distinct

    identity = re.search(r"export const NO_TRANSFORM = \[([^\]]+)\]", code)
    assert identity, "there is no identity to compose onto"
    assert [float(v) for v in identity.group(1).split(",")] == [1, 0, 0, 1]

    generators = {}
    for name in ("rotatedRight", "flippedHorizontally", "flippedVertically"):
        body = code[code.index(f"export function {name}("):]
        body = body[: body.index("\n}")]
        lit = re.search(r"compose\(\[([^\]]+)\]", body)
        assert lit, f"{name} does not compose a literal matrix onto the current one"
        generators[name] = [float(v) for v in lit.group(1).split(",")]

    for name, m in generators.items():
        assert signed_permutation(m), (
            f"{name} is not a signed permutation, so composing it produces a matrix whose "
            f"transpose is not its inverse — and screenToImage inverts by transposing, so "
            f"every click would land somewhere the picture is not"
        )

    # And `compose` must be the actual product, or closure says nothing about what it makes.
    body = code[code.index("function compose(b, a) {"):]
    body = body[: body.index("\n}")]
    for term in (
        r"b\[0\] \* a\[0\] \+ b\[1\] \* a\[2\]", r"b\[0\] \* a\[1\] \+ b\[1\] \* a\[3\]",
        r"b\[2\] \* a\[0\] \+ b\[3\] \* a\[2\]", r"b\[2\] \* a\[1\] \+ b\[3\] \* a\[3\]",
    ):
        assert re.search(term, body), (
            "compose is not the matrix product, so the closure argument that keeps every "
            "reachable transform invertible-by-transpose does not hold"
        )


# --------------------------------------------------------------------------------------
# Oblique planes: the two numbers that only differ here
#
# Axial, coronal and sagittal select voxels ALONG the lattice, so one step across the
# picture is one voxel and the sample pitch IS the resolvable detail. An oblique cuts across
# it and they come apart.
#
# MEASURED on the phantom at `oblique x+45.0 deg` (0.70 mm pixels, 2.0 mm slices):
#
#     grid                448 x 252, depth 252      the full bounding extent, every index
#     pixelSpacing        [0.9899, 0.700]           what the samples are spaced at
#     resolutionMm        [2.8284, 0.700]           what they can resolve
#     paddingValue        -1000 HU                  declared at every index
#     sopInstanceUID      null                      the plane crosses all of them
#     10 mm slab          9 slices, 8.9095 mm       NOT the round 10.0 a fall-through gives
#     nodule down rows    8 samples                 phase-dependent; see below
#     nodule across cols  11 samples, 7.00 mm       exact
#
# THE MECHANISM, measured directly rather than inferred from the counts: one step along the
# plane's row axis advances the SOURCE row by 1.000 and the SOURCE slice by -0.350. An
# implementation that rotated index coordinates as though the voxels were cubes would
# advance both by 0.7071, and the nodule would read 5 samples instead of 8 -- a solid
# measuring 7.9 mm reading 4.0 mm. Both look like a round blob.
#
# The row count is 8 and not the 9 the design predicted, because the grid is anchored to the
# volume's bounding box rather than to any voxel: the nearest sample to the nodule centre
# lands at source row 149.571, not 150. That is a phase offset, not a defect, which is why
# the gate below pins the STEP and not the count.
# --------------------------------------------------------------------------------------


def test_an_oblique_states_a_pitch_and_a_resolution_for_each_of_its_own_axes() -> None:
    """A 0.99 mm row carrying 2.83 mm of detail is a value that is not what it appears to be.

    The only thing that can say so is a second number from the SAME formula on the SAME
    axis. Asked with the axes crossed, the sentence survives and points at the wrong edge:
    the columns, which resolve exactly, would be reported as the coarse ones.
    """
    code = _code(_js("image", "oblique.js"))
    body = code[code.index("export function obliqueGrid("):]
    body = body[: body.index("\n}")]

    assert re.search(r"const along1 = crossingsAlong\(stack, e1\)", body), body[:300]
    assert re.search(r"const along2 = crossingsAlong\(stack, e2\)", body), body[:300]
    # Rows come from e2 and columns from e1, on BOTH, and crossed on neither.
    assert "pixelSpacing: [along2.pitchMm, along1.pitchMm]" in body, (
        "the oblique's pitch has its axes crossed, so the picture is drawn on the wrong grid"
    )
    assert "resolutionMm: [along2.coarsestMm, along1.coarsestMm]" in body, (
        "the oblique's resolution has its axes crossed, so the note names the wrong edge -- "
        "the columns resolve exactly and would be reported as the coarse ones"
    )

    # ONE formula for "how far apart". Two is how the HUD and the slab came to disagree once
    # already, one function apart.
    assert len(re.findall(r"^export function crossings", code, re.M)) == 1
    # The step along the plane's own normal comes from the same formula. `sliceSpacing`
    # appears in this function legitimately -- it places the volume's bounding corners --
    # so the check names the field rather than forbidding the word.
    # AND THE FUNCTION ITSELF. The gate checked which result feeds which field and asserted
    # nothing about the one function its own docstring calls the single decision point:
    # swapping the two values at its return made every consumer read the opposite number,
    # sampling the plane every 2.83 mm down an axis whose value changes every 0.99 mm --
    # and silencing resolutionNote, because the "resolution" was then the finer of the two.
    crossings = code[code.index("export function crossingsAlong("):]
    crossings = crossings[: crossings.index("\n}")]
    assert re.search(r"if \(crossing < pitchMm\) pitchMm = crossing;", crossings), (
        "pitchMm is not the MINIMUM crossing, so the plane is sampled coarser than its "
        "value changes and detail is discarded between samples"
    )
    assert re.search(r"if \(crossing > coarsestMm\) coarsestMm = crossing;", crossings), (
        "coarsestMm is not the MAXIMUM crossing, so the resolution claimed is finer than "
        "the plane can carry and resolutionNote goes silent on the planes that need it"
    )
    assert "pitchMm = Infinity" in crossings and "coarsestMm = 0" in crossings, (
        "the two accumulators do not start at the extremes their comparisons need"
    )

    assert "stepMm: alongN.pitchMm" in body, (
        "the oblique's step between planes is not derived from its own normal, so a slab "
        "through it is quoted at a named plane's spacing"
    )


def test_the_oblique_rotation_is_in_patient_space_and_not_in_index_space() -> None:
    """This is the invisible version of the feature, and only the mechanism catches it.

    Rotating index coordinates as though the voxels were cubes produces a picture that looks
    entirely correct: the phantom's nodule is still a round blob, still centred, still the
    right density. It is simply the wrong size -- 5 samples where the patient-space map
    gives 8, a solid measuring 7.9 mm reading 4.0 mm.

    Measured on the real stack: one step along the plane's row axis advances the source row
    by exactly 1.000 and the source slice by -0.350. Index space gives 0.7071 for both.
    """
    code = _code(_js("image", "oblique.js"))
    body = code[code.index("export function obliqueSample("):]
    body = body[: body.index("\n}")]

    # The output pixel is placed in PATIENT millimetres, ALONG THE RIGHT AXIS AT THE RIGHT
    # PITCH. The gate used to pin only the row line, so swapping the destructure to
    # `const [colStep, rowStep] = grid.pixelSpacing` walked the rows at 0.700 mm and the
    # columns at 0.9899 mm while the frame went on declaring [0.9899, 0.700]: the phantom's
    # 7.00 mm sphere read 4.9 mm across and 11.2 mm down, and the gate stayed green.
    assert "const [rowStep, colStep] = grid.pixelSpacing;" in body, (
        "the two pitches are not bound to their own axes, so the sampler can walk the rows "
        "at the column pitch while the frame declares the opposite"
    )
    assert re.search(r"origin\[0\] \+ r \* rowStep \* grid\.e2\[0\]", body), (
        "the row axis is not stepped in millimetres along the plane's own direction"
    )
    assert re.search(r"br\[0\] \+ cIdx \* colStep \* grid\.e1\[0\]", body), (
        "the column axis is not stepped at the column pitch along the kept lattice axis"
    )
    # ...and converted back through the SOURCE's direction cosines AND spacings. An
    # index-space implementation divides by nothing.
    for axis, spacing in (("ex", "colMm"), ("ey", "rowMm"), ("n", "stack.sliceSpacing")):
        # `Math.round` on THIS conversion. Asking whether the function rounds anywhere was
        # satisfied by the other two while this one returned a fraction.
        pattern = (r"Math\.round\(\(qx \* " + axis + r"\[0\] \+ qy \* " + axis
                   + r"\[1\] \+ qz \* " + axis + r"\[2\]\) / " + re.escape(spacing))
        assert re.search(pattern, body), (
            "the " + axis + " component is not divided by " + spacing + ", so the plane is "
            "rotated in index space and every distance along its oblique axis is wrong by "
            "the anisotropy"
        )
    assert body.count("Math.round(") == 3, (
        "all three index conversions must round to a whole voxel; a fractional one is an "
        "interpolation this module refuses to do"
    )


def test_an_oblique_plane_has_exactly_one_name_and_one_place_mints_it() -> None:
    """`plane` is an ADDRESS: the key `annotations.js` matches measurements on with `===`,
    the string app.js writes into a dataset, the cell the panel escapes. Two spellings of
    one plane are two addresses, and a caliper recorded under the second is listed forever
    and drawn never."""
    minted = []
    for path in sorted(SRC.rglob("*.js")) + [VIEWER / "app.js"]:
        code = _code(path.read_text(encoding="utf-8"))
        if re.search(r"`oblique \$\{", code):
            minted.append(path.name)
    assert minted == ["oblique.js"], (
        "the oblique plane name is constructed in more than one place: " + repr(minted)
    )

    code = _code(_js("image", "oblique.js"))
    body = code[code.index("export function obliqueName("):]
    body = body[: body.index("\n}")]
    assert "Number(deg.toFixed(DECIMALS))" in body, (
        "the angle is not canonicalised before the name is built, so 45 and 45.0 are two "
        "names for one plane -- and a measurement recorded under the second is listed "
        "forever and drawn never"
    )
    assert re.search(r"Math\.abs\(rounded\) >= 90", body), (
        "90 degrees is the coronal under a second name, and a measurement taken there would "
        "not be drawn on the plane that already has that name"
    )
    assert re.search(r"!\(Math\.abs\(rounded\) > 0\)", body), (
        "0 degrees is the axial under a second name"
    )


def test_an_oblique_marks_its_overhang_rather_than_valuing_it() -> None:
    """A rectangle around a rotated volume has corners the acquisition never reached, at
    EVERY index -- not only where a shear correction moved a slice.

    The sampler has to put SOME number there, and the only ones available are the declared
    (0028,0120) or, when the series declares none, the volume's MINIMUM. That minimum is
    real acquired air. Declaring it as padding excluded genuine air from every ROI on the
    plane and counted it in `excluded`, which is a wrong number reported confidently.

    So the overhang is a per-pixel MASK, which is exact, and a padding VALUE is passed on
    only when the header stated one.
    """
    body = _reslice_body()
    branch = body[body.index("if (isOblique(plane))"):]
    branch = branch[: branch.index("const g = geometryOf")]
    returned = branch[branch.index("return {"):]

    assert "outside: cut.outside" in returned, (
        "the oblique frame carries no out-of-volume mask, so either the overhang is "
        "averaged in as tissue or it is declared by a value that collides with real data"
    )
    assert "paddingValue: first.paddingValue ?? null" in returned, (
        "the oblique declares an INVENTED padding value -- `fillValueOf` falls back to the "
        "volume minimum, which is real air, so every ROI on the plane excludes it"
    )
    assert "fillValueOf(stack)" in branch, "there is no fill for the region outside the volume"

    # AND THE SAMPLER MUST SET IT. The mask is allocated and carried in `mpr.js`; it is
    # written in `oblique.js`, and gutting the write there leaves an all-zero mask that
    # every consumer reads as "every sample was measured" -- with the frame no longer
    # declaring a padding value either, so nothing excludes the overhang at all.
    sampler = _code(_js("image", "oblique.js"))
    body = sampler[sampler.index("export function obliqueSample("):]
    body = body[: body.index("\n}")]
    assert "outside[at] = 1;" in body, (
        "the sampler never marks the samples it filled, so the mask it returns says the "
        "acquisition reached every pixel of a rotated rectangle"
    )
    assert re.search(r"return \{ pixels: out, overlay: ovr, outside \}", body), (
        "the sampler does not return the mask it built"
    )
    # Unconditional: not gated on `sheared` the way the reconstruction fill is.
    assert "g.sheared" not in branch, (
        "the oblique's overhang is gated on a shear correction, which has nothing to do "
        "with whether the rotated rectangle overhangs the volume"
    )
    # And a slab's overhang is where EVERY ray was outside, not where the centre plane was.
    assert re.search(r"cut\.outside\[i\] = seeded\[i\] \? 0 : 1", branch), (
        "a projected oblique reports the centre plane's overhang, so a pixel a ray reached "
        "on another plane of the slab is still excluded from an ROI"
    )

def test_every_plane_reports_its_own_depth() -> None:
    """NOTHING LOOKED AT planeDepth, and adding the oblique case deleted the coronal one.

    From 69ad5f4 until this gate existed, `planeDepth(stack, CORONAL)` fell through to
    `stack.depth` -- 64 instead of 320 on this project's phantom. The coronal showed the
    first 64 of its 320 rows, the scrollbar covered a fifth of the volume, and the panel
    opened at row 32 instead of 160. The HUD read "coronal 33 / 64", which is a true
    statement about a number the function returned and a false one about the anatomy.

    115 gates were green across that commit. The function had none.
    """
    code = _code(_js("image", "mpr.js"))
    body = code[code.index("export function planeDepth("):]
    body = body[: body.index("\n}")]

    assert "isOblique(plane)" in body, "an oblique falls through to the source's slice count"
    assert re.search(r"plane === PLANES\.CORONAL\) return geometryOf\(stack\)\.volumeRows", body), (
        "the coronal does not index the VOLUME's height, so on a sheared stack it stops "
        "short of the correction and on any stack it reports the slice count instead"
    )
    assert re.search(r"plane === PLANES\.SAGITTAL\) return stack\.columns", body), (
        "the sagittal does not index the column axis"
    )
    # Four planes, four answers, and none of them the same expression.
    returns = re.findall(r"return ([^;]+);", body)
    assert len(returns) == 4, f"planeDepth does not answer for all four planes: {returns}"
    assert len(set(returns)) == 4, f"two planes share a depth expression: {returns}"


def test_an_oblique_carries_the_padding_range_it_was_given() -> None:
    """A declared (0028,0121) narrowed to a single value on the oblique alone.

    PS3.3 C.7.5.1.1.2: (0028,0120) with (0028,0121) declares a RANGE, which is what a
    scanner writes across the edge of the reconstruction circle. `fillValueOf` returns the
    declared padding value verbatim when the series states one, so the limit stated beside
    it still applies -- and the oblique branch replaced it with null.

    On a series stating -2000..-1200, every pixel from -1999 to -1200 was padding on the
    axial and the coronal and tissue on the oblique: an ROI at the field edge read hundreds
    of HU low while `excluded` under-reported. The reconstruction branch six lines below
    solves exactly this and the comment there says why.
    """
    body = _reslice_body()
    branch = body[body.index("if (isOblique(plane))"):]
    branch = branch[: branch.index("const g = geometryOf")]

    returned = branch[branch.index("return {"):]
    assert "paddingRangeLimit: first.paddingRangeLimit ?? null" in returned, (
        "the oblique frame declares a padding VALUE without the RANGE it came with, so a "
        "declared band reads as tissue on that plane only"
    )
    # And the slab's own predicate, which is built a screen earlier and must carry it too.
    assert "fillValue === first.paddingValue ? first.paddingRangeLimit : null" in branch, (
        "the oblique slab's padding test drops the range, so a MinIP keeps the out-of-field "
        "band along every ray that touches a corner"
    )


def test_the_oblique_basis_is_made_orthonormal_before_it_is_used() -> None:
    """(0020,0037) is seven significant digits, so the stated cosines are not orthogonal.

    A real cardiac short-axis orientation gives `ex . ey = -1.9e-05`. `crossingsAlong` takes
    a MAXIMUM over `spacing / |w . axis|`, which makes that residual a quotient of 70000:
    the frame reported `resolutionMm [52312.08, 36990.23]` millimetres, and the second of
    those is the LATTICE axis the plane keeps -- the one axis this module promises resolves
    exactly. The pitch and the picture were unaffected, because a minimum is not sensitive
    to a family it barely crosses. Only the sentence on screen was wrong.

    Raising the epsilon until it covers the residual is the wrong fix -- it is a stated
    value that is slightly wrong, and the standard says the two SHALL be orthogonal, so the
    honest reading is the nearest orthonormal pair.

    MEASURED after the fix, all four at `oblique x+45.0 deg` on 0.70 mm / 2.0 mm geometry:
        identity IOP, cardiac short axis, seven-digit MR oblique, and non-unit cosines
        all report resolutionMm [2.828, 0.700] and pixelSpacing [0.9899, 0.700].
    """
    code = _code(_js("image", "oblique.js"))
    assert "function basisOf(stack)" in code, (
        "the source axes are taken from the header as stated, so a rounded orientation "
        "propagates into a maximum that is four orders of magnitude sensitive to it"
    )
    body = code[code.index("function basisOf(stack)"):]
    body = body[: body.index("\n}")]
    assert "dot(rawY, ex)" in body, "the second axis is not projected off the first"
    assert "cross(ex, ey)" in body, (
        "the normal is taken from the stack rather than from the orthonormalised pair, so "
        "it carries the same residual the projection just removed"
    )

    # And nothing reads the raw cosines behind its back.
    for fn in ("crossingsAlong", "obliqueGrid", "obliqueSample", "spanAlong"):
        section = code[code.index(f"function {fn}("):]
        section = section[: section.index("\n}")]
        assert "orientation.slice(" not in section, (
            f"{fn} reads the stated cosines directly instead of the orthonormal basis"
        )


def test_an_oblique_refuses_a_slice_pitch_nothing_measured() -> None:
    """A one-instance series has no gap between slices, so `spacingOf` stands 1 mm in.

    The named plane the instance was acquired on is unaffected -- it SELECTS that instance.
    An oblique cuts at an angle THROUGH the pitch, so every millimetre it reports is derived
    from the stand-in: the spacing it is drawn at, what it resolves, and the thickness of a
    slab through it. `hasSliceSpacing` already records that the pitch was invented, and the
    HUD already renders it as `slice pitch not recorded`; this is the same fact reaching the
    one plane that cannot survive it.
    """
    code = _code(_js("image", "mpr.js"))
    body = code[code.index("export function reconstructionRefusal("):]
    body = body[: body.index("\nexport function")]

    assert "oblique_needs_a_measured_slice_pitch" in body, (
        "an oblique is offered on a one-instance series, where every millimetre it reports "
        "comes from a 1 mm stand-in nothing measured"
    )
    assert "stack.hasSliceSpacing === false" in body, (
        "the refusal does not read the flag the loader sets, so it is guessing at the same "
        "thing from somewhere else"
    )
    # Inside the oblique block, so the named planes keep working on a one-instance series.
    oblique_block = body[body.index("if (isOblique(plane))"):]
    assert "oblique_needs_a_measured_slice_pitch" in oblique_block, (
        "the refusal sits outside the oblique branch, so it takes the axial down with it "
        "on the very series that has exactly one axial to show"
    )

    # All four oblique refusals, and the four that came before them.
    for code_name in (
        "reconstruction_needs_spatial_frames", "spacing_non_uniform",
        "gantry_tilt_uncorrectable", "reconstruction_needs_uniform_rescale",
        "oblique_needs_a_stated_orientation", "oblique_needs_stated_pixel_spacing",
        "oblique_needs_an_unsheared_stack", "oblique_needs_a_measured_slice_pitch",
    ):
        assert code_name in body, f"the enumeration lost {code_name}"


# --------------------------------------------------------------------------------------
# The angle tool, and the three declarations that waited for it
#
# `measure.js` exported `angle()`, `annotations.js` drew `kind === 'angle'` as a polyline
# with handles, and `measurements-panel.js` formatted it -- and nothing could produce one.
# Three declarations reachable only by a tool that did not exist, which is the shape
# `test_no_module_declares_a_dicom_tag_it_never_reads` gates for one directory along.
#
# MEASURED, and the second row is the whole reason the function is written the way it is:
#
#     right angle, 0.70 x 0.70 mm axial      90.000 deg
#     right angle, 2.00 x 0.70 mm coronal    90.000 deg   (axis-aligned scaling keeps it)
#     45 deg in PIXELS, isotropic            45.000 deg
#     45 deg in PIXELS, anisotropic          70.710 deg   <- atan(100*2.0 / 100*0.7)
#
# A viewer measuring in pixel space reports 45 on that coronal and is wrong by 25.7
# degrees, on a picture where 45 is what the reader can see.
# --------------------------------------------------------------------------------------


def test_the_angle_tool_exists_and_is_the_only_caller_angle_ever_had() -> None:
    """Three surfaces anticipated this tool and nothing could reach them."""
    tools = _code(_js("tools", "measure-tools.js"))
    assert "id: 'medos.angle'" in tools, "no angle tool is registered"
    assert re.search(r"angle\(panel\.frame, points\[0\], points\[1\], points\[2\]\)", tools), (
        "the tool does not call `angle` with three points, so whatever it commits is not "
        "the angle at the vertex the reader placed"
    )

    # THREE POINTS, NOT A DRAG. A caliper and an ROI are two corners of one gesture; an
    # angle has a distinguished MIDDLE point, and no two-corner gesture names a vertex.
    # Inferring it from the order of two points reads correctly until a reader starts from
    # the other ray.
    body = tools[tools.index("id: 'medos.angle'"):]
    assert "taken.length < 3" in body, (
        "the tool commits before it has three points, so the vertex is inferred rather "
        "than placed"
    )
    assert re.search(r"Math\.abs\(at\.x - last\.x\) < 1", body), (
        "two coincident clicks make a zero-length ray, and `angle` returns NaN for it -- a "
        "row reading NaN looks like a measurement that failed rather than one never made"
    )


def test_an_angle_is_measured_in_patient_space_and_not_in_pixels() -> None:
    """45 degrees in pixels is not 45 degrees in the patient on an anisotropic frame.

    `angle()` scales each ray by the frame's own spacing before taking the dot product.
    Dropping that is invisible on the phantom's isotropic axial and wrong by 25.7 degrees
    on its 2.00 x 0.70 mm coronal -- measured: the same three points read 45.000 and
    70.710. The pixel answer is the one that looks right on screen, which is what makes it
    dangerous.
    """
    code = _code(_js("image", "measure.js"))
    body = code[code.index("export function angle("):]
    body = body[: body.index("\n}")]
    assert "const [rowMm, colMm] = frame.pixelSpacing;" in body, (
        "angle() does not read the frame's spacing, so it is measuring pixels"
    )
    # x indexes COLUMNS and y indexes ROWS, so x scales by colMm and y by rowMm. Reversing
    # these is plausible on square pixels and wrong on every anisotropic study.
    assert re.search(r"\(a\.x - vertex\.x\) \* colMm, \(a\.y - vertex\.y\) \* rowMm", body), (
        "the ray's components are scaled by the wrong axis, which is right on square "
        "pixels and wrong on every anisotropic frame"
    )
    assert re.search(r"\(b\.x - vertex\.x\) \* colMm, \(b\.y - vertex\.y\) \* rowMm", body), body[:200]
    assert "if (!nu || !nv) return NaN;" in body, (
        "a zero-length ray has no direction, and any number returned for it is invented"
    )


def test_a_partial_angle_shows_no_number_in_either_renderer() -> None:
    """The tool previews after two clicks, and two points are not an angle.

    `NaN degrees` beside a half-placed shape says the measurement failed. It has not been
    made yet, and the difference is what a reader does next.
    """
    for module, name in (("render", "annotations.js"), ("ui", "measurements-panel.js")):
        code = _code(_js(module, name))
        block = code[code.index("kind === 'angle'"):]
        block = block[: block.index("\n  }") + 4]
        # The finiteness check moved INTO `angleText` when the spacing caveat was added, so
        # it is asserted there rather than restated twice here -- but each renderer has to
        # actually go through it, or the check sits somewhere nothing reaches.
        assert "angleText(" in block, (
            f"{name} formats an angle itself instead of going through the one function "
            f"that knows what an unfinished angle and an unstated spacing look like"
        )
    units = _code(_js("image", "units.js"))
    body = units[units.index("export function angleText("):]
    body = body[: body.index("\n}")]
    assert "if (!Number.isFinite(deg)) return '';" in body, (
        "angleText prints whatever it is given, so a two-point preview renders NaN"
    )
    # AND THE CAVEAT, which is why this function exists at all. An angle keeps its unit
    # when the spacing is missing, which is exactly why it was the one measurement printed
    # without one: `angle()` scales its rays by (0028,0030), and against a substituted
    # [1, 1] the number is the angle in the PIXEL GRID -- the patient's only if the pixels
    # happen to be square. Measured: 45.000 degrees in pixels reads 70.710 on a
    # 2.00 x 0.70 mm frame.
    assert "stated ? text :" in body and "NO_SCALE" in body, (
        "an angle computed against a substituted pixel spacing is printed as though the "
        "header had stated one"
    )


def test_no_measurement_helper_is_exported_without_a_caller() -> None:
    """The rule that would have caught this, generalised from `transform.js`.

    `angle()` was exported, carefully commented, gated by nothing and called by nothing --
    for as long as it had existed. Two renderers carried a branch for its output. The
    check that already existed for the geometry module is the same check, so it covers
    both now rather than being rewritten when the next module grows a dead export.
    """
    for folder, module in (("render", "transform.js"), ("image", "measure.js")):
        source = _js(folder, module)
        exported = set(re.findall(r"export function (\w+)", source))
        assert exported, f"{module} exports nothing, which cannot be right"

        callers = "".join(
            path.read_text(encoding="utf-8")
            for path in sorted(SRC.rglob("*.js")) + [VIEWER / "app.js"]
            if path.name != module
        )
        callers = re.sub(r"import\s*\{[^}]*\}\s*from\s*'[^']*';", "", callers)
        callers = _expressions(callers)
        # NOT a bare word-boundary match on the name. That matches `.length` -- which
        # appears 149 times across this source as `Array.prototype.length` -- so the gate
        # was green for `length()` whether or not anything called it. A preceding dot means
        # a property of some other object, not this module's export.
        unused = sorted(
            n for n in exported
            if not re.search(rf"(?<![.\w]){n}\b", callers)
        )
        assert not unused, (
            f"these are exported from {module} and reached by nothing outside it, so they "
            f"are kept for a consumer that does not exist: {unused}"
        )


# --------------------------------------------------------------------------------------
# Position linking, on every plane that has a position
#
# `followIndex` linked two panels by patient position only when BOTH showed the acquired
# axial. Everything else fell to one sentence: "a reconstructed plane has no patient-space
# slice position — align the panels by hand". That was true when a reconstruction was a bare
# row or column index. `reconstructedGeometry` has supplied a position and a normal per
# index since the reference lines were built, and the oblique branch does the same.
#
# MEASURED before: a coronal at index 100 carries position [-156.45, -41.65, 126.00] and an
# oblique at 100 carries [-156.45, -105.65, 134.00] — and both pairs linked `none`.
#
# MEASURED after, one volume shown in two panels, which must land index-for-index:
#
#     axial     index  30 -> 30    position, 0.000 mm
#     coronal   index 100 -> 100   position, 0.000 mm
#     coronal   index 250 -> 250   position, 0.000 mm
#     sagittal  index 300 -> 300   position, 0.000 mm
#     oblique   index 115 -> 115   position, 0.000 mm
#     axial -> coronal             none, and the reason now says why
# --------------------------------------------------------------------------------------


def test_a_plane_ordinate_is_computed_without_resampling_anything() -> None:
    """It runs on every scroll event, so it must cost the trigonometry and nothing else.

    `reconstructedGeometry` and `obliqueGrid` both derive a plane's origin from the stack's
    geometry alone. Reaching for `reslice` here would rebuild the volume to answer a
    question about where a plane is.
    """
    code = _code(_js("image", "mpr.js"))
    body = code[code.index("export function planeOrdinate("):]
    body = body[: body.index("\n}")]

    assert "reslice(" not in body, (
        "planeOrdinate resamples pixels to find out where a plane is, on every scroll"
    )
    assert "obliqueGrid(stack, plane)" in body, "an oblique has no ordinate"
    assert "reconstructedGeometry(stack, plane, at)" in body, (
        "a coronal or sagittal has no ordinate, which is the whole premise the old sync "
        "docstring rested on"
    )
    assert "return f.depth;" in body, (
        "the acquired plane recomputes a projection `volume.js` already did once per frame"
    )
    assert "orientation.length !== 6" in body, (
        "a stack that states no orientation gets an ordinate measured against nothing"
    )


def test_panels_showing_the_same_plane_link_by_position() -> None:
    """Two coronals of one volume correspond exactly, and used to link by nothing."""
    code = _code(_js("image", "sync.js"))
    body = code[code.index("export function followIndex("):]
    body = body[: body.index("\n}")]

    assert "sourcePlane === targetPlane" in body, (
        "the position link is still gated on both panels showing the acquired axial, so "
        "two coronals of one volume do not link"
    )
    assert "planeOrdinate(source, sourcePlane, sourceIndex)" in body, (
        "the source's position along its own normal is never asked for"
    )
    # THE STEP CARRIES ITS SIGN. A coronal's rows may run against its normal, and assuming
    # the step is positive puts the target at the far end of the volume from the reader.
    #
    # THE ARITHMETIC MOVED. It was written twice inline in `followIndex`, where only
    # `followIndex` could reach it; the crosshair needs the same inverse and would have
    # grown a third copy. It is `indexAtOrdinate` now, and this reads it there -- the
    # property is the same, the address is not.
    inverse = code[code.index("export function indexAtOrdinate("):]
    inverse = inverse[: inverse.index(chr(10) + "}" + chr(10))]
    assert re.search(r"const step = next - base;", inverse), (
        "the step between planes is assumed rather than derived from two ordinates, so a "
        "plane whose index runs against its normal links to the opposite end"
    )
    assert "nearestByPosition(stack, want)" in inverse, (
        "the acquired plane lost its binary search inside the inverse, so an unevenly "
        "spaced series is inverted as though every gap were equal"
    )
    assert "indexAtOrdinate(target, targetPlane, want)" in body, (
        "followIndex no longer goes through the one inverse, so there are two of them again"
    )
    # The acquired plane keeps its binary search: a series with uneven spacing or one that
    # overlaps another does not obey the affine map.
    # (the acquired plane's binary search is asserted inside `indexAtOrdinate` above, which
    # is where it now lives)


# --------------------------------------------------------------------------------------
# What the surface asks the archive for, and what it can fit on a screen
# --------------------------------------------------------------------------------------


def test_the_study_list_asks_for_the_fields_it_renders() -> None:
    """`showStudies` rendered (0008,1030) and the query never requested it.

    PS3.18 10.6.1.5 gives QIDO-RS a small REQUIRED study-level return set, and
    StudyDescription is not in it -- a conformant origin may return it and need not. This
    archive does not. So `showStudies`, which has interpolated `00081030` since it was
    written, drew an empty span for every row, and the study list distinguished studies by
    patient name, date, modality and instance count alone. Against the real LCTSC studies
    in the dev archive that column was blank on all three.

    THE SHAPE, and why it is the same one this suite keeps finding: a renderer that reads a
    field nobody asked for. Nothing errored, nothing was logged, and the surface looked
    finished -- an empty span is indistinguishable from a study with no description.

    Found on a pair that made it impossible to ignore: the demo phantom and its
    `--companion` series share a patient, a study, a date and a modality by construction,
    so the two rows were the same row. That pair is synthetic; the arrangement is not.
    """
    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    client = _code(_js("dicom", "dicomweb.js"))

    # Every tag the study card interpolates must be one the query asks for, or one QIDO
    # returns without being asked. The required set is PS3.18 10.6.1.5 Table 10.6.1-5.
    required = {
        "0020000D",  # StudyInstanceUID
        "00080020", "00080030",  # StudyDate, StudyTime
        "00100010", "00100020",  # PatientName, PatientID
        "00100030", "00100040",  # PatientBirthDate, PatientSex
        "00080061",  # ModalitiesInStudy
        "00201206", "00201208",  # NumberOfStudyRelated{Series,Instances}
        "00200010",  # StudyID
    }
    # The worklist row, and the filter that asks the archive for it. Both are scanned: a
    # column the table renders and a key the query sends are the same claim about what the
    # archive was asked for, and either alone can drift from the other.
    row = app[app.index("function renderWorklist()"):]
    row = row[: row.index("\nfunction ")]
    rendered = set(re.findall(r"'([0-9A-Fa-f]{8})'", row))
    assert rendered, "the worklist row interpolates no tags at all, which cannot be right"

    asked = set(re.findall(r"'([0-9A-Fa-f]{8})'", client[client.index("const STUDY_FIELDS"):]))
    unasked = sorted(t for t in rendered - required if t not in asked)
    assert not unasked, (
        f"the study list renders these and the QIDO query neither asks for them nor is "
        f"promised them, so they come out empty on a conformant origin: {unasked}"
    )

    studies = client[client.index("studies({"):]
    studies = studies[: studies.index("\n  }")]
    assert "includefield" in studies, (
        "the study query sends no includefield, so it gets the required minimum only"
    )
    # AND IT ASKS THE ARCHIVE A QUESTION. The worklist sent no match keys, no `limit` and
    # no `offset`: it asked for every study the credential could see and rendered the lot
    # into un-virtualised markup, which is invisible on a developer archive of five and
    # fatal on a real one.
    for key in ("filter", "limit", "offset"):
        assert key in studies, (
            f"the study query takes no {key}, so the worklist cannot ask the archive for "
            f"a subset and must fetch everything"
        )


def test_a_reference_line_is_redrawn_when_the_panel_it_describes_moves() -> None:
    """A panel was redrawn only when it CHANGED SLICE, and a locator is about another panel.

    `referencesOnto` draws, on this panel, where every OTHER panel's plane cuts it. So the
    line goes stale whenever one of those panels moves -- and the panel showing it has no
    reason of its own to redraw. The loop in `setIndex` only ever called `draw` on a panel
    that FOLLOWED the scroll, so a panel that cannot follow was never redrawn at all.

    An axial beside a coronal is exactly that pair: `followIndex` returns a null index for
    it, because neither is a slice of the other. MEASURED against the demo study's two
    series in a 1x2 layout -- the coronal panel carried no reference line in its life, and
    the axial one only picked up a line when something else happened to redraw it.

    THAT IS THE LOCATOR `followIndex`'S OWN REFUSAL POINTS AT: "neither one of them is a
    slice of the other -- the reference line shows where they cross". The sentence sent the
    reader to a line the surface was not drawing, which is this codebase's recurring defect
    in its purest form: prose asserting something the code does not do.

    NOT GATED ON `link.scroll`. That switch decides whether panels FOLLOW one another; where
    two planes cross is geometry and does not depend on a preference.
    """
    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))

    assert "function drawOverlays(p)" in app, (
        "there is no way to refresh a panel's annotation layer without rebuilding its "
        "image, so the only way to move a reference line is to reslice a volume that has "
        "not changed"
    )

    body = app[app.index("function setIndex(source, index, propagate = true) {"):]
    body = body[: body.index("\n}\n")]
    refresh = "for (const t of panels) if (t !== source && t.stack) drawOverlays(t);"
    assert refresh in body, (
        "the other panels' reference lines are not refreshed when this panel moves, so a "
        "panel that cannot follow the scroll never updates its locator"
    )
    # BEFORE the `link.scroll` early return, or the refresh is a preference rather than
    # the geometry it actually is.
    guard = "if (!propagate || !link.scroll || !source.stack) return;"
    assert guard in body, "the link-scroll guard moved; this gate no longer knows where it is"
    assert body.index(refresh) < body.index(guard), (
        "the reference-line refresh sits behind the `link.scroll` switch, so turning linked "
        "scrolling off also freezes every locator -- and where two planes cross is not a "
        "preference"
    )
    assert body.rindex("drawOverlays(source)") > body.index(guard), (
        "this panel's own locator is not refreshed after the followers move, so it still "
        "shows where they were"
    )

    # AND THE SCOPE. `referencesOnto` was declared INSIDE `draw` -- at column zero, which
    # reads like a top-level function and is not one -- so exactly one caller could see it.
    # The first version of `drawOverlays` threw `ReferenceError: referencesOnto is not
    # defined` on every plane change, which the static gates could not have caught.
    assert app.index("function referencesOnto") < app.index("function draw(p) {"), (
        "`referencesOnto` is nested inside `draw` again, so nothing else can call it"
    )
    assert app.count("function referencesOnto") == 1, "there are now two of them"


def test_a_panel_a_study_does_not_fill_is_emptied_rather_than_left_alone() -> None:
    """Opening a study left the panels it did not fill showing the PREVIOUS study.

    `openStudy` fills one panel per image series. A study with a single CT opened into the
    1x2 layout a two-series study had just selected, so panel B kept its stack, its picture,
    its series name, its patient name and its link badge -- all from a study the reader had
    navigated away from.

    MEASURED, opening a real thorax CT while the demo phantom was still on screen:

        panel A   CT114545:RespCT 3.0 B30f 50% Ex   LCTSC-Test-S1-102    148 slices
        panel B   Synthetic thorax, companion       PHANTOM^SYNTHETIC     40 slices
        badge     "position-linked"  -  "linked by patient position (nearest slice 1.0 mm)"

    Two different patients side by side, the right-hand one from a different study, carrying
    the strongest correspondence claim this surface can make. The badge was STALE rather
    than wrong -- `followIndex` answers "different frame of reference" as soon as anything
    recomputes it -- which is worse than wrong, because nothing recomputes it until the
    reader scrolls, and by then they have read it.

    THREE THINGS HAD TO BE TRUE and only the first is obvious. The panel's state must be
    dropped; the HUD labels must be blanked, because `draw` writes them and `draw` returns
    early for a panel with no stack, so clearing the state alone left the caption for a
    picture that was no longer there; and the canvas must go black, because `render`
    returned without touching it.
    """
    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    assert "function clearPanel(p, why)" in app, "there is no way to empty a panel"

    body = app[app.index("function clearPanel(p, why)"):]
    body = body[: body.index("\n}\n")]
    for field in ("stack", "frame", "seg", "seriesUID"):
        assert f"p.{field} = null" in body, f"a cleared panel keeps its {field}"
    assert "p.viewport.setFrame(null)" in body, "the picture is not cleared"

    # THE HUD MOVED INTO ONE INSTANCE AND THIS GATE FOLLOWS IT, rather than the code being
    # moved back. `clearPanel` used to blank the four corners by hand and the refusal path
    # in `draw` blanked nothing at all -- and neither removed the `projecting` class, which
    # is a pseudo-element and survives an emptied corner. Both call `blankHud` now. What
    # `blankHud` must take back is asserted where it lives, in the test named for a refused
    # frame; here it is enough that a cleared panel goes through it.
    assert "blankHud(p)" in body, (
        "a cleared panel keeps the caption, the link badge and the laterality letters of "
        "the study the reader navigated away from"
    )
    blank = app[app.index("function blankHud(p)"):]
    blank = blank[: blank.index("\n}\n")]
    for label in ("tl", "tr", "bl", "br"):
        assert f"p.hud.{label}" in blank, (
            f"the {label} HUD corner still reads whatever the previous study put there"
        )
    # THROUGH THE ONE WRITER, not by the literal line: `hideLink` takes the badge and the
    # mode together, which is the invariant `crosshairFor` depends on.
    assert "hideLink(p)" in blank, (
        "a cleared panel keeps the link badge it was given for a different pair of series"
    )
    link = re.search(r"function hideLink\(p\) \{(.*?)\n\}", app, re.S)
    assert link and "p.hud.badge.hidden = true" in link.group(1) \
        and "p._linkMode = null" in link.group(1), (
        "`hideLink` does not take back both halves, so the badge and the mode behind it "
        "can disagree"
    )
    assert "p.annotations.clear()" in blank, (
        "the previous study's calipers and reference lines stay drawn"
    )

    # AND IT IS CALLED BEFORE THE LOADS. `loadSeriesInto` paints progressively and awaits,
    # so clearing afterwards shows the old study beside the new one for the whole retrieval
    # -- which on a 148-slice series is exactly when the reader is looking.
    opener = app[app.index("async function openStudy(uid"):]
    opener = opener[: opener.index("\n}\n")]
    assert "clearPanel(panels[i]" in opener, (
        "the panels this study does not fill are never emptied"
    )
    assert opener.index("clearPanel(panels[i]") < opener.index("await loadSeriesInto("), (
        "the stale panels are cleared only after the new series has finished loading, so "
        "the previous study stays on screen for the length of the retrieval"
    )

    # A null frame must be a picture of nothing, not a throw and not the last picture.
    viewport = _code(_js("render", "viewport.js"))
    setframe = viewport[viewport.index("setFrame(frame) {"):]
    setframe = setframe[: setframe.index("\n  }")]
    assert "if (!frame) {" in setframe, (
        "setFrame(null) still reaches `frame.pixels`, and `app.js` calls it from the branch "
        "that catches a reconstruction refusal -- so the path whose job is to replace a "
        "picture with an explanation throws instead"
    )
    render = viewport[viewport.index("render() {"):]
    render = render[: render.index("\n  }")]
    assert "gl.clear(gl.COLOR_BUFFER_BIT)" in render[: render.index("const { width: w")], (
        "a panel with no frame keeps the last image it drew, under whatever labels the "
        "surface has moved on to"
    )


def test_no_number_on_this_surface_is_formatted_in_the_browser_locale() -> None:
    """A decimal separator is not a presentation detail on a clinical readout.

    `measurements-panel.js` rendered the model's SR values with
    `toLocaleString(undefined, ...)`, and `undefined` means THE BROWSER'S LOCALE. Measured
    on a machine reporting `ru`, reading a real thorax CT's organ-at-risk SR:

        rendered        meant           read as, under a decimal point
        3 162,538 ml    3162.538 ml     three million millilitres
        9,522 mm        9.522 mm        nine thousand millimetres

    A factor of a thousand, on values shown to the reader BECAUSE a model produced them.
    And the caliper in the same panel prints `109.7 mm` through `distanceText`, which uses
    `toFixed` -- so one screen carried two decimal conventions and neither was labelled.

    The DICOM source is unambiguous: a DS is a decimal string with a period and an SR
    numeric value carries no locale, so rendering one in a locale is the surface inventing
    an interpretation the data does not have. The same argument covers dates, which is why
    the rule is the whole family rather than the one call that had it.
    """
    offenders = []
    for path in sorted(SRC.rglob("*.js")) + [VIEWER / "app.js"]:
        code = _code(path.read_text(encoding="utf-8"))
        for name in ("toLocaleString", "toLocaleDateString", "toLocaleTimeString",
                     "Intl.NumberFormat", "Intl.DateTimeFormat"):
            if name in code:
                offenders.append(f"{path.name}: {name}")
    assert not offenders, (
        "these render a value in whatever locale the browser happens to report, so the "
        "same number reads differently on two machines and differently from every other "
        "number on the same screen: " + ", ".join(offenders)
    )


def test_a_measurement_does_not_outlive_the_study_it_was_taken_on() -> None:
    """`state.measurements` was one flat list that survived every navigation.

    A caliper drawn on one study stayed in the "Yours this session" table while the reader
    read the next one. MEASURED: a 169.1 mm caliper placed on the demo phantom was still
    listed, with its number, while `LCTSC-Test-S1-102` was open -- a different patient.

    `elsewhere()` marked it "another series", which is the most dangerous wording available
    for this. That phrase describes an ordinary, safe, within-study situation, so a reader
    who has seen it before has been trained to disregard it. Nothing said "another patient",
    because nothing knew there was one.

    DROPPED RATHER THAN SCOPED. The heading says "this session, not saved" and nothing
    persists them, so scoping to a study would preserve nothing a reader could have relied
    on while leaving the cross-patient path alive.
    """
    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    body = app[app.index("async function openStudy(uid"):]
    body = body[: body.index(chr(10) + "}" + chr(10))]

    assert "studyUID !== uid" in body, (
        "opening a study does not notice that the previous one was a different study"
    )
    assert "measurements: []" in body, (
        "the reader's measurements survive a change of study, so one patient's numbers are "
        "listed while another patient is on screen"
    )
    assert "srMeasurements: []" in body, (
        "the previous study's MODEL measurements survive too, and those carry no series "
        "marking at all"
    )
    # The clear has to happen BEFORE `studyUID` is reassigned, or its own guard can never
    # be true again.
    assert body.index("measurements: []") < body.index("studyUID = uid;"), (
        "the clear runs after `studyUID` is overwritten, so its guard never fires"
    )


def test_a_measurement_can_be_taken_hold_of_and_moved() -> None:
    """Committed measurements were frozen records under a layer that took no pointer events.

    `Object.freeze` on the record, `pointer-events: none` on the whole annotation layer, no
    hit-testing anywhere, and the handle circles were 3px decoration. A caliper two pixels
    off had to be deleted from a side panel and drawn again.

    MEASURED, on a real thorax CT: a 125.4 mm caliper, handle dragged, recomputed to
    70.6 mm -- and independently, 97.3 px at 0.725 mm/px is 70.5 mm, so the number follows
    the geometry rather than being carried over.
    """
    measure = _code(_js("image", "measure.js"))
    assert "export function remeasure(" in measure, (
        "there is no way to re-measure a record whose geometry moved, so a handle drag "
        "could only change the picture and not the number"
    )
    body = measure[measure.index("export function remeasure("):]
    # `remeasure` is the last function in the file, so there is no closing marker after it
    # to cut at -- taking the rest of the module is the honest slice.
    end = body.find(chr(10) + "}" + chr(10))
    body = body if end < 0 else body[: end]
    # THE WHOLE RECORD IS REBUILT. Every field `describeMeasurement` freezes is a statement
    # about the frame -- the spacing used, whether it was stated, whether the pixels were a
    # projection, what the plane resolved. Patching `value` alone leaves a record whose
    # number is from one moment and whose provenance is from another.
    # ONCE PER KIND. `in body` was satisfied by any one branch calling it, so breaking the
    # caliper's branch alone left this green -- the gate tested that the function knew the
    # right shape somewhere, not that every kind used it.
    kinds = ("length", "angle", "roi")
    for kind in kinds:
        assert f"describeMeasurement('{kind}', frame, location, value)" in body, (
            f"remeasure patches the value for a {kind} instead of rebuilding the record, "
            f"so its number and the provenance beside it come from different moments"
        )
    # COUNTED BY BRANCH, NOT BY KIND. This read `== len(kinds)` and went red the moment a
    # freehand region was added -- a second branch under the `roi` kind, because a polygon
    # is re-measured from its vertices and an ellipse from its box. The property was always
    # "every branch that rebuilds a record carries the id through", and one-branch-per-kind
    # was an accident of there being three kinds when it was written.
    branches = body.count("return Object.freeze({")
    assert branches >= len(kinds), (
        f"remeasure has {branches} rebuilding branches for {len(kinds)} kinds; a kind lost "
        "its branch, so editing that kind silently returns null and the measurement vanishes"
    )
    assert body.count("id: m.id") == branches, (
        "a kind was added to remeasure without carrying the id through, so editing it "
        "looks like a delete and an insert to everything holding a reference"
    )

    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    assert "function moveHandle(" in app, "no handle can be moved"
    assert "function bindAnnotationEditing(" in app, "the layer is never wired for editing"
    assert "bindAnnotationEditing(panel)" in app, (
        "the editing handlers are defined and attached to nothing"
    )


def test_a_miss_on_the_annotation_layer_still_reaches_the_window_drag() -> None:
    """The overlay must be transparent to the pointer everywhere except on a shape.

    Left-drag sets window and level, which is the gesture a reader uses more than any
    other, and it is dispatched from the CANVAS. An overlay that took pointer events across
    its whole area would swallow it on every pixel of the image; one that took none could
    not be edited. The answer is that the LAYER takes none and the SHAPES take their own,
    so a hit lands on the shape's handler and a miss never reaches it at all -- which makes
    the fall-through exact rather than a race between two handlers.

    MEASURED: dragging empty image moved the window from `W 962 L 40` to `W 1092 L 224`
    while the selected measurement was untouched.
    """
    styles = (VIEWER / "styles.css").read_text(encoding="utf-8")

    layer = re.search(r"\.annot \{(.*?)\}", styles, re.S)
    assert layer, "no .annot rule"
    assert re.search(r"pointer-events:\s*none", layer.group(1)), (
        "the annotation layer takes pointer events across its whole area, so it swallows "
        "the window-and-level drag everywhere the image is"
    )

    shape = re.search(r"\.annot-shape \{(.*?)\}", styles, re.S)
    assert shape and re.search(r"pointer-events:\s*(stroke|all|visible)", shape.group(1)), (
        "a committed shape cannot be hit, so it cannot be selected or moved"
    )
    handle = re.search(r"\.annot-handle \{(.*?)\}", styles, re.S)
    assert handle and re.search(r"pointer-events:\s*(all|visible)", handle.group(1)), (
        "the handles are decoration again"
    )
    # A PREVIEW IS NOT A TARGET. It belongs to a gesture in progress and has no id, so a
    # hit on it would select nothing and eat the click that was completing the gesture.
    assert re.search(r"\.annot-shape\.annot-preview \{[^}]*pointer-events:\s*none", styles, re.S), (
        "the in-progress shape takes pointer events, so the gesture drawing it can be "
        "interrupted by its own preview"
    )


def test_a_measurement_is_addressed_by_id_and_never_by_position() -> None:
    """`data-drop="${i}"` deleted by where a row sat in the array.

    Delete the first of three and the other two renumber, so any reference held across that
    moment names a different measurement. Nothing downstream could refer to a particular
    one, which is why nothing downstream could select, edit or jump to one -- and three
    nodules on one slice gave three rows all reading "length axial 33".
    """
    measure = _code(_js("image", "measure.js"))
    assert "id: measurementId()" in measure, "a record still has no identity"

    panel = _code(_js("ui", "measurements-panel.js"))
    assert 'data-drop="${i}"' not in panel, "the panel still deletes by array position"
    assert "data-drop=\"${escape(String(m.id))}\"" in panel, (
        "the remove control does not name the measurement it removes"
    )
    assert "filter((m) => String(m.id) !== id)" in panel, (
        "the delete still works on an index"
    )
    # A ROW POINTS AT A SHAPE. The rows were dead ends: no click, no selected state, so a
    # measurement thirty slices back was a number you could read and not get back to.
    assert "tr[data-m]" in panel, "a panel row cannot select the shape it describes"

    # ONE SOURCE OF TRUTH for the selection. The first attempt kept it in a module variable
    # in app.js while the panel wrote a state key of the same name, which is how a row can
    # look selected while the shape does not and neither is wrong about itself.
    state = _code(_js("core", "state.js"))
    assert "selectedMeasurement" in state, "the selection is not in the store"
    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    assert "let selectedMeasurement" not in app, (
        "the shell keeps its own copy of the selection beside the store's"
    )


def test_a_capture_reads_the_pixels_in_the_task_that_drew_them() -> None:
    """`preserveDrawingBuffer: false` means the buffer is gone by the next task.

    MEASURED, on a thorax CT with the picture plainly on screen: `toDataURL` returned
    31,798 bytes -- which reads as content until you decode it and count, and then it is
    0 non-black pixels across 52,000 sampled and one grey band. After rendering and reading
    in a single task: 235,954 non-black pixels and 16 grey bands.

    THE FIX IS NOT `preserveDrawingBuffer: true`. That makes every frame keep a copy of
    itself for the life of the context, on four contexts in a 2x2, to serve a button pressed
    once an hour. The buffer survives to the END of the task that drew it, so a render and a
    read with nothing awaited between them both see it -- which is a property of the CODE'S
    SHAPE, and the reason this gate reads the shape.
    """
    export = _code(_js("ui", "export.js"))
    body = export[export.index("export async function capturePanel("):]
    body = body[: body.index("const w = panel.canvas.width")]

    assert "panel.viewport.render();" in body, (
        "the capture reads the canvas without redrawing it first, so it gets whatever the "
        "compositor left behind -- which is a black image"
    )
    assert "toDataURL" in body, "nothing reads the pixels"
    assert body.index("panel.viewport.render();") < body.index("toDataURL"), (
        "the read happens before the render"
    )
    # NOTHING AWAITED BETWEEN THEM. An `await` here yields the task, the compositor takes
    # the buffer, and the capture goes black again -- silently, because every line still
    # looks right.
    between = body[body.index("panel.viewport.render();"): body.index("toDataURL")]
    assert "await" not in between, (
        "something is awaited between the render and the read, which yields the task and "
        "loses the drawing buffer -- the capture will be black and nothing will say so"
    )

    viewport = _code(_js("render", "viewport.js"))
    assert "preserveDrawingBuffer: true" not in viewport, (
        "every frame now keeps a copy of itself for the life of the context, on every "
        "panel, to serve a button pressed once an hour"
    )


def test_an_exported_picture_carries_the_statement_and_says_who_is_on_it() -> None:
    """An export is separated from this surface the moment it is saved.

    MOS-UI-008 binds the MOS-SAFE-001 statement to a persistently reachable footer, and a
    footer is not reachable at all from a PNG in somebody's downloads. `volume.js` already
    warns that identifiers travel with any export of a view; a caption naming the patient
    is that warning made literal rather than left to a screenshot key nobody controls.
    """
    export = _code(_js("ui", "export.js"))
    assert "RESEARCH USE ONLY" in export and "NOT FOR DIAGNOSTIC USE" in export, (
        "an exported picture carries no statement, so the one artefact that outlives this "
        "window is the one that does not say what it is"
    )
    assert "withIdentity" in export, (
        "a capture cannot be made without the patient named, so there is no artefact fit "
        "for a figure or a bug report"
    )
    assert "patient identifiers withheld from this capture" in export, (
        "a capture without identity does not say so, so it cannot be told later from one "
        "that simply had no name to show"
    )


def test_an_exported_measurement_is_in_the_unit_it_was_measured_in() -> None:
    """A column headed `unit` reading `HU` beside a caliper is the file saying the wrong thing.

    The first version of this writer took `typeof m.value === 'object' ? m.value.mean : ...`
    and `m.valueUnit || 'mm'`. Measured against a real caliper it produced an EMPTY value
    and the unit `HU`: a length's value is `{mm, px}`, so `.mean` was undefined, and
    `valueUnit` is the unit of the PIXEL DATA -- right for an ROI's mean, nonsense beside a
    distance.
    """
    export = _code(_js("ui", "export.js"))
    body = export[export.index("function figure(m) {"):]
    body = body[: body.index(chr(10) + "}" + chr(10))]

    assert "m.kind === 'length'" in body and "m.kind === 'roi'" in body, (
        "one rule is applied to every kind, and the three kinds neither store the same "
        "shape nor share a unit"
    )
    assert "v.mm" in body, "a length's millimetres are not read off its value object"
    assert "v.mean" in body, "an ROI reports something other than its mean"
    # WHEN THE SPACING WAS NEVER STATED the distance is pixels and says so, which is what
    # `distanceText` does on screen. Millimetres computed against a substituted [1, 1]
    # would put a number in a column headed `mm` that no scanner produced.
    assert "'px'" in body, (
        "a distance measured against a substituted pixel spacing is exported as "
        "millimetres, which is a number in a millimetre column that no scanner produced"
    )


def test_remembered_measurements_are_scoped_to_their_study() -> None:
    """A flat list keyed by nothing is how one patient's calipers were listed under another.

    Persisting them reintroduces that risk the first time the store is read back, so the
    study's UID is both the key AND a field inside the record: the key is how it is found,
    the field is what proves it belongs. A key can be edited by anyone with a console open.
    """
    store = _code(_js("core", "session-store.js"))

    assert "localStorage" in store, "nothing is remembered"
    assert "held.studyUID !== studyUID" in store, (
        "a recalled record is not checked against the study asking for it, so an edited "
        "key puts one study's measurements onto another"
    )
    assert "held.version !== VERSION" in store, (
        "a record stored under an older shape is restored into a newer surface, which is "
        "how a field that is now load-bearing arrives undefined"
    )
    # STORAGE THROWS. It does in a private window, under blocked site data, and on a full
    # quota. A viewer that will not open because it could not remember something is worse
    # than one that does not remember.
    assert store.count("catch") >= 3, (
        "a localStorage call is unguarded, so a private window or a full quota takes the "
        "whole surface down"
    )
    # AND A RESTORED RECORD MUST STILL BE ONE. A caliper with no pixelSpacing reports
    # millimetres it never had.
    assert "Array.isArray(m.pixelSpacing)" in store, (
        "a stored record is restored without checking it still carries what the surface "
        "will read off it"
    )


def test_a_position_is_a_point_in_the_patient_not_a_slice_number() -> None:
    """A slice index names a PLANE, which is why an axial and a coronal could never link.

    `followIndex` maps a slice number to a slice number, so it can only answer when both
    panels show the same plane -- and its own refusal has told the reader since it was
    written that "neither one of them is a slice of the other, the reference line shows
    where they cross". A POINT has no such problem: every plane through the volume has a
    position along its own normal, so every panel can be asked where the point is.

    MEASURED, on the demo phantom: the cursor set at the centre of axial slice 30 gives the
    coronal index 159 and the sagittal 224, each 0.35 mm off their own plane. Scrolling the
    axial ten slices moves the cursor's z from 60 to 80 with x and y UNCHANGED, the coronal
    does not move -- its ordinate is measured along y, which did not change -- and its
    crosshair travels from row 33 to row 23. That is cross-plane navigation, and it is the
    thing `followIndex` has been unable to do by construction.
    """
    ref = _code(_js("image", "reference.js"))
    for fn in ("pixelToPatient", "patientToPixel"):
        assert f"export function {fn}(" in ref, f"{fn} does not exist"

    # A FRAME THAT NEVER STATED ITS SPACING HAS NO PATIENT POSITION TO GIVE. `volume.js`
    # stands [1, 1] in to keep the geometry finite and records that it did; a point built
    # on that substitution is a pixel count wearing a millimetre. The refusal has to be in
    # these functions rather than at the call site, because a caller that forgot would get
    # a confident coordinate.
    for fn in ("pixelToPatient", "patientToPixel"):
        body = _fnbody(ref, f"export function {fn}(")
        assert "hasPixelSpacing === false" in body, (
            f"{fn} computes a patient position from a substituted pixel spacing, which is "
            f"a pixel count wearing a millimetre"
        )

    sync = _code(_js("image", "sync.js"))
    for fn in ("cursorAt", "slideCursor", "indexForCursor", "crosshairOn"):
        assert f"export function {fn}(" in sync, f"{fn} does not exist"

    # SCROLLING SLIDES ONE AXIS. Rebuilding the cursor from the new slice's ORIGIN would
    # drag it sideways too -- an origin is a corner of the image, not where the reader is
    # looking -- so it moves by the ordinate DIFFERENCE.
    slide = _fnbody(sync, "export function slideCursor(")
    assert "want - (base[0] * n[0]" in slide, (
        "the cursor is rebuilt from the slice rather than displaced along its normal, so "
        "scrolling one panel drags the position sideways on every other"
    )

    # AND THE CROSSHAIR HAS THREE STATES. A point off this plane still projects onto it, so
    # a crosshair drawn from the projection alone is identical whether the reader is looking
    # at the point or forty millimetres behind it.
    cross = _fnbody(sync, "export function crosshairOn(")
    assert "onPlane" in cross and "offMm" in cross, (
        "the crosshair cannot say whether the point is on this plane, so it looks the same "
        "when it is and when it is not"
    )
    assert "planeStepMm(stack, plane)" in cross, (
        "on-plane is judged against a literal rather than the plane's own step, so a 5 mm "
        "axial and a 0.7 mm coronal are held to the same tolerance"
    )
    assert "absent:" in cross, (
        "a crosshair that cannot be drawn is omitted rather than explained, so it looks "
        "the same as a viewer that has not drawn one yet"
    )

    annotations = _code(_js("render", "annotations.js"))
    assert "annot-cross-off" in annotations, "an off-plane crosshair is drawn as an on-plane one"
    styles = (VIEWER / "styles.css").read_text(encoding="utf-8")
    assert ".annot-cross-off" in styles, "the off-plane crosshair has no rule, so it looks identical"


def test_a_plane_button_says_what_the_reader_will_see() -> None:
    """`PLANES.AXIAL` is an ADDRESS -- "the acquired plane as stored" -- not anatomy.

    `sync.js` says so in its own header. On CT the distinction is invisible, because CT is
    acquired axially and the address happens to name the anatomy. On MR it is not: measured
    against a clinic MR corpus, of the acquisitions sampled 89 were sagittal and 26 coronal
    against 15 axial, and on a sagittal acquisition the button labelled "Axial" showed
    SAGITTAL anatomy, "Coronal" showed axial and "Sagittal" showed coronal. Nineteen of
    twenty-nine offered buttons showed anatomy other than their label.

    The orientation letters drawn on the image were right the whole time, so a reader had
    one true statement and one false one about the same picture, and the false one was the
    control they pressed to get there.
    """
    mpr = _code(_js("image", "mpr.js"))
    assert "export function planeAnatomy(" in mpr, (
        "nothing derives what a plane actually shows, so a label can only repeat the "
        "address it was addressed by"
    )
    body = _fnbody(mpr, "export function planeAnatomy(")
    assert "planeNormal(stack, plane)" in body, (
        "the anatomy is decided from something other than the plane's own normal, so it "
        "can drift from what is actually drawn"
    )
    # A NORMAL THAT IS NOT ON AN AXIS IS NOT THAT PLANE. An angled acquisition named
    # "Axial" is the same false statement in a subtler form.
    assert "oblique" in body, (
        "an angled acquisition is named a cardinal plane, so a 25-degree oblique reads as "
        "axial"
    )

    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    builder = _fnbody(app, "function buildPlaneButtons()")
    # THROUGH THE SHARED RESOLVER, not with a second copy. The button used to call
    # `planeAnatomy` directly; the HUD did not call anything and printed the plane ADDRESS,
    # so a sagittal MR read "axial" there while this button read "Sagittal". Both now go
    # through `planeWording`, and the hop is asserted rather than assumed.
    assert "planeWording(stack, plane)" in builder, (
        "the plane buttons are labelled from a fixed list again, so on anything not "
        "acquired axially they name the wrong anatomy"
    )
    assert "planeAnatomy(stack, plane)" in _fnbody(app, "function planeWording("), (
        "the resolver no longer asks the geometry, so every surface that trusts it is "
        "wrong together rather than separately"
    )
    # WHICH ONE IS THE DATA. Two of the three are reconstructions, and a reader is entitled
    # to know which picture they are looking at.
    assert "acquired" in builder, (
        "nothing marks which plane is the acquisition, so a reconstruction and the data "
        "look alike"
    )


def test_a_series_whose_slices_face_different_ways_is_not_one_volume() -> None:
    """A 3-plane localizer is not a rare object, and it was built as a volume.

    43 of 153 MR series in a clinic corpus carried slices in more than one orientation.
    Their frames are usually all one size, so the `mixed_geometry` refusal passes them, and
    every one of them landed in a single stack sorted by depth.

    MEASURED on one such series: 17 frames -- five axial, five sagittal, seven coronal --
    sorted into the order axial, sagittal, axial, sagittal, ... so the reader scrolled and
    the anatomy flipped between three planes while the HUD called all seventeen "axial",
    because the plane is taken from `frames[0]`. Two frames sat at depth -30.0 and two more
    at -15.0: a depth is the projection on `frames[0]`'s normal, and twelve of the seventeen
    do not share it.

    IT IS NOT SORTED NOW, because depth is not an ordering here -- it is a projection of
    unrelated planes onto one axis. The encoded order is what the scanner wrote.
    """
    volume = _code(_js("image", "volume.js"))
    assert "const coplanar" in volume, (
        "nothing asks whether the frames face the same way, so a localizer is assembled "
        "as though it were a volume"
    )
    assert "if (coplanar) frames.sort(" in volume, (
        "the frames are sorted by depth whether or not depth is an ordering, which "
        "interleaves three orthogonal sets into an order that means nothing"
    )
    assert "&& coplanar;" in volume, (
        "a non-coplanar series is still marked spatial, so `mpr.js` will reconstruct a "
        "volume assembled from three orthogonal sets"
    )

    mpr = _code(_js("image", "mpr.js"))
    body = _fnbody(mpr, "export function planeAnatomy(")
    assert "stack.coplanar === false" in body, (
        "a series with no single plane is still given one name, which is right for some "
        "of its frames and wrong for the rest"
    )


def test_the_roi_shape_that_was_implemented_can_be_reached() -> None:
    """`regionStatistics` has taken a `shape` since it was written, and nothing passed one.

    Its signature is `(frame, box, shape = 'ellipse')`, its JSDoc types the parameter
    `'ellipse'|'rectangle'`, and the pixel loop reads it -- `if (shape === 'ellipse' &&
    !insideEllipse(...)) continue`. The rectangle branch was implemented, documented, and
    unreachable, because the one caller passed the string `'ellipse'`.

    IT IS NOT A DUPLICATE OF THE ELLIPSE. A rectangle samples the corners an ellipse
    excludes, so the statistics differ: the choice is a measurement decision and not a
    drawing preference.
    """
    tools = _code(_js("tools", "measure-tools.js"))
    assert "regionStatistics(frame, box, 'rectangle')" in tools, (
        "nothing asks for a rectangular region, so the branch that measures one cannot run"
    )
    # THE SHAPE IS RECORDED. `remeasure` reads `m.shape` when a corner is dragged, so a
    # record that did not carry it would silently become an ellipse on its first edit.
    assert "shape: 'rectangle'" in tools and "shape: 'ellipse'" in tools, (
        "an ROI does not record which shape it is, so editing one changes what it measured"
    )
    annotations = _code(_js("render", "annotations.js"))
    assert "m.shape === 'rectangle'" in annotations, (
        "the drawn shape does not follow the measured one, so a number sits beside a "
        "region that did not produce it"
    )


def test_an_armed_tool_owns_the_click_even_over_an_existing_measurement() -> None:
    """Returning from the layer's handler does not give the click back to the canvas.

    The annotation layer takes pointer events on its shapes so a measurement can be
    selected and dragged. With a tool armed the reader is placing a NEW measurement, and an
    existing one under the pointer is scenery -- but the shape had already captured the
    event by the time the handler ran, so an early return meant the press reached nothing
    at all.

    MEASURED: with a caliper on screen and the rectangle tool armed, a drag starting on the
    caliper's stroke drew nothing and selected nothing. The layer is made inert while a
    tool is armed, so the event is never captured.
    """
    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    # THE NAME IS READ OUT OF THE CODE, not written here twice. A gate that spelled the
    # class in its own assertion would pass a rename on one side of the pair, which is the
    # only way this can break silently -- the class and the rule live in different files
    # and nothing but this check connects them.
    toggled = re.search(r"annotations\.svg\.classList\.toggle\('([\w-]+)'", app)
    assert toggled, (
        "the annotation layer keeps its hit area while a tool is armed, so drawing across "
        "anything already measured silently does nothing"
    )
    cls = toggled.group(1)

    # Comments first: a selector is "everything since the last brace", and the comment
    # explaining a rule lives exactly there.
    styles = re.sub(r"/\*.*?\*/", "", (VIEWER / "styles.css").read_text(encoding="utf-8"),
                    flags=re.S)
    dead = set()
    for selector, body in re.findall(r"([^{}]+)\{([^}]*)\}", styles):
        if not re.search(r"pointer-events:\s*none", body):
            continue
        for one in selector.split(","):
            hit = re.match(rf"\s*\.{re.escape(cls)}\s+\.([\w-]+)\s*$", one)
            if hit:
                dead.add(hit.group(1))
    # BOTH HALVES. A shape takes the press that starts a drag; a handle takes the press
    # that resizes one. Either still live is enough to swallow the click.
    for part in ('annot-shape', 'annot-handle'):
        assert part in dead, (
            f".{cls} does not disable pointer events on .{part}, so a press landing there "
            "is captured by a measurement the reader is drawing across, not placed"
        )


def test_a_measurement_can_be_named_and_removed_from_the_keyboard() -> None:
    """The record carried a `label` and nothing ever wrote one.

    Three nodules on one slice gave three rows reading "length axial 33" -- identical, so
    telling them apart meant clicking each to see which shape lit up. And there was no
    Delete binding at all: the only way to remove a measurement was a 24px glyph in a side
    panel, which takes a hand off the image to undo something that happened on the image.
    """
    panel = _code(_js("ui", "measurements-panel.js"))
    assert "ondblclick" in panel, "a measurement cannot be named"
    assert "label: label || null" in panel, "the name is not written to the record"
    # A FROZEN RECORD IS REPLACED, NOT MUTATED -- every other edit path here rebuilds, and
    # a field assigned in place would change without the list changing, so nothing would
    # re-render.
    assert "Object.freeze({ ...x, label:" in panel, (
        "the label is assigned in place, so the store never sees the change"
    )

    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    assert "e.key === 'Delete'" in app, "there is no keyboard way to remove a measurement"
    # NOT WHILE TYPING. Backspace in a filter box is a backspace.
    assert "isContentEditable" in app, (
        "Delete fires while the reader is typing in a filter or a name box"
    )


def test_a_non_image_series_is_told_what_actually_happens_to_it() -> None:
    """The series list claimed every non-image series was "layered onto the image panels".

    `loadDerived` reads SEG and SR. It reads nothing else. A clinic MR corpus carried 22
    GSPS presentation states, and clicking one of those in the series list answered "PR is
    not an image series; it is layered onto the image panels instead" -- so the reader was
    told the saved window and the referring radiologist's annotations were already on
    screen. Nothing had been read. That is worse than showing nothing at all, because a
    reader who believes a presentation state is applied reads the image as presented.

    THE TWO SIDES MUST AGREE. The list of modalities the message promises and the set the
    loader actually handles are both extracted from the source here; a modality added to
    one and not the other is the only way this can go quietly wrong again.
    """
    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))

    declared = re.search(r"const DERIVED_MODALITIES = \[([^\]]*)\]", app)
    assert declared, (
        "nothing names the non-image modalities this viewer reads, so the message that "
        "promises they are layered has no way to be true or false"
    )
    promised = set(re.findall(r"'([A-Z]+)'", declared.group(1)))
    assert promised, "the list is empty, but the message still promises something"

    handled = set(re.findall(r"dv\(x, '00080060'\) === '([A-Z]+)'", _fnbody(app, "async function loadDerived")))
    assert promised == handled, (
        f"the surface promises {sorted(promised)} are layered and the loader reads "
        f"{sorted(handled)}; a reader clicking {sorted(promised - handled) or sorted(handled - promised)} "
        "is told something that is not true of it"
    )

    # AND THE MESSAGE BRANCHES ON IT. A message that read the list and then said the same
    # thing either way would satisfy every check above.
    assert "DERIVED_MODALITIES.includes(modality)" in app, (
        "the message does not depend on the modality clicked, so it says the same thing "
        "about a series that is read and one that is not"
    )
    assert "does not read it" in app, (
        "there is no wording for a modality this viewer does not read, so the only "
        "sentence available is the one that claims it was layered"
    )


def test_the_hud_names_the_plane_it_is_showing() -> None:
    """The slice counter printed `p.plane`, which is an ADDRESS and not an anatomy.

    `PLANES.AXIAL` means "the acquired plane". On a CT the acquired plane IS axial, so
    printing the address read correctly for every study this surface had ever been shown.

    MEASURED, on the first real MR ever loaded into this viewer -- a lumbar spine exam:
    three sagittal acquisitions each reported "axial 6 / 11" in the bottom-right HUD, two
    corners away from orientation letters H/A/P/F that said sagittal. The reader is told
    the plane twice, by two mechanisms, and they disagreed. The mixed-orientation localizer
    said "axial" as well.

    THE PLANE BUTTONS HAD ALREADY BEEN FIXED and the HUD had not, which is the whole
    failure: two surfaces name the same thing and only one of them was taught how. So the
    gate is not that the HUD is right -- it is that there is ONE resolver and both call it.
    """
    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))

    assert "function planeWording(" in app, (
        "there is no single place that decides what a plane is called, so the HUD and the "
        "plane buttons can disagree about the same stack"
    )

    # THE HUD MUST NOT PRINT THE ADDRESS. `p.plane` interpolated into the bottom-right line
    # is the defect verbatim.
    # THE WHOLE REGION, not just the template literal. Checking only the `textContent`
    # expression passed a version that laundered `p.plane` through the intermediate
    # variable one line above it -- the same defect, one hop further away.
    start = app.index("const word = planeWording(p.stack")
    end = app.index(";", app.index("p.hud.br.textContent =", start))
    region = app[start:end]
    assert "${p.plane}" not in region, (
        "the HUD interpolates the plane ADDRESS, so a sagittal acquisition is labelled "
        "axial beside orientation letters that say otherwise"
    )
    assert "planeWord" in region, "the HUD does not use the resolver"

    # AND BOTH CALLERS ARE REAL. A resolver nothing calls is worse than none, because the
    # next reader assumes the question is handled.
    callers = len(re.findall(r"planeWording\(", app))
    assert callers >= 3, (
        f"planeWording is defined and called {callers - 1} time(s); the HUD and the plane "
        "buttons must both go through it or they will drift apart again"
    )

    # A SERIES WITH NO PLANE GETS NO PLANE WORD. `planeAnatomy` already refuses a stack
    # whose frames face different ways; the wording must not invent one back.
    body = _fnbody(app, "function planeWording(")
    assert "coplanar === false" in body, (
        "the wording does not consider a non-coplanar series, so a 3-plane localizer is "
        "given a single plane name that is wrong for two thirds of its frames"
    )


def test_a_series_thumbnail_does_not_wait_to_be_opened() -> None:
    """`paintSeriesThumb` had one caller and it fired only for a series occupying a panel.

    `markSeriesAssignment` called it under `if (at >= 0)` -- that is, only for a series the
    reader had ALREADY loaded. Every other row in the list held a black canvas, and it
    stayed black for as long as the study was open.

    THAT IS BACKWARDS. A thumbnail exists to tell a reader what a series is BEFORE they
    open it. One that appears only after they open it has answered a question they no
    longer have, and the list reads as broken -- which is how it was reported.

    MEASURED on a lumbar MR study of eight series: five black rows, including both
    single-instance myelographic series. After: eight painted inside two seconds, mean
    luminance 15-56, none zero.
    """
    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))

    assert "async function paintAllThumbs(" in app, (
        "nothing paints a thumbnail for a series that is not open, so the list shows black "
        "rectangles for everything the reader has not already clicked"
    )
    # CALLED FROM THE LIST IT PAINTS INTO, whatever the study is spelled as at that point.
    #
    # This read `"paintAllThumbs(studyUID)" in app` and went red on a correct edit: the
    # painter is now handed the study the list was just rendered FROM, because the rail
    # can be rendered for a study the reader has not arrived at once a prior can be
    # opened. Pinning the argument's spelling asked a question about a variable name
    # rather than about the behaviour -- the same failure this file records against its
    # own first version of the `onLanguageChange` gate, which broke the moment that
    # callback took an argument. What matters is that the list calls the painter.
    assert re.search(r"paintAllThumbs\(\w+\)", _fnbody(app, "function renderSeriesList(")), (
        "the series list never calls the painter, so every row that is not already open "
        "keeps a black rectangle"
    )

    # NOT FROM A PANEL. The painter took a panel, which is what tied a picture of a series
    # to that series being open; it only ever needed pixels and a window.
    body = _fnbody(app, "function paintThumb(")
    assert "p.viewport" not in body[: body.index("}")], (
        "the painter still reads a panel, so it cannot paint a series that has none"
    )

    # THE MIDDLE INSTANCE. The first slice of a spine sagittal is a lateral edge and the
    # first of a chest CT is table and air; either would look like the defect being fixed.
    thumbs = _fnbody(app, "async function paintAllThumbs(")
    assert "Math.floor(sorted.length / 2)" in thumbs, (
        "the thumbnail is taken from the first instance, which on most series is nearly "
        "black and indistinguishable from not having loaded"
    )

    # ONE INSTANCE, NOT THE SERIES. A thumbnail that pulled the whole series would cost as
    # much as opening it, which is the reason there were no thumbnails to begin with.
    assert "retrieveInstance" in thumbs, (
        "the thumbnail path fetches whole series, so showing a list costs as much as "
        "opening every study in it"
    )
    client = _code(_js("dicom", "dicomweb.js"))
    assert "async retrieveInstance(" in client and "async instancesOf(" in client, (
        "the client cannot fetch a single instance, so nothing can cheaply represent a series"
    )

    # AND IT STOPS WHEN THE READER LEAVES. Guarded on the STUDY, not on `loadToken`, which
    # is bumped every time a series is opened -- guarding on that would cancel the
    # remaining thumbnails the moment the reader clicked the first row.
    #
    # ON THE STUDY THE LIST IS SHOWING, which is what `studyUID !== study` USED to mean.
    # It stopped meaning it when a prior could be opened: clicking one re-renders the rail
    # from the prior's series while `studyUID` -- the study the reader arrived at -- does
    # not move, so the guard passed and the loop asked the archive for the prior's series
    # under the current study's UID. `activeStudy()` is the question this always wanted to
    # ask; see `viewer/tests/test_prior.py` for the four requests that measured it.
    assert re.search(r"activeStudy\(\) !== study", thumbs), (
        "thumbnails are not abandoned when the list changes under the loop, so a picture "
        "of one patient can be painted into another patient's list"
    )
    assert "studyUID !== study" not in thumbs, (
        "the loop guards on the study the reader ARRIVED at rather than the one the list "
        "is showing; those are the same only while the surface holds one study"
    )
    assert "loadToken" not in thumbs, (
        "the thumbnail loop is guarded on the per-series token, so opening any series "
        "cancels every thumbnail still to come"
    )


def test_a_reference_line_names_the_plane_it_came_from() -> None:
    """The dashed line said `other.plane`, which is an address, like the HUD before it.

    MEASURED on the same lumbar MR: each sagittal panel carried a reference line labelled
    "axial" pointing at a panel whose own HUD read "as encoded". Two labels for one panel,
    disagreeing, three inches apart on the same screen.

    This is the THIRD surface to name a plane -- buttons, HUD, reference line -- and the
    third to be found printing the address. They now share `planeWording`, and the count of
    its callers is asserted so a fourth cannot quietly start spelling it again.
    """
    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    refs = _fnbody(app, "function referencesOnto(")
    assert "label: other.plane" not in refs, (
        "the reference line is labelled with the plane ADDRESS, so it can contradict the "
        "HUD of the very panel it points at"
    )
    assert "planeWording(other.stack, other.plane)" in refs, (
        "the reference line does not ask the geometry what it is pointing at"
    )
    callers = len(re.findall(r"planeWording\(", app))
    assert callers >= 4, (
        f"planeWording has {callers - 1} callers; the plane buttons, the slice HUD and the "
        "reference line must all go through it, or one of them will disagree with another"
    )


def test_the_freehand_region_is_a_measurement_and_not_an_annotation_tool() -> None:
    """`MOS-UI-010a` permits reader-drawn geometry whose ONLY output is scalar.

    The permission is conditional and the conditions are checkable, which is the point of
    writing them as five clauses rather than as a paragraph. `MOS-CORE-045` still forbids
    building an annotation authoring tool; what makes this one not that is the OUTPUT, so
    the output is what this gate reads.

    Clause 1: scalar only, vertices retained for re-measurement and never exported as a
    contour. Clause 2: no label map, mask or SEG written anywhere. Clause 4: none of the six
    segmentation primitives. Clause 5 and `MOS-SAFE-001`: every value carries
    `research_only`.
    """
    measure = _code(_js("image", "measure.js"))
    assert "export function polygonStatistics(" in measure, "there is no freehand measurement"

    # CLAUSE 1 AND 2. The module must offer no way to turn the vertices into a mask. A
    # name is not proof, but the ABSENCE of every name such a thing could have is the
    # cheapest check that stays true as the file grows.
    tools = _code(_js("tools", "measure-tools.js"))
    annotations = _code(_js("render", "annotations.js"))
    for surface in (measure, tools, annotations):
        assert not re.search(r"\b(toMask|toContour|writeSeg|exportMask|labelMap)\b", surface), (
            "something in the measurement path can produce a mask, which is the line "
            "MOS-CORE-045 draws and MOS-UI-010a clause 2 forbids crossing"
        )

    # CLAUSE 4. The six named primitives, none of which can be made acceptable by
    # restricting its output, because each produces or edits a mask by construction.
    for primitive in ("brush", "eraser", "regionGrow", "scissors", "interpolateLabel"):
        assert primitive not in tools, (
            f"the tool module contains a {primitive}, which MOS-UI-204 forbids outright"
        )

    # THE TOOL EXISTS AND IS REACHABLE.
    assert "export const freehandTool" in tools, "the freehand region cannot be drawn"
    assert "polygonStatistics(panel.frame, traced)" in tools, (
        "the committed measurement is not computed from the traced path"
    )

    # IT DOES NOT FIT dragTool, and must not pretend to: two corners cannot carry a path.
    assert "dragTool({\n  id: 'medos.roi-freehand'" not in tools, (
        "the freehand tool is built from the two-point factory, so everything the reader "
        "traced between the corners is discarded"
    )

    # THE SHAPE IS DRAWN, and before the branch that reads `m.box` -- a polygon has none,
    # and reaching that line throws inside the render loop, taking every later annotation
    # on the panel down with it.
    assert "m.shape === 'polygon'" in annotations, "a traced region is not drawn"
    poly_at = annotations.index("m.shape === 'polygon'")
    box_at = annotations.index("m.box.x0")
    assert poly_at < box_at, (
        "the polygon branch is below the branch that reads m.box, so drawing a traced "
        "region throws and takes the rest of the panel's annotations with it"
    )

    # AND RE-MEASURED FROM ITS VERTICES. There is no bounding box to fall back on, so a
    # remeasure that reached for one would report the area of a rectangle never drawn.
    assert "m.shape === 'polygon' && Array.isArray(m.points)" in measure, (
        "a freehand region is not re-measured from its vertices, so editing one reports "
        "an area the reader never enclosed"
    )


def test_a_measurement_records_what_its_plane_is_called() -> None:
    """The measurements panel printed `m.plane`, which is an address.

    MEASURED on a lumbar MR: a region traced on a sagittal produced a row reading
    "roi axial 3" while the panel's own HUD, three inches away, read "as encoded 3 / 5".
    Fourth surface to name a plane and fourth to be found printing the address.

    IT IS RECORDED, NOT LOOKED UP. The measurements panel renders from state and holds no
    stack, so it cannot ask the geometry at render time -- and should not: the row outlives
    the frame it was taken on, which is the same reason `resolutionMm`, `projection` and
    `spacingStated` are recorded rather than resolved late.
    """
    measure = _code(_js("image", "measure.js"))
    assert "planeName: location.planeName" in measure, (
        "the record does not carry what its plane is called, so every surface that "
        "outlives the frame has to guess or print the address"
    )
    # THROUGH AN EDIT. A name that vanished on the first handle-drag would put the row
    # straight back to printing the address.
    assert "planeName: m.planeName" in measure, (
        "re-measuring drops the plane's name, so editing a measurement renames its plane"
    )

    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    assert "get planeName() { return planeWording(p.stack, p.plane); }" in app, (
        "nothing supplies the plane's name at the moment a measurement is taken"
    )

    panel = _code(_js("ui", "measurements-panel.js"))
    assert "m.planeName || m.plane" in panel, (
        "the measurements panel prints the plane ADDRESS, so a region traced on a "
        "sagittal is listed as axial"
    )
    export = _code(_js("ui", "export.js"))
    assert "m.planeName || m.plane" in export, (
        "the CSV carries the plane address, so a spreadsheet says axial for a sagittal"
    )
    # THE SHAPE TRAVELS WITH IT. Three ROIs on one lesion give three different means; a
    # column of numbers that did not say which shape produced them cannot explain why.
    assert "'shape'" in export and "m.shape || ''" in export, (
        "the export does not record which shape produced each number"
    )


def test_a_text_note_is_text_and_not_a_drawing() -> None:
    """`MOS-UI-010a` clause 5 permits a typed string anchored to an image coordinate.

    It permits it under three conditions, all of which are about how the string is STORED
    and DRAWN rather than about the gesture that made it: it MUST NOT be rasterised into
    the pixels, MUST NOT be burned into an export except as an overlay drawn at export
    time, and MUST carry `clinical_use: research_only`.

    A note is not an `AnnotationSet` and cannot become one. There is no region, no mask and
    no segment -- a string and an (x, y). `MOS-CORE-045` forbids building a tool that
    PRODUCES an `AnnotationSet`, and a sentence cannot be trained on.
    """
    tools = _code(_js("tools", "measure-tools.js"))
    assert "export const noteTool" in tools, "there is no way to write on the image"

    # IT NEVER TOUCHES A PIXEL. The record is a point and a string; the only writes to
    # pixel data in this viewer are the renderer's, and a note must not reach them.
    note_body = _fnbody(tools, "export const noteTool")
    for forbidden in ("putImageData", "fillText", "drawImage", "getContext"):
        assert forbidden not in note_body, (
            f"the note tool calls {forbidden}, so the text is drawn INTO the image rather "
            "than over it -- which rasterises a reader's words into the pixels"
        )

    # DRAWN AS SVG, ABOVE THE CANVAS. Same layer as every other annotation, which is what
    # makes it removable, selectable and absent from the pixel data.
    annotations = _code(_js("render", "annotations.js"))
    assert "m.kind === 'note'" in annotations, "a note is not drawn"
    assert "formatValue" in annotations and "measurement.kind === 'note'" in annotations, (
        "a note has no text to render, so it draws a marker and nothing else"
    )

    # AND IT IS REBUILT WHEN IT MOVES. A note has no number to re-measure and still has
    # provenance: dragging it to another slice changes which slice it sits on, and a record
    # returned unchanged would go on claiming the one it was placed on.
    measure = _code(_js("image", "measure.js"))
    assert "m.kind === 'note'" in measure, (
        "a note is not rebuilt when it moves, so it keeps the provenance of wherever it "
        "was first placed"
    )
    assert "text: m.text ?? ''" in measure, "moving a note loses what it says"

    # THE READER CAN TYPE INTO IT WHERE IT IS.
    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    assert "function editNote(" in app, "a note is placed and can never be written in"
    editor = _fnbody(app, "function editNote(")
    # AN EMPTY NOTE IS REMOVED, not kept. A marker with no text is a dot that says nothing
    # and cannot be read, and a reader who changed their mind should not have to delete
    # what they never created.
    assert "filter((x) => x.id !== m.id)" in editor, (
        "cancelling leaves an empty note on the image, which is a mark the reader did not "
        "make and cannot read"
    )
    # AND THE SHELL'S KEYS DO NOT REACH THE BOX. Without this, typing `d` arms the freehand
    # tool and Delete removes the note being written.
    assert "e.stopPropagation()" in editor, (
        "the shell's global keys fire while the reader is typing, so a note cannot contain "
        "the letters that happen to be tool shortcuts"
    )

    # RESEARCH USE ONLY TRAVELS WITH IT, like every other reader-produced value.
    assert "clinicalUse: 'research_only'" in measure, (
        "a reader-produced value leaves this surface without the marking MOS-SAFE-001 and "
        "MOS-UI-008 require it to carry"
    )


def test_a_resized_rail_redraws_the_canvas_it_resized() -> None:
    """Three ways to change the stage's width, and none of them fires a resize event.

    The image panels are WebGL canvases whose BACKING STORE must track their CSS size.
    Until now the only resize path in the whole surface was
    `window.addEventListener('resize', drawAll)` -- so a splitter drag, a rail collapse and
    a panel move would each change the canvas box while the backing store stayed at its old
    size. The picture stretches, the scale bar under it lies, and a measurement taken
    afterwards is taken through a transform that no longer matches the pixels.

    SO `onResize` IS REQUIRED, AND THE MODULE THROWS WITHOUT IT. A rail that resizes and
    does not redraw is the defect; making the argument optional would make the defect the
    default.
    """
    rails = _code(_js("ui", "rails.js"))
    assert "export function initRails(" in rails, "there is no rail module"
    assert "throw new Error('initRails needs onResize" in rails, (
        "onResize is optional, so a caller that forgets it gets rails that resize the "
        "canvas without redrawing it -- silently, and only visible as a wrong scale bar"
    )
    # EVERY PATH ENDS THERE. Drag, toggle and move each change a width.
    body_toggle = _fnbody(rails, "export function toggleRail(")
    body_move = _fnbody(rails, "export function movePanel(")
    for name, body in (("toggleRail", body_toggle), ("movePanel", body_move)):
        assert "notifyResize()" in body, (
            f"{name} changes the stage width without redrawing, so the canvas keeps the "
            "size it had before"
        )

    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    assert "onResize: drawAll" in app, "the shell does not hand the rails a redraw"

    # THE WIDTH IS WRITTEN TO THE CUSTOM PROPERTY, NOT THE ELEMENT. `.side` is
    # `flex: 0 0 var(--w-rail)`, so an inline width is overridden by the flex-basis and
    # the rail does not move -- which reads as the drag being broken rather than as the
    # wrong property being written.
    assert "style.setProperty" in rails, "the rail width is not written to its token"
    assert ".style.width" not in rails, (
        "the rail width is set inline, which the flex-basis overrides, so dragging appears "
        "to do nothing"
    )

    # ONE REDRAW PER FRAME. A pointer emits over a hundred events a second and each redraw
    # is a full WebGL pass on every panel.
    assert "requestAnimationFrame" in rails, (
        "every pointer event triggers its own redraw, so the drag stutters and the stutter "
        "reads as a rendering bug"
    )

    # AND IT DOES NOT REACH BACK INTO THE SHELL.
    assert "app.js" not in rails, (
        "the rail module imports the shell, so neither can be reasoned about without the "
        "other"
    )


def test_a_panel_is_placed_by_the_markup_and_not_by_a_literal() -> None:
    """The rail a panel lives in was a fact about one line of the shell.

    `const slots = { 'medos.segments': el.segments, 'medos.measurements': el.measurements }`
    meant a reader could not move a panel and a new panel could not appear without editing
    `app.js`. The section carrying `data-panel-id` is now what gets moved, and the host
    inside it is what the panel renders into.
    """
    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    assert "const slots = {" not in app, (
        "a panel's rail is hard-coded in the shell again, so it cannot be moved"
    )
    assert "data-panel-id" in app, (
        "the shell does not resolve a panel's home from the markup"
    )

    markup = (VIEWER / "index.html").read_text(encoding="utf-8")
    for rail in ('data-rail="left"', 'data-rail="right"'):
        assert rail in markup, f"{rail} is missing, so rails.js cannot find its rails"
    assert markup.count("data-splits=") == 2, "there are not two splitters"
    assert markup.count("data-panel-id=") >= 2, "the panels have no movable sections"
    # role=separator WITH a tabindex, or the handle is a control only a pointer can use.
    assert 'role="separator"' in markup and 'tabindex="0"' in markup, (
        "a splitter cannot be reached from the keyboard, so resizing is available only to "
        "readers using a mouse"
    )

    # A REMOUNT TEARS DOWN FIRST. Every panel's mount returns its unsubscribe; dropping it
    # leaves the old subscription live and renders the panel twice per state change.
    # THE CALLS, not the name. `mountedPanels` as a substring is satisfied by
    # `mountedPanelsX`, so a rename would pass a gate that only looked for the word.
    assert "mountedPanels.set(" in app and "mountedPanels.get(" in app, (
        "panel teardowns are discarded, so a remount subscribes the panel a second time "
        "and every state change renders it twice"
    )

    # AND THE LEFT RAIL CAN ACTUALLY NARROW. `.aside` has carried min-width: 0 since it was
    # written and `.side` never did, so the left rail floored at its thumbnails' width and
    # the splitter appeared broken below 186px.
    styles = (VIEWER / "styles.css").read_text(encoding="utf-8")
    side = re.search(r"\.side\s*\{[^}]*\}", styles, re.S)
    assert side and "min-width: 0" in side.group(0), (
        "the left rail has no min-width: 0, so it cannot be dragged below the width of "
        "its own content"
    )


def test_a_measurement_can_be_hidden_without_being_destroyed() -> None:
    """A reader comparing two of five had to delete the other three.

    The only way to get a measurement off the image was the remove glyph, which is
    irreversible and takes the row with it. Hiding is now a property of the READER'S
    CURRENT VIEW: it lives in state, never on the frozen record, and the export is
    unchanged by it -- a hidden measurement is still in the CSV, because it was still
    taken.

    THE RECORD MUST NOT LEARN ABOUT IT. Putting a `hidden` field on the record would mean
    two measurements taken identically differ in their provenance by what the reader
    happened to be looking at, and `remeasure` would have to carry it through every branch.
    """
    state = _code(_js("core", "state.js"))
    # THE DECLARATION, not the word. A bare substring is satisfied by any identifier
    # that merely starts with it, which is how a rename passes a gate three times over.
    assert "hiddenMeasurements: []" in state, "there is no way to hide a measurement"

    measure = _code(_js("image", "measure.js"))
    assert "hidden" not in _fnbody(measure, "export function describeMeasurement("), (
        "visibility is recorded on the measurement, so two measurements taken identically "
        "differ by what the reader was looking at"
    )

    panel = _code(_js("ui", "measurements-panel.js"))
    assert 'data-eye="' in panel, "no control hides a measurement"
    assert "hiddenMeasurements: [...held]" in panel, (
        "the panel does not write the hidden set back to state"
    )

    # THE SHELL FILTERS AT DRAW TIME, and the annotation layer is not asked to care. Its
    # job is to draw what it is given.
    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    # THROUGH THE ONE DEFINITION, not an inline filter repeated at each call site. The
    # first version of this gate pinned the inline expression, which passed while the
    # SECOND render call site drew the whole list -- see the dedicated gate below.
    assert "function drawableMeasurements()" in app, (
        "hidden measurements are still drawn on the image"
    )
    annotations = _code(_js("render", "annotations.js"))
    assert "hidden" not in annotations, (
        "the annotation layer decides what to draw instead of drawing what it is given"
    )

    # AND THE EXPORT IS UNCHANGED BY IT. This is the clause that makes hiding safe: it is
    # a view, not a redaction.
    export = _code(_js("ui", "export.js"))
    assert "hidden" not in export, (
        "the CSV drops hidden measurements, so hiding one quietly removes it from the "
        "record of the session"
    )


def test_a_measurement_row_is_reachable_without_a_mouse() -> None:
    """The rows carried no tabindex, no role and no key handler.

    A reader navigating by keyboard could read the table and reach nothing in it: the row
    selected on click, the name opened on double-click, and neither had an equivalent. The
    row now carries `role="button"` and a tabindex, which is a promise -- so Enter and
    Space must select and F2 must rename, or the markup says the row is a control and the
    behaviour does not keep it.
    """
    panel = _code(_js("ui", "measurements-panel.js"))
    assert 'role="button"' in panel and 'tabindex="0"' in panel, (
        "a measurement row cannot be focused, so the list is readable and not usable "
        "without a pointer"
    )
    assert "row.onkeydown" in panel, (
        "the row announces itself as a button and answers no key, which is a promise the "
        "markup makes and the behaviour breaks"
    )
    body = _fnbody(panel, "    row.onkeydown = (e) => {")
    for key in ("'Enter'", "' '", "'F2'"):
        assert key in body, f"the row does not answer {key}"

    # AND IT SAYS WHICH ROW IS SELECTED, to a reader who cannot see the highlight.
    assert 'aria-selected="${m.id === selected}"' in panel, (
        "the selected row is distinguished only by colour, so a screen reader cannot tell "
        "which measurement is selected"
    )

    # A NOTE IS NOT RENDERED AS A FIGURE. `.num` is right-aligned tabular monospace that
    # never wraps -- this module's own comment forbids putting a note there, and the
    # unconditional cell class did it anyway.
    assert "m.kind === 'note' ? 'note-text' : 'num'" in panel, (
        "a reader-typed sentence is rendered in the numeric column, where it reads as a "
        "value in a column of values"
    )
    styles = (VIEWER / "styles.css").read_text(encoding="utf-8")
    assert ".note-text" in styles, (
        "the note cell chooses a class nothing styles, so the distinction exists in the "
        "DOM and nowhere a reader can see it"
    )


def test_a_state_key_a_panel_renders_from_is_a_key_it_subscribes_to() -> None:
    """The eye wrote `hiddenMeasurements` and nothing re-rendered.

    The key was declared in `state.js`, read by the panel's render, written by the eye's
    click handler and filtered on at draw time -- and the panel's `subscribeTo` call did
    not name it, so the write landed and no consumer woke up. Clicking the eye did nothing
    at all, and every gate in this file still passed, because each of them asked whether
    the source CONTAINED the right code rather than whether it was CONNECTED.

    A panel that renders from a key and does not subscribe to it is a panel that shows a
    stale value until something unrelated happens to redraw it, which is worse than not
    showing it: the reader cannot tell the difference between "not changed" and "not
    listening".
    """
    panel = _code(_js("ui", "measurements-panel.js"))

    # The keys the render actually destructures out of `get()`.
    m = re.search(r"const \{([^}]*)\} = get\(\);", panel, re.S)
    assert m, "the panel no longer destructures its state in one place"
    read = {k.split(":")[0].strip() for k in m.group(1).split(",") if k.strip()}

    sub = re.search(r"subscribeTo\(\[([^\]]*)\]", panel, re.S)
    assert sub, "the panel does not subscribe to anything"
    subscribed = set(re.findall(r"'([^']+)'", sub.group(1)))

    missing = read - subscribed
    assert not missing, (
        f"the panel renders from {sorted(missing)} but never subscribes to it, so a write "
        "to that key changes nothing on screen until an unrelated redraw happens to run"
    )


def test_the_image_draws_the_visible_measurements_through_one_definition() -> None:
    """Hiding a measurement worked until anything redrew the frame, and then it came back.

    There are TWO `annotations.render` call sites in the shell: `drawOverlays`, and the
    draw that follows the image so a caliper cannot lag its slice by a frame. The first
    fix filtered one of them. A reader could hide a caliper, draw the next measurement,
    and watch the hidden one reappear -- because drawing the next measurement redrew the
    image, and the image's own path passed `getState().measurements` whole.

    So the rule is not "filter before rendering", which is a thing a person has to
    remember at every call site. It is that there is ONE function naming what the image
    may draw, and both sites call it.
    """
    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))

    assert "function drawableMeasurements()" in app, (
        "there is no single definition of which measurements the image may draw"
    )

    calls = re.findall(r"annotations\.render\(\s*([^,]+),", app)
    assert len(calls) >= 2, (
        f"expected the two render call sites this gate exists to keep honest, found "
        f"{len(calls)}"
    )
    for first_argument in calls:
        assert "drawableMeasurements()" in first_argument, (
            f"a render call site passes {first_argument.strip()!r} instead of "
            "drawableMeasurements(), so it draws measurements the reader hid"
        )

    # AND THE WHOLE LIST IS STILL WHAT THE PANEL AND THE EXPORT SEE. Hiding is a property
    # of the view; a hidden measurement was still taken.
    export = _code(_js("ui", "export.js"))
    assert "hiddenMeasurements" not in export, (
        "the CSV consults the hidden set, so hiding a measurement quietly removes it from "
        "the record of the session"
    )


def test_translation_never_reaches_a_measured_value_or_the_safety_statement() -> None:
    """A locale may change a LABEL. It may not change a number that came off an image.

    `66.2 mm` is a fact about `(0028,0030)`, and a locale that renders it `66,2` has
    restyled a clinical value on the reader's behalf -- while `MOS-UI-037` requires the
    displayed value to carry the unit its header states. The same holds for patient
    identifiers, accessions and UIDs: those are the archive's own bytes, and translating
    them makes the viewer disagree with the PACS about what a study is called.

    And the `MOS-SAFE-001` statement is quoted VERBATIM because the requirement names the
    words. A translation may sit beside it; it may never replace it.
    """
    i18n = _code(_js("core", "i18n.js"))

    # NO LOCALE-AWARE NUMBER FORMATTING ANYWHERE IN THE VIEWER. This is the mechanism by
    # which a translated build would quietly restyle a measurement.
    for name in ("units.js", "measure.js"):
        src = _code(_js("image", name))
        assert "Intl.NumberFormat" not in src and "toLocaleString" not in src, (
            f"{name} formats a number through the locale, so a measured value changes "
            "appearance with the reader's language"
        )

    panel = _code(_js("ui", "measurements-panel.js"))
    assert "i18n" not in panel, (
        "the measurements panel imports the translator, which puts a clinical value one "
        "edit away from being translated"
    )

    export = _code(_js("ui", "export.js"))
    assert "i18n" not in export, (
        "the CSV is translated, so an exported measurement depends on who exported it"
    )

    # THE FALLBACK IS THE ENGLISH TEXT, not the key. A missing table must degrade to an
    # untranslated interface, never to `prefs.title` on screen.
    assert "export function t(key, english)" in i18n, (
        "t() does not take the English text, so a missing translation shows a key"
    )

    # AND THE FOOTER STATEMENT IS NOT A TRANSLATABLE STRING.
    html = (VIEWER / "index.html").read_text(encoding="utf-8")
    foot = html[html.index("RESEARCH USE ONLY"):][:400] if "RESEARCH USE ONLY" in html else ""
    assert 'data-i18n' not in foot, (
        "the MOS-SAFE-001 statement is marked for translation; the requirement names the "
        "words, so a translation may sit beside it but never replace it"
    )


def test_a_panel_appears_because_it_registered_not_because_someone_wrote_its_markup() -> None:
    """Adding a panel was a registration AND an edit to index.html. Now it is not.

    The shell already resolved a panel's host by `data-panel-id` rather than a hardcoded
    map, so it did not know what a panel RENDERS -- but it still required that somebody had
    hand-written a `<section>` for it, which is the same coupling one level out. A panel
    that registered without one was reported as a problem rather than given a section.

    A panel now declares `slot` (which rail), `title` and `order`, and the shell builds the
    section when the markup has none. A section in the markup still wins: the two older
    panels carry one so their empty states are on screen before the first subscription
    fires, and a deployment that laid out its rails by hand should not have that undone.
    """
    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))

    assert "function createPanelSection(" in app, (
        "the shell cannot build a section, so adding a panel is still an HTML edit"
    )
    assert 'data-rail="${panel.slot' in app or "data-rail=\"${panel.slot" in app, (
        "the created section is not placed by the panel's declared slot"
    )
    # THE MARKUP STILL WINS, or a hand-laid-out deployment loses its arrangement.
    assert "if (!section) section = createPanelSection(panel)" in app, (
        "the shell builds a section even when the markup already has one, so a "
        "hand-written layout is overridden by a default"
    )
    # AND THE SHAPE MATCHES, because rails.js moves sections by this selector and
    # mountPanels finds the host as lastElementChild.
    creator = app[app.index("function createPanelSection("):]
    creator = creator[:creator.index("function mountPanels(")]
    assert "rail-section" in creator and "dataset.panelId" in creator, (
        "a created section differs in shape from a hand-written one, so it mounts and "
        "then cannot be moved between rails"
    )

    # EVERY SHIPPED PANEL DECLARES WHERE IT LIVES, so no panel's rail is implied by where
    # its markup happened to be pasted.
    for name in ("segments-panel.js", "measurements-panel.js", "study-panel.js"):
        code = _code(_js("ui", name))
        assert "slot:" in code, f"{name} does not declare which rail it belongs in"


def test_every_offered_language_has_a_table_and_a_direction() -> None:
    """A language in the picker that changes nothing is worse than a shorter list.

    The reader chooses it, sees the interface stay English, and concludes the setting is
    broken. So a language is OFFERED when its table exists -- not when someone hopes to
    add it later.

    And direction is part of a language, not a separate setting. Arabic in a left-to-right
    document is not "Arabic with a quirk": the study list's columns, the rails and the
    pager all read in the wrong order.
    """
    i18n = _code(_js("core", "i18n.js"))
    codes = re.findall(r"\{\s*code:\s*'([a-z-]+)'", i18n)
    assert len(codes) >= 2, "only one language is offered"

    folder = VIEWER / "i18n"
    for code in codes:
        if code == "en":
            continue  # the fallback IS the English in the source; it needs no table.
        table = folder / f"{code}.json"
        assert table.is_file(), (
            f"{code} is offered in the picker and has no table, so choosing it changes "
            "nothing and looks like a broken setting"
        )
        loaded = json.loads(table.read_text(encoding="utf-8"))
        real = [k for k in loaded if not k.startswith("_")]
        assert len(real) >= 20, (
            f"{code}.json holds {len(real)} strings; a table that thin leaves most of the "
            "interface in English while claiming to be a language"
        )

    assert "document.documentElement.dir" in i18n, (
        "direction does not follow the language, so a right-to-left language renders the "
        "whole layout in the wrong order"
    )

    # A TECHNICAL VALUE DOES NOT REFLOW. Left to the bidi algorithm in an rtl document,
    # `01-Jan-2020 12:00` renders as `Jan-2020 12:00-01` -- a date that is not the date.
    # `_code` STRIPS COMMENTS FIRST. The phrase appears in the rule AND in the comment
    # explaining it, so a bare substring check passed while the rule itself was broken --
    # the same weakness that has now cost this file five separate times.
    styles = _code((VIEWER / "styles.css").read_text(encoding="utf-8"))
    assert "unicode-bidi: isolate;" in styles, (
        "dates, accessions and UIDs are not isolated from the surrounding text direction, "
        "so they reorder on screen in a right-to-left language"
    )

    # AND WHAT THE SHELL BUILT AS A STRING IS REDRAWN. `paintChrome` only reaches nodes
    # carrying `data-i18n`; the study list's rows and its count are written by JS.
    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    # THE CALLBACK'S BODY, not its signature. The first version of this gate pinned
    # `onLanguageChange(() => {` and broke the moment the callback took the new language
    # as an argument -- which is a better callback, failed by a gate reading spelling.
    assert "onLanguageChange(" in app, "nothing listens for a language change"
    body = app[app.index("onLanguageChange("):]
    body = body[:body.index("startI18n")] if "startI18n" in body else body[:600]
    assert "renderWorklist()" in body, (
        "the shell does not redraw what it built when the language changes, so the study "
        "list keeps the language it was first painted in"
    )
def test_every_language_answers_every_key_the_others_do() -> None:
    """Eleven of twelve languages were a fifth English, and the gate above said fine.

    MEASURED: `ru.json` carried 151 strings and every other table carried 128. The
    twenty-three-string gap was not spread thinly over rare corners. It was

        about.*   14   the whole About dialog below its title -- what this surface IS,
                       the research-use marking, the four MOS-UI-009a conditions
        prefs.*    6   the language note, all three panel-linking switches, and the
                       "stored on this computer" section with its promise
        chrome.*   3   dead keys, removed rather than translated (below)

    So a German reader opening Preferences saw `Einstellungen`, `Sprache`,
    `Panel-Verknüpfung` -- and then three English switch labels underneath them. The
    fallback is not the failure; a half-translated dialog is, because the reader cannot
    tell a missing string from a setting that does not apply to them.

    THE GATE ABOVE COULD NOT SEE IT. `len(real) >= 20` asks whether a table is a token
    effort. Every one of these was twenty-three strings short of complete and six times
    over that floor. A floor measures the wrong thing once there is more than one table:
    what matters is that they AGREE, and agreement is the only property that keeps
    working as keys are added.

    AND KEYS THAT ANSWER NOTHING ARE NOT TRANSLATED, THEY ARE REMOVED. Five were found
    while filling the gap, all reachable from no line of code:

        rail.study              in ALL twelve tables -- the left rail's study block was
                                removed at 0.4.0 and its heading key outlived it
        plane.acquired          in ALL twelve tables -- superseded by `plane.acquiredMark`,
                                which was added without removing it
        chrome.studies          in `ru.json` alone, duplicating `wl.studies`
        chrome.measurements     in `ru.json` alone, duplicating `rail.measurements`
        chrome.segmentation     in `ru.json` alone, duplicating `rail.segmentation`

    Translating those into eleven languages would have been 55 strings of work to make a
    dead key evenly dead.

    `plane.acquired` IS WHY THIS TEST MATCHES A QUOTED LITERAL rather than a substring. A
    hand-written scan for `key in source` found the other four and declared this one alive:
    `plane.acquired` is a PREFIX of `plane.acquiredMark`, which the code does ask for, so
    the substring was there and the key was not. The check below asks for `"key"` or
    `'key'` with its quotes, which is how the key is actually written at every site.

    WHAT "REACHABLE" MEANS HERE, because three families of key are built rather than
    written: `tool.${id}` and `tool.hint${Id}` in `app.js`, and `panel.${panel.id}` for a
    rail panel's heading. Those prefixes are exempted BY NAME below, with the line that
    builds each one, rather than by a blanket rule -- an exemption nobody can read is how
    `rail.study` survived being dead.
    """
    folder = VIEWER / "i18n"
    tables = {
        path.stem: json.loads(path.read_text(encoding="utf-8"))
        for path in sorted(folder.glob("*.json"))
    }
    assert len(tables) >= 11, f"only {len(tables)} language tables; re-read this test"

    keys = {code: {k for k in table if not k.startswith("_")} for code, table in tables.items()}
    union = set().union(*keys.values())
    short = {code: sorted(union - held) for code, held in keys.items() if union - held}
    assert not short, (
        "these languages are missing strings the others answer, so their interface is "
        "part English and a reader cannot tell a missing string from a setting that does "
        "not apply:\n"
        + "\n".join(
            f"    {code}: {len(missing)} missing -- {', '.join(missing[:6])}"
            + (" ..." if len(missing) > 6 else "")
            for code, missing in sorted(short.items())
        )
    )

    # EVERY KEY ANSWERS SOMETHING. The three built prefixes are named with the line that
    # builds them; everything else must appear literally in a source file.
    app = (VIEWER / "app.js").read_text(encoding="utf-8")
    # THE `tool.*` FAMILY IS COMPUTED, NOT EXEMPTED, and that distinction is the whole
    # point of this block. The first version of this test exempted the prefix, and the
    # very screen it was written to protect still had an English tooltip: `toolHint`
    # builds `tool.hint${Key}` from `TOOL_KEYS`, whose value for the freehand ROI is
    # `freehandRoi`, so it asks for `tool.hintFreehandRoi` -- and every table held
    # `tool.hintFreehand`. Found by reading the rendered Arabic toolbar, which is exactly
    # how app.js's own comment says the same class of defect was found the first time. A
    # blanket exemption is a gate that agrees not to look.
    for marker in (
        "t(`tool.${key}`, tool.title || tool.id)",
        "t(`tool.hint${key.charAt(0).toUpperCase()}${key.slice(1)}`, tool.hint)",
        "heading.dataset.i18n = `panel.${panel.id}`",
    ):
        assert marker in app, (
            f"this test computes the built keys from `{marker}`, which is no longer in "
            "app.js -- either the keys are literal now and this block should go, or they "
            "are built some other way and the block is reading a stale note"
        )

    names = re.findall(
        r"'[^']+':\s*'([A-Za-z]+)',", re.search(r"const TOOL_KEYS = \{(.*?)\n\};", app, re.S).group(1)
    )
    assert len(names) >= 6, f"TOOL_KEYS yielded {names}; the parse is wrong, not the map"

    tools_src = _js("tools", "measure-tools.js")
    hinted = {
        re.findall(r"id: '([^']+)'", tools_src[:m.start()])[-1]
        for m in re.finditer(r"^  hint: '", tools_src, re.M)
    }
    assert hinted, "no tool carries a hint; the hint keys below would be vacuous"
    ids = dict(re.findall(r"'([^']+)':\s*'([A-Za-z]+)',", re.search(r"const TOOL_KEYS = \{(.*?)\n\};", app, re.S).group(1)))
    expected = {f"tool.{n}" for n in names} | {
        f"tool.hint{ids[i][0].upper()}{ids[i][1:]}" for i in hinted if i in ids
    }

    absent = sorted(k for k in expected if k not in union)
    assert not absent, (
        "the viewer asks for these keys and no table answers, so they are English in "
        "every language -- and silently, because falling back to English is what `t()` "
        f"is FOR:\n" + "\n".join(f"    {key}" for key in absent)
    )

    sources = "\n".join(
        path.read_text(encoding="utf-8")
        for pattern in ("*.js", "*.html")
        for path in sorted(VIEWER.rglob(pattern))
    )
    # A key is alive if it is BUILT (computed above) or written literally somewhere. The
    # one family still taken on trust is `panel.*`, whose ids come from whatever a rail
    # panel registers at runtime; `tool.*` used to be on that list and this is what it
    # cost. `tool.arms` needs no special case here -- it is a literal and the check below
    # finds it as one.
    dead = sorted(
        key
        for key in union
        if key not in expected
        and not key.startswith("panel.")
        and f'"{key}"' not in sources
        and f"'{key}'" not in sources
    )
    assert not dead, (
        "these keys are translated into every language and read by no line of code:\n"
        + "\n".join(f"    {key}" for key in dead)
        + "\n  A dead key costs one translation per language every time somebody fills a "
        "gap, and hides the live key it duplicates. Remove it instead."
    )


def test_the_rail_folds_and_the_measurements_group() -> None:
    """A rail that shows everything at once shows nothing in particular.

    The right rail carries Study, Segmentation and Measurements together, so a reader
    working through twenty measurements had a third of it spent on two sections saying
    "none on this panel". And twenty measurements in one flat table is a list you scan
    rather than read -- the question is almost never "what is the ninth row", it is
    "where are my regions".

    BOTH ARRANGEMENTS ARE THE READER'S VIEW, like `hiddenMeasurements`: per-browser, never
    sent anywhere, and never on the record. A folded group still shows its COUNT, because
    a fold that hides the rows AND the fact that there are rows is a way to lose a
    measurement without deleting one.
    """
    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    panel = _code(_js("ui", "measurements-panel.js"))

    assert "function makeSectionsFoldable()" in app, "rail sections cannot be folded"
    assert "aria-expanded" in app, (
        "a folded section does not announce that it folds, so a screen reader meets a "
        "heading that mysteriously empties when clicked"
    )
    # THE TRANSLATION MARKER MOVES WITH THE HEADING'S CHILDREN. Leaving it behind meant
    # `paintChrome` wrote textContent on the heading and destroyed the button inside it --
    # the section rendered exactly as before, with nothing to click.
    assert "delete heading.dataset[marker]" in app, (
        "the heading keeps its data-i18n, so the next repaint destroys the fold button"
    )

    assert "function grouped(rows, mode)" in panel, "measurements cannot be grouped"
    assert "meas-group-head" in panel, "a group cannot be folded"
    assert "mg-count" in panel, (
        "a folded group does not show how many measurements it holds, so folding one "
        "hides that they exist"
    )

    # REGROUPING CLEARS THE FOLDS, because a group key from `by kind` names nothing under
    # `by slice` and would fold arbitrary groups of the new arrangement.
    body = panel[panel.index("groupSelect.onchange"):][:420]
    # THE WRITE, not the read. `readStore(FOLD_KEY, [])` contains the same substring, so
    # a bare `"FOLD_KEY, []"` passed while the clearing write was deleted.
    assert "writeStore(FOLD_KEY, [])" in body, (
        "changing the grouping keeps folds keyed to the old arrangement"
    )

    # AND NONE OF IT REACHES THE RECORD OR THE EXPORT.
    export = _code(_js("ui", "export.js"))
    for forbidden in ("GROUP_KEY", "FOLD_KEY", "grouped("):
        assert forbidden not in export, (
            f"the CSV consults {forbidden}, so how a reader arranged their panel changes "
            "what was exported"
        )
    measure = _code(_js("image", "measure.js"))
    assert "GROUP_KEY" not in measure and "folded" not in measure, (
        "the measurement record knows how the panel was arranged"
    )


def test_every_colour_the_viewer_names_is_a_colour_the_palette_defines() -> None:
    """`background: var(--bg-2)` on an undefined property paints NOTHING.

    It is not a parse error, it does not warn, and it does not fall back to anything. The
    rule is simply dropped. So three surfaces added against invented names -- the About
    dialog, the Preferences dialog and the gear menu -- rendered fully TRANSPARENT: the
    image and the measurement lines showed through them, and the menu's text landed on top
    of the patient's name.

    Nothing in the source looked wrong. The palette is documented at the top of
    `styles.css`; the names were simply assumed rather than read.
    """
    css = (VIEWER / "styles.css").read_text(encoding="utf-8")

    defined = set(re.findall(r"^\s+(--[a-z0-9-]+)\s*:", css, re.M))
    assert defined, "the palette block is gone from styles.css"

    used = set(re.findall(r"var\(\s*(--[a-z0-9-]+)", css))
    # A `var()` may carry a fallback -- `var(--x, #000)` is safe even when --x is unknown.
    with_fallback = set(re.findall(r"var\(\s*(--[a-z0-9-]+)\s*,", css))

    missing = sorted(used - defined - with_fallback)
    assert not missing, (
        f"these custom properties are used and never defined: {missing}. An undefined "
        "property makes the whole declaration do nothing, so a surface written against "
        "one renders transparent rather than failing"
    )


def test_the_safety_marking_is_never_dimmed_below_the_point_it_can_be_read() -> None:
    """MOS-SAFE-001 is a statement someone has to READ. Twice it was not readable.

    A modal's scrim was `inset: 0`, so it covered the footer too -- and `.foot` is
    unpositioned, so it painted UNDER the z-index 40 wash. The statement fell from 5.06:1
    to 1.79:1 for as long as About or Preferences was open, which is most of the time
    somebody is looking at either. `MOS-UI-008` binds that statement to a PERSISTENTLY
    reachable footer and a modal is not an exception to it.

    Separately the research-use marking was the SMALLEST text on the whole surface -- 9px
    at weight 600, then knocked to 85% opacity, composited to 3.95:1 against `--panel`.
    Below the 4.5:1 AA floor, on the one line whose entire purpose is that it gets read.
    """
    css = _code((VIEWER / "styles.css").read_text(encoding="utf-8"))

    # THE SCRIM STOPS AT THE FOOTER.
    back = css[css.index(".dlg-back"):][:260]
    assert "inset: 0 0 var(--h-foot) 0" in back, (
        "the modal backdrop covers the footer, so opening a dialog washes the MOS-SAFE-001 "
        "statement out for as long as the dialog is open"
    )

    # AND THE MARKING IS NOT DIMMED BY OPACITY.
    ruo = css[css.index(".foot-ruo"):][:300]
    assert "opacity: 1" in ruo, (
        "the research-use marking is dimmed by opacity; hierarchy between the two footer "
        "lines belongs in a colour step, not in fading a required marking toward invisible"
    )
    assert "opacity: 0.85" not in ruo and "opacity: .85" not in ruo, (
        "the research-use marking is back under an opacity multiplier"
    )

    # AND IT IS NOT THE SMALLEST TEXT ON THE SURFACE.
    foot = css[css.index(".foot {"):][:420]
    assert "9px" not in foot, (
        "the footer's safety lines are back at 9px, which cannot reach AA in --warn-foot "
        "and is the smallest type in the viewer"
    )

    # AND IT DOES NOT REORDER IN A RIGHT-TO-LEFT LAYOUT -- a statement whose full stop
    # moves to the front is not the statement the requirement names.
    assert ".foot-statement," in css and ".hud," in css, (
        "the footer statement and the image readouts are not isolated from the surrounding "
        "text direction, so they reorder under dir=rtl"
    )


def test_a_note_can_be_rewritten_after_it_is_written() -> None:
    """A typo in a note was permanent.

    `editNote` in the shell is reached from exactly one place: the instant a note is
    committed with an empty string. The moment the reader pressed Enter, `m.text` was set
    and nothing could open that editor again -- so correcting a word meant deleting the
    note and placing a new one, which loses the anchor it was pinned to.

    The panel already edits `label` in place by writing state; a note's TEXT is edited the
    same way, in the cell the text is actually in. F2 follows it, because for a note the
    thing the row is about is its sentence, not its name.

    AN EMPTY RESULT KEEPS THE NOTE. The reader asked to change the words, not to remove
    the mark -- `editNote` deleting an abandoned NEW note is a different situation.
    """
    panel = _code(_js("ui", "measurements-panel.js"))

    # THE ASSIGNMENT, not the selector string -- which also appears in the F2 handler,
    # so a bare substring passed while this lookup was replaced with null.
    assert "const noteCell = row.querySelector('td.note-text');" in panel, (
        "nothing in the panel addresses the cell a note's text lives in, so the text "
        "cannot be edited after it is first written"
    )
    assert "aria-label', 'Text for this note'" in panel or 'Text for this note' in panel, (
        "the note editor has no accessible name"
    )
    # THE FROZEN RECORD IS REPLACED, NOT MUTATED -- the rule the label rename already states.
    body = panel[panel.index("const commitNote"):][:700]
    assert "Object.freeze({ ...x, text })" in body, (
        "the note's text is assigned in place, so the record is mutated and nothing "
        "re-renders"
    )
    # THE BEHAVIOUR, not its spelling: abandoning the edit must redraw from state, so the
    # note's previous text comes back. The first version of this assertion pinned the exact
    # line and broke the moment that path also restored focus -- a better exit, failed by a
    # gate reading characters.
    assert "if (!keep) {" in body and "render(root);" in body, (
        "Escape does not restore the note's previous text"
    )
    # AND FOCUS COMES BACK TO THE ROW, on every exit path. A re-render destroys the input
    # mid-edit, so focus falls to <body> and the selection collapses to a CARET on the
    # panel's own heading -- a blinking caret telling the reader that heading is a text
    # field, while their next keystroke reaches the shell's global bindings instead.
    # ON EVERY EXIT PATH, counted. Both editors commit, and both can be abandoned with
    # Escape -- a bare `in` check passed while one of those four paths was deleted.
    # FIVE is what the two editors have: commit and Escape for the note, commit and
    # cancel for the label, and the keydown path. `>= 4` passed while one was deleted,
    # which is the same off-by-one this file has been bitten by before.
    assert panel.count("restoreRowFocus(root, id)") >= 5, (
        f"only {panel.count('restoreRowFocus(root, id)')} of the four edit exit paths "
        "return focus to the row; the others leave focus on <body> with a caret stranded "
        "in the panel's heading"
    )

    # A NOTE WITH NO SPACES IS ONE UNBREAKABLE WORD. `white-space: normal` breaks only
    # BETWEEN words, so such a note overflowed its cell and pushed the value column and
    # the row's controls out of the panel entirely.
    css = _code((VIEWER / "styles.css").read_text(encoding="utf-8"))
    note_rule = css[css.index(".meas .note-text {"):][:400]
    assert "overflow-wrap: anywhere;" in note_rule, (
        "a note typed without spaces cannot wrap, so it overflows its cell and pushes the "
        "measured value out of the row"
    )
    # AND IS NOT TRUNCATED. A note is prose the reader wrote; an ellipsis hides clinical
    # text they put there deliberately.
    assert "text-overflow: ellipsis" not in note_rule, (
        "a note is truncated, which hides text the reader wrote on purpose"
    )

    # AND F2 REACHES THE TEXT, not the name, for a note.
    assert ("const cell = row.querySelector('td.note-text') || row.querySelector('td');"
            in panel), (
        "F2 on a note row offers to rename `note` while leaving the sentence untouchable"
    )

    # THE VALUE OF A MEASUREMENT IS STILL NOT EDITABLE. A note is prose the reader wrote;
    # a measurement is a number that came off an image, and nothing here may offer to
    # change one by hand.
    assert "x, value }" not in panel and "value: input.value" not in panel, (
        "a measured value can be edited by hand, which forges provenance"
    )


def test_a_rail_can_be_collapsed_and_brought_back_without_a_keyboard() -> None:
    """Collapsing a rail existed, on two keys that were not in the key list.

    `toggleRail` was reachable only from `[` and `]`, and `toggleHelp` did not name them.
    So the feature was undiscoverable; and worse, a reader who found it by accident was
    left with a hidden rail and nothing on screen to bring it back. A capability you
    cannot reach is the same as one that is not there, except that it can also trap you.

    THE STRIP IS THE WAY BACK. 18px: wide enough to hold a target that clears WCAG 2.2
    SC 2.5.8 in its long axis, narrow enough that reclaiming the space is still the point
    -- measured, the image goes from 1060px to 1427px when the findings rail folds.
    """
    rails = _code(_js("ui", "rails.js"))

    assert "function buildRailControls()" in rails, (
        "the rails have no visible control, so collapsing one is reachable only from a key"
    )
    assert "buildRailControls();" in rails, (
        "the control builder is defined and never called"
    )
    # BOTH DIRECTIONS. A close with no open is a trap.
    assert "toggleRail(name, true)" in rails and "toggleRail(name, false)" in rails, (
        "a rail can be closed or opened but not both from the screen"
    )
    assert "data-restores" in rails and "data-collapses" in rails, (
        "the controls cannot be found again to keep their state in step with the rail"
    )
    # AND THE STRIP APPEARS EXACTLY WHEN THE RAIL DOES NOT.
    body = rails[rails.index("function applyHidden("):][:900]
    assert "strip.hidden = !isHidden" in body, (
        "the restore strip does not follow the rail's state, so it is either always there "
        "or never there"
    )

    # THE KEYS ARE IN THE KEY LIST. They were the only route and went unmentioned.
    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    help_rows = app[app.index("function toggleHelp("):][:2600]
    assert "hide or show the left / right rail" in help_rows, (
        "the rail shortcuts are still absent from the list of keys, which is where a "
        "reader looks for them"
    )

    css = _code((VIEWER / "styles.css").read_text(encoding="utf-8"))
    assert ".rail-restore {" in css and ".rail-collapse {" in css, (
        "the controls have no rule, so they render as unstyled default buttons"
    )


def test_the_viewer_fits_the_window_it_is_given() -> None:
    """A flex item defaults to `min-width: auto`, and this one overflowed the screen.

    MEASURED in a 1024 px viewport, with a two-series study open in the 1x2 layout that
    `openStudy` selects for it:

        section.viewer   2716 px wide inside a 1024 px main
        each panel       1212 px, so the SECOND one sat entirely off-screen
        document         scrollWidth 2716, a horizontal scrollbar

    For a linked pair that is the whole feature gone: the panel carrying the
    `position-linked` badge is the one you cannot see. And the toolbar ran off with it --
    every control past `Link zoom`, including the plane buttons the entire reconstruction
    surface is reached through.

    TWO FLOORS, ONE SYMPTOM EACH, and neither is enough alone. `min-width: 0` lets the
    section shrink to its parent; `flex-wrap: wrap` lets the toolbar fold once it has a
    real width to fold within. With only the first, the toolbar still spills; with only the
    second, it has nothing to wrap inside. `min-height: 0` was already present on `.viewer`
    for the vertical axis and for exactly the same reason, which is what makes the missing
    horizontal one an omission rather than a decision.
    """
    styles = (VIEWER / "styles.css").read_text(encoding="utf-8")

    viewer = re.search(r"\.viewer\s*\{(.*?)\}", styles, re.S)
    assert viewer, "no .viewer rule"
    body = viewer.group(1)
    assert re.search(r"min-width:\s*0", body), (
        "`.viewer` has no `min-width: 0`, so it refuses to shrink below its content and "
        "overflows the window instead -- taking the second panel off-screen with it"
    )
    assert re.search(r"min-height:\s*0", body), (
        "the vertical floor went with it; both axes or neither"
    )

    tools = re.search(r"\.tools\s*\{(.*?)\}", styles, re.S)
    assert tools, "no .tools rule"
    assert re.search(r"flex-wrap:\s*wrap", tools.group(1)), (
        "the toolbar is a single non-wrapping row, so on a narrow window its later groups "
        "-- the plane buttons among them -- are simply unreachable"
    )
def test_the_row_that_clips_has_somewhere_to_put_what_it_clips() -> None:
    """`.bar-tools` does not wrap and hides what it cannot fit. Measured: that is controls.

    The rule over `.bar-tools` chose `overflow: hidden` rather than wrapping, and the
    reason it gives is sound -- a wrapping row of these glyphs costs the picture a band of
    chrome. What it did not say is where the overflow goes, and the answer was nowhere.
    Measured on this build with a study open:

        1440 and wider   nothing lost
        1366             15px of the last button's edge
        1340             Export measurements unreachable
        1320             and Capture
        1280             and Reset view
        1200             and Invert, Segmentation overlay, Cine

    Unreachable is exact rather than rhetorical: `document.elementFromPoint` at the centre
    of each of those buttons answered with the patient-name banner, not with the button.
    The first three to go are the two that carry evidence out of this viewer and the one
    that puts the picture back to a known state.

    THREE THINGS MAKE THE REPAIR AND THIS GATE ASKS FOR ALL THREE.

    The control that opens the overflow is OUTSIDE the box that clips. Inside it, it is the
    first thing `overflow: hidden` takes away -- the one control that must survive is the
    one that says a control is missing.

    The measurement runs whenever the row's available width can change. That is the window,
    every rebuild of the row (a longer language, one more registered tool), and the moment
    a study opens or closes: the identity banner is 190px and its arrival fires no resize
    event, which is precisely the case a `resize` listener alone would miss.

    What is hidden is reached by activating the BUTTON, not a copy of its handler. These
    buttons carry ids, toggle state and bindings written by four different builders; a menu
    that re-implemented any of that would be a second definition to keep in step.
    """
    markup = (VIEWER / "index.html").read_text(encoding="utf-8")
    raw_source = (VIEWER / "app.js").read_text(encoding="utf-8")
    # A COMMENTED-OUT LINE IS NOT A WIRE. This gate was written asking whether certain text
    # appears in app.js, and text appears in a comment: `// window.addEventListener(
    # 'resize', fitToolbar);` left it green while the row was measured once and never
    # again. Whole-line comments go before anything below is asked. A trailing comment
    # after code stays, because the code on that line is live.
    source = re.sub(r"^[ \t]*//.*$", "", raw_source, flags=re.M)

    assert 'id="bar-more"' in markup, (
        "there is no overflow control, so a toolbar narrower than its contents loses the "
        "tail of the row with nothing on screen saying a control existed"
    )
    box = re.search(r'<div class="bar-tools" id="bar-tools">(.*?)</div>', markup, re.S)
    assert box, "no .bar-tools container"
    assert 'id="bar-more"' not in box.group(1), (
        "the overflow control is inside the box that clips, which makes it the first thing "
        "clipped -- the row then loses both the controls and the way to reach them"
    )

    assert re.search(r"function fitToolbar\(", source), "no fitToolbar"
    assert re.search(r"addEventListener\('resize', fitToolbar\)", source), (
        "the row is measured once and never again, so every window resize after load "
        "leaves it either clipping silently or showing an overflow control for nothing"
    )
    rebuild = re.search(r"function rebuildToolbarChrome\(\) \{(.*?)\n\}", source, re.S)
    assert rebuild and "fitToolbar()" in rebuild.group(1), (
        "the row is rebuilt without being re-measured; a language whose words are longer "
        "than English then clips, and the overflow control stays hidden while it does"
    )
    # The banner is the largest single change to the row's width and fires no resize event.
    # ASKED OF THE FUNCTION, NOT OF A WINDOW OF CHARACTERS AFTER A LINE. The call belongs
    # where the banner is FINISHED, and between `el.who.hidden = false` and there sits a
    # five-line note about a PatientID equal to the name; a character window measures the
    # distance between two statements rather than whether one is in the same function.
    for name_, what in (
        ("renderStudyIdentity", "a study opening"),
        ("showStudies", "a study closing"),
    ):
        body = re.search(r"function " + name_ + r"\([^)]*\) \{(.*?)\n\}", source, re.S)
        assert body, f"no {name_}"
        assert "fitToolbar()" in body.group(1), (
            f"{what} moves 190px in or out of the header and fires no resize event, and "
            f"the row is not re-measured for it"
        )

    assert re.search(r"item\.onclick = \(\) => \{[^}]*source\.click\(\);", source), (
        "the menu entry does not activate the button it stands for, so the control's id, "
        "its toggle state and whichever builder bound it now have a second definition"
    )
def test_the_absent_crosshair_is_stated_once_and_not_across_the_scale_bar() -> None:
    """One fact, one statement, and it does not lie over the measurements beside it.

    MEASURED on a 2x2 of a real MR study, in each of the two panels the badge called `not
    linked`: the sentence `no crosshair: no shared coordinate system with the panel you are
    reading` is 355px wide and covered the `not linked` badge by 99x15 px -- the badge's
    whole width -- the `50 mm` scale bar by 35x12, and the `P` orientation letter by 10x2.
    Nine text-on-text overlaps across the four panels; none of them now.

    WHAT WAS DROPPED IS THE DUPLICATE, NOT THE STATEMENT. `sync.js` says absence is
    REPORTED rather than returned as null, because a missing crosshair is indistinguishable
    from a viewer that has not drawn one. That argument is satisfied by the badge, which is
    on screen, says the same thing, and carries the longer form in its tooltip.

    AND ONLY THAT ONE. `crosshairOn` has two reasons and `LINK.NONE` has four; the badge
    reading `none` is NOT evidence that the badge states THIS absence, because two of those
    four -- slices along different axes, no usable step between planes -- happen between
    series that share a coordinate system, where a crosshair can still be absent for want
    of pixel spacing. The reason carries a code so the two can be told apart without
    matching on a sentence somebody may later improve.

    THE PANEL THAT MUST NOT MOVE IS THE ONE NOBODY REDRAWS. `r.index === null` means do not
    scroll this panel, so `draw(t)` is skipped for it -- and it is exactly the panel whose
    overlay holds the sentence. Without a redraw the suppression is real and invisible:
    verified on screen, where the sentence survived two scrolls before this line existed.
    """
    sync = (VIEWER / "src" / "image" / "sync.js").read_text(encoding="utf-8")
    annotations = (VIEWER / "src" / "render" / "annotations.js").read_text(encoding="utf-8")
    app = (VIEWER / "app.js").read_text(encoding="utf-8")

    # ASKED OF THE EXPORT, NOT OF THE WORD. `"ABSENT" in sync` is satisfied by the word
    # in a comment and by a renamed `ABSENT_`, which is how this assertion first passed
    # against a break that removed the export outright.
    assert "export const ABSENT = Object.freeze({" in sync, (
        "the two absence reasons are told apart by their sentences, if at all; a reworded "
        "sentence then either restores the duplicate or suppresses the wrong one"
    )
    for code in ("FRAME_OF_REFERENCE:", "NO_PIXEL_SPACING:"):
        assert code in sync, f"ABSENT declares no {code[:-1]}"
    assert sync.count("because: ABSENT.") == 2, (
        "one of `crosshairOn`'s two absence reasons carries no code, so a caller cannot "
        "tell the duplicate from the fact nothing else reports"
    )
    assert "cross.because !== ABSENT.FRAME_OF_REFERENCE" in app, (
        "the suppression is not gated on which absence this is; `LINK.NONE` covers four "
        "situations and two of them arise between series that DO share a frame of reference"
    )
    assert "if (r.index === null) drawOverlays(t);" in app, (
        "the panel that must not move is never redrawn, so whatever its overlay drew "
        "before the link was evaluated stays on screen -- including the sentence this "
        "suppression exists to remove"
    )
    # The badge owns `height-58..height-30` and the scale bar `height-61..height-34`.
    assert "canvasSize.height - 66" in annotations, (
        "the absence sentence is drawn back inside the band the badge and the scale bar "
        "already occupy"
    )
    # THE GUARD, NOT THE CALL. The call also appears inside the trimming loop, so asking
    # for the name alone stayed green against a break that replaced the guard with `false`.
    assert "if (node.getComputedTextLength() > room) {" in annotations, (
        "an SVG <text> neither wraps nor clips, so on a narrow panel this sentence runs "
        "off the picture it belongs to and over its neighbour"
    )
def test_the_marks_in_the_rail_sit_in_a_row_and_are_drawn_from_the_icon_set() -> None:
    """Two marks a reader reported, and both were built out of their own place.

    THE PANEL NUMBER. `.panel-tag` is declared `flex: 0 0 auto` -- written for a flex row --
    and was appended to the `<li>`, which is not one. Its own box (10px type, `padding: 1px
    4px`) then rose into the line above: measured, 12x2 px over the image count, which on
    the reader's screen read as the figure `1` sitting on `457 images`. It belongs in
    `.series-row` beside the modality dot, the modality and the series number, pushed to the
    far end -- the row that was already a flex row and already holds what identifies the
    series.

    THE FOLD CHEVRON. It was a 5x5 box with a right and a bottom border turned 45 degrees.
    At one device pixel per CSS pixel a rotated 1px border antialiases into a mark that
    matches no glyph in `icons.js`, and a reader called it a strange arrow. The set has had
    a `chevron` since it was written.

    AND WHY IT COULD NOT BE ONE BEFORE, which is the part worth keeping. `paintChrome`
    writes `textContent` on every node carrying `data-i18n`; the fold button carried it, so
    any child of that button was destroyed on the next paint and only a pseudo-element
    could survive. The marker moved to an inner `.fold-label`, so the button is safe to put
    a glyph in -- verified by switching the interface to Russian and back with the chevrons
    still on screen.
    """
    styles = (VIEWER / "styles.css").read_text(encoding="utf-8")
    app = (VIEWER / "app.js").read_text(encoding="utf-8")

    assert "(li.querySelector('.series-row') || li).appendChild(tag);" in app, (
        "the panel number is appended to the list item again; `.panel-tag` is a flex child "
        "and the item is not a flex container, so its box rises into the image count"
    )
    tag = re.search(r"\.panel-tag \{(.*?)\}", styles, re.S)
    assert tag and "margin-left: auto" in tag.group(1), (
        "the panel number does not take the far end of its row, so it sits against the "
        "series number instead of against the edge"
    )

    assert "mark.innerHTML = icon('chevron');" in app, (
        "the fold mark is not the icon set's chevron"
    )
    assert ".rail-section h3 .fold::before" not in styles, (
        "the rotated-border chevron is still in the stylesheet beside the icon, which is "
        "two definitions of one glyph and one of them is the one a reader complained about"
    )
    # The marker has to be on the label, or `paintChrome` eats the glyph on the next paint.
    foldable = re.search(r"function makeSectionsFoldable\(\) \{(.*?)\n\}", app, re.S)
    assert foldable, "no makeSectionsFoldable"
    assert "label.dataset[marker] = heading.dataset[marker];" in foldable.group(1), (
        "the translation marker is back on the button, so the first language change "
        "replaces the button's children -- the chevron among them -- with a text node"
    )
def test_each_rail_reserves_the_heading_edge_its_own_button_sits_on() -> None:
    """A rule that reads as the fix and protects the wrong edge is worse than no rule.

    THE DEFECT A READER PHOTOGRAPHED. On the right rail the collapse button's box was
    [1036, 49, 18, 18] at a 1280px window and the first section's fold chevron [1041, 53,
    12, 12] -- the chevron entirely inside the button. Two arrow-shaped marks in one spot.

    AND THE RESERVATION FOR IT ALREADY EXISTED, MIRRORED. The stylesheet carried

        .aside > .rail-section:first-of-type h3 .fold { padding-right: 28px; }
        .side  > .rail-section:first-of-type h3 .fold { padding-left: 28px; }

    under a comment saying the first heading yields room to the button. `rails.js` derives
    the button's side as `name === 'left' ? 'right' : 'left'`, so the LEFT rail's button is
    at its right edge and the RIGHT rail's at its left: each rule reserved the edge its
    rail's button is not on. On the left rail that was invisible -- the padding went into
    empty space beside a short heading -- so the pair read as done and was never looked at
    again.

    WHY A GATE AND NOT A CAREFUL READING. Both sides of this are physical and neither is
    named in the other's file: `rails.js` picks the class, `styles.css` turns the class
    into an offset, and a third rule reserves the room. Nothing made them agree, and the
    disagreement was a 12x12 overlap that survived because it looked like a decision.
    """
    styles = (VIEWER / "styles.css").read_text(encoding="utf-8")
    rails = (VIEWER / "src" / "ui" / "rails.js").read_text(encoding="utf-8")

    assert "const side = name === 'left' ? 'right' : 'left';" in rails, (
        "the collapse button's side is derived somewhere else now; this gate's arithmetic "
        "about which edge each rail reserves is written against that line"
    )
    # LOGICAL ON BOTH SIDES OF THE AGREEMENT. These were `right: 5px` / `left: 5px`, and
    # `dir="rtl"` swaps which side of the window each rail is on while a physical offset
    # stays: measured in Arabic at 1024, the study rail sat at 838..1024 with its control
    # at x=1000 -- the window's edge -- instead of beside the picture. The reservation was
    # physical too, and agreed with the control only because both happened to be measured
    # from the same edge of the same rail.
    assert ".rail-collapse-right { inset-inline-end: 5px; }" in styles, (
        "the study rail's control is offset physically again, so in a right-to-left "
        "language it sits at the window's edge rather than beside the picture"
    )
    assert ".rail-collapse-left { inset-inline-start: 5px; }" in styles, (
        "the measurements rail's control is offset physically again"
    )
    for direction in ('[dir="rtl"] .rail-collapse-right span',
                      '[dir="rtl"] .rail-collapse-left span'):
        assert direction in styles, (
            f"{direction} has no mirrored rotation, so the arrow points away from the "
            f"picture in a right-to-left language"
        )

    # `.side` gets `rail-collapse-right` (inline end); `.aside` gets `rail-collapse-left`.
    for rail, edge, wrong in (("aside", "padding-inline-start", "padding-inline-end"),
                              ("side", "padding-inline-end", "padding-inline-start")):
        pattern = r"\." + rail + r" > \.rail-section:first-of-type h3 \.fold \{([^}]*)\}"
        found = re.findall(pattern, styles)
        assert found, f"`.{rail}` reserves no room in its first heading for its own button"
        assert len(found) == 1, (
            f"`.{rail}`'s first heading carries {len(found)} reservations; two rules with "
            f"one selector and opposite sides pad both edges and leave the next reader "
            f"asking which is the real one"
        )
        assert edge in found[0], (
            f"`.{rail}` reserves the wrong edge: its button takes the {edge.split('-')[-1]} "
            f"of the rail and the room is made on the other side, which is what put a "
            f"12x12 chevron underneath it"
        )
        assert wrong not in found[0], f"`.{rail}` also pads the edge with no button on it"


def test_the_chrome_mirrors_and_the_anatomy_never_does() -> None:
    """`dir="rtl"` is a fact about reading, and half this surface is not read.

    WHAT MAY MIRROR: the rails, the menus, the toolbar, the worklist, the labels -- text,
    and the order text is read in. A reader of Arabic expects all of it.

    WHAT MAY NOT: the picture and everything that describes its geometry. `R` and `L` are
    the PATIENT's sides; a viewer that put them on the reader's sides would be telling a
    surgeon the wrong side of a head. Measured in Arabic at 1024, inside every panel:
    `.hud-left` at x=12 from the panel's physical left, `.hud-right` at 262 of 283, the
    scale bar centred at 142 -- unmirrored, because those rules are physical.

    AND THE GRID WAS NOT. `#grid` inherited `direction: rtl` and reversed the columns: panel
    0 moved to the right column (x=545 instead of 260). A panel is a POSITION in a hanging
    protocol -- "prior on the left, current on the right" is a departmental agreement that
    reaches teaching material and the DICOM Hanging Protocol IOD, where positions are
    absolute -- so it is the same kind of thing as the markers, not the same kind as a
    sentence.

    `unicode-bidi: plaintext` IS THE OTHER HALF. With the grid pinned to `ltr`, an Arabic
    series description inside the HUD would be laid out as if it were English. Plaintext
    takes each string's direction from its own first strong character, so the text reads
    right-to-left inside a box that stays where the anatomy is.
    """
    styles = (VIEWER / "styles.css").read_text(encoding="utf-8")

    assert "#grid { direction: ltr; }" in styles, (
        "the panel grid follows the reading direction, so in Arabic the first series "
        "hangs in the right-hand column and a hanging protocol means something different "
        "depending on the interface language"
    )
    # THE SELECTOR IS IN THE RULE, not the rule written exactly this way. This assertion
    # was the literal declaration and went red when the selector became a group -- on a
    # change that widened the same behaviour to the note field and the refusal text. A
    # gate that reddens on a correct edit teaches people to paste around it.
    plaintext = re.search(r"([^{}]*)\{[^{}]*unicode-bidi:\s*plaintext[^{}]*\}", styles, re.S)
    assert plaintext and "#grid .hud" in plaintext.group(1), (
        "with the grid pinned to one direction, an Arabic label inside a panel is laid "
        "out as if it were English"
    )
    assert "#grid .note-input" in plaintext.group(1), (
        "a note typed in Arabic goes into a field the grid has pinned to left-to-right"
    )
    # The four edge markers must stay physical: logical properties would flip them.
    for rule in (".hud-left   { left: 12px;", ".hud-right  { right: 12px;"):
        assert rule in styles, (
            f"`{rule.split()[0]}` no longer places itself physically; the laterality "
            f"markers are the patient's sides and must not follow the reader's"
        )
    assert "inset-inline" not in styles[styles.index(".hud-left"):styles.index(".hud-left") + 400], (
        "an edge marker was given a logical offset, which mirrors R and L in Arabic"
    )
def test_no_rule_claims_something_it_cannot_do() -> None:
    """Two rules that could not fire under any condition, and both read as decisions.

    THE FIRST SECTION'S DIVIDER. `.side > .rail-section:first-child h3 { border-top: 0 }`
    exists to take the separator off the heading at the top of a rail, where there is
    nothing above to separate from. `rails.js` does `el.prepend(toggle)`, so the first
    CHILD of a rail is the collapse button and the selector never matched: verified on the
    live tree -- `firstSection.matches(':first-child')` was false in both rails and the
    computed `border-top` was `1px rgb(31, 43, 68)`, a section divider drawn between a
    heading and the toolbar band. After: `0px` on the first heading, `1px` on the rest.

    THE DRAG CURSOR. `.annot.dragging { pointer-events: all; cursor: grabbing; }` promised
    two things and did neither. `annotations.js` sets `this.svg.style.pointerEvents =
    'none'` INLINE, which outranks any stylesheet rule -- deliberately, and the comment
    beside it cites MOS-UI-207: window and level must work the moment a case opens, and a
    layer that takes pointer events breaks that as soon as one measurement exists. An
    element outside hit-testing is not asked for its cursor either, so `grabbing` never
    showed; the canvas underneath answered. The cursor now comes from the body, which is
    where `body.rail-dragging` already puts the splitter's.

    WHY A GATE. A dead rule is not inert: it is a sentence in the stylesheet saying the
    surface does something, and the next reader believes it. Both of these were found by
    reading, not by anything failing.
    """
    styles = (VIEWER / "styles.css").read_text(encoding="utf-8")
    app = (VIEWER / "app.js").read_text(encoding="utf-8")
    rails = (VIEWER / "src" / "ui" / "rails.js").read_text(encoding="utf-8")

    assert "el.prepend(toggle)" in rails, (
        "this gate's reason for `:first-of-type` is that a button is prepended to each "
        "rail; if that changed, re-read both"
    )
    assert ".rail-section:first-child" not in styles, (
        "a rail rule selects `:first-child`, which is the collapse button `rails.js` "
        "prepends -- the rule cannot match"
    )
    for rail in ("side", "aside"):
        assert f".{rail} > .rail-section:first-of-type h3" in styles, (
            f"`.{rail}`'s first heading keeps the section divider above it, with the "
            f"toolbar on the other side of the line"
        )

    # THE DECLARATION, NOT THE WORD: the comment that replaced this rule quotes it, which
    # is the point of the comment and would otherwise fail its own gate.
    assert not re.search(r"^\s*\.annot\.dragging\s*\{", styles, re.M), (
        "the annotation layer is given `pointer-events` and a cursor by a rule that an "
        "inline style outranks; neither half can fire"
    )
    assert "body.annot-dragging { cursor: grabbing; }" in styles, (
        "nothing shows a grab cursor while a measurement handle is being dragged"
    )
    assert "document.body.classList.add('annot-dragging')" in app, (
        "the body class is never set, so the rule that replaced the dead one is dead too"
    )
    assert "document.body.classList.remove('annot-dragging')" in app, (
        "the grab cursor is never taken off, so the whole surface keeps it after a drag"
    )
    assert "this.svg.style.pointerEvents = 'none';" in (
        VIEWER / "src" / "render" / "annotations.js").read_text(encoding="utf-8"), (
        "the inline guard on the annotation layer is gone; MOS-UI-207's bindings are what "
        "it was protecting"
    )
def test_there_is_one_chevron_and_it_comes_from_the_icon_set() -> None:
    """Five marks, five definitions, and a reader noticed two of them side by side.

    THE SHAPE WAS DRAWN FIVE TIMES, four of them as a square with two borders turned 45
    degrees, at four different sizes:

        .rail-section h3 .fold      12px, from `icons.js`
        .rail-collapse span          5x5 rotated border
        .rail-restore span           5x5 rotated border
        .wl-expand::after            6x6 rotated border
        .meas-group-head::before     4x4 rotated border

    The first two sit 12px apart in the right rail. A reader photographed that pair and
    called it a strange arrow: at one device pixel per CSS pixel a rotated 1px border
    antialiases into a smudge, and beside a stroked SVG of the same glyph the two read as
    different marks rather than the same one twice.

    ALL FIVE NOW COME FROM `icon('chevron')`, at the stroke width every other glyph on this
    surface uses, and the open/closed states are a QUARTER turn because the set draws the
    chevron pointing down -- not an eighth, which is what a rotated square needed.

    WHY IT WAS A PSEUDO-ELEMENT IN THE FIRST PLACE, and why it need not be here:
    `paintChrome` writes `textContent` on every node carrying `data-i18n`, so a child of
    such a node is destroyed on the next paint. None of these four is one --
    `labelRailControls` writes only `title` and `aria-label`, `.wl-expand` carries its
    label in an inner `.sr-only`, and the measurement groups are re-rendered as a string.

    THE SORT INDICATOR IS NOT A CHEVRON and is left alone: `.wl-sort::after` is a CSS
    border triangle standing for ascending or descending, a different glyph for a
    different job.
    """
    styles = (VIEWER / "styles.css").read_text(encoding="utf-8")
    app = (VIEWER / "app.js").read_text(encoding="utf-8")
    rails = (VIEWER / "src" / "ui" / "rails.js").read_text(encoding="utf-8")
    meas = (VIEWER / "src" / "ui" / "measurements-panel.js").read_text(encoding="utf-8")
    icons = (VIEWER / "src" / "ui" / "icons.js").read_text(encoding="utf-8")

    assert "chevron:" in icons, "the icon set has no chevron for these marks to share"
    assert not re.search(r"border-right:\s*1\.5px solid currentColor", styles), (
        "a chevron is drawn again from a rotated border, which is a second definition of "
        "a glyph the icon set already has -- and the one a reader reported"
    )
    # AT THE SITE, NOT IN THE FILE. Asking whether the file mentions the icon stayed green
    # against removing it from the rail's collapse button (the restore strip still had it)
    # and from the worklist's expander (`makeSectionsFoldable` still had it). A glyph is
    # shared only where it is actually used.
    for source, needle, where in (
        (rails, "strip.innerHTML = `<span aria-hidden=\"true\">${icon('chevron')}",
         "the strip that stands where a hidden rail was"),
        (rails, "toggle.innerHTML = `<span aria-hidden=\"true\">${icon('chevron')}",
         "the rail's collapse control"),
        (app, "class=\"wl-expand-mark\" aria-hidden=\"true\">${icon('chevron')}",
         "the worklist's study expander"),
        (meas, "class=\"mg-mark\" aria-hidden=\"true\">${icon('chevron')}",
         "the measurement group headings"),
    ):
        assert needle in source, f"{where} does not draw the set's chevron"

    # The open/closed states are a quarter turn, because the set's chevron points down.
    for selector in (".wl-expand-mark", ".mg-mark", ".rail-collapse-right span"):
        assert selector in styles, f"{selector} has no rule"
    # ANCHORED AT THE LINE START: without it the RTL rule, whose selector CONTAINS
    # this one, satisfied the search while the rule itself said something else.
    assert re.search(r"^\.wl-expand\[aria-expanded=\"true\"\] \.wl-expand-mark \{ transform: none", styles, re.M), (
        "the expanded state does not put the chevron back to pointing down"
    )
    assert re.search(r"rotate\(-90deg\)", styles) and re.search(r"rotate\(90deg\)", styles), (
        "the quarter turns are gone; a rotated square's eighth turn is not the same glyph"
    )
def test_the_measurements_heading_is_declared_once_and_does_not_dim_its_control() -> None:
    """Three blocks for one selector, 1400 lines apart, and a property that outlived both.

    `.meas-head` was declared at three places in this file. The second rewrote every
    property the first set -- margin, font, colour, case, tracking -- except `opacity:
    .85`, which nothing reset. The heading holds the grouping `<select>`, so that opacity
    multiplied a CONTROL.

    MEASURED against the rail's background, with the disabled controls excluded because
    WCAG 1.4.11 exempts inactive components:

        .meas-group border, opaque              1.38:1
        .meas-group border, under the heading   1.30:1     (required: 3)
        after: `--line-ctl`, heading opacity 1  3.20:1

    The token was already here: `--line` is the palette's "borders that separate" and
    `--line-ctl` its "borders that identify something you can operate", raised to clear 3:1
    on every chrome ground. This control asked for the first.

    `.meas-group-head` IS LEFT ALONE, and the probe that found this named it too: its only
    border is `border-top`, a RULE BETWEEN GROUPS rather than the outline of a button --
    the button is identified by its text and its chevron. Repainting a separator with the
    control token would be the same mistake in the other direction.

    AND TWO RULES THAT MATCHED NOTHING went with it: `.hud-tr .who` and `.hud-tr .id`.
    Verified on the live tree -- `querySelectorAll('.hud-tr .who, .hud-tr .id')` is empty --
    and no markup here puts either class in a panel's top-right corner; the patient's name
    is in the header banner and the panel's label corner is `.hud-tl`.
    """
    styles = (VIEWER / "styles.css").read_text(encoding="utf-8")

    # ONE declaration of the selector. Anchored at the line start so `.meas-head:first-child`
    # and `.meas-head .muted` are not counted as declarations of it.
    blocks = re.findall(r"^\.meas-head \{", styles, re.M)
    assert len(blocks) == 1, (
        f"`.meas-head` is declared {len(blocks)} times; three of them 1400 lines apart is "
        f"how `opacity: .85` survived two rewrites and dimmed a control"
    )
    head = re.search(r"^\.meas-head \{(.*?)\}", styles, re.S | re.M)
    assert head and "opacity" not in head.group(1), (
        "the heading sets an opacity again, and it holds the grouping control"
    )

    group = re.search(r"^\.meas-group \{(.*?)\}", styles, re.S | re.M)
    assert group, "no .meas-group rule"
    assert "var(--line-ctl)" in group.group(1), (
        "the grouping control's boundary is drawn with the token for borders that SEPARATE, "
        "measured at 1.38:1 where WCAG 1.4.11 asks for 3"
    )

    for dead in (".hud-tr .who {", ".hud-tr .id {"):
        assert dead not in styles, (
            f"`{dead[:-2]}` is back, and nothing in this repository carries that class "
            f"inside a panel's top-right corner"
        )
def test_a_study_date_is_rendered_by_one_instance() -> None:
    """One study, one screen, two formats -- and nothing on screen said they were the same.

    MEASURED with a study open:

        worklist           13-Mar-2022 16:03      `studyDate` in app.js
        header banner      02-Jun-2016 16:19      `studyDate`
        study rail         02-Jun-2016 16:19      `studyDate`
        study panel        2016-06-02             `isoDate`, private to that module

    Neither form is ambiguous alone: a named month cannot be read month-first, and ISO 8601
    is unambiguous by definition. What a reader comparing two rails of one screen had to do
    was translate one into the other before they could see both named the same study.

    THE NAMED MONTH WINS BY ARRIVAL, not by taste: three of the four places already printed
    it, the worklist among them, so it is the form a reader comes in with.

    THE SHARED THING MOVED DOWN, not the panel up. `src/ui/*.js` may not import the shell --
    this file fails any that does -- so `studyDate` lives in `src/dicom/dates.js` and both
    the shell and the panel import it. A helper duplicated into a UI module is how the two
    formats happened in the first place.
    """
    dates = VIEWER / "src" / "dicom" / "dates.js"
    assert dates.exists(), (
        "there is no shared date renderer, so each surface formats (0008,0020) its own way"
    )
    source = dates.read_text(encoding="utf-8")
    assert "export function studyDate(" in source, "dates.js exports no studyDate"

    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    panel = _code((VIEWER / "src" / "ui" / "study-panel.js").read_text(encoding="utf-8"))

    for text, who in ((app, "the shell"), (panel, "the study panel")):
        assert "dicom/dates.js" in text, f"{who} does not use the shared date renderer"

    # No second definition anywhere in the viewer's own sources.
    others = []
    for path in sorted((VIEWER / "src").rglob("*.js")):
        if path.name == "dates.js":
            continue
        body = _code(path.read_text(encoding="utf-8"))
        if re.search(r"function (isoDate|studyDate)\s*\(", body):
            others.append(path.name)
    if re.search(r"^function (isoDate|studyDate)\s*\(", app, re.M):
        others.append("app.js")
    assert not others, (
        f"a second date renderer lives in {others}; that is how one study came to read "
        f"`02-Jun-2016` in the banner and `2016-06-02` in the panel beside it"
    )
def test_the_patient_is_named_where_it_answers_a_question_and_not_four_more_times() -> None:
    """Six copies of one name on one screen, four of which could never differ.

    MEASURED before this change, with one study open in a 2x2:

        patient name    6   header banner + `Study` panel + FOUR panel labels
        description     3   banner, left rail, `Study` panel
        study date      3   and in two formats, which is fixed separately
        modality        2, series count 2

    THE FOUR PANEL COPIES WERE IDENTICAL BY CONSTRUCTION. This viewer opens ONE study into
    every panel, so the four labels always named the same person. A repetition that cannot
    vary distinguishes nothing; it only takes the corner a reader looks at for the series.

    WHERE IT IS NOW, and why two places rather than one: the header banner answers "whose
    study is open" and is always on screen at eye level; the `Study` panel in the right rail
    answers "which study exactly", with the id, the accession and the series count. The
    left rail's own study block -- date, modality, description, count -- was a third
    answer, a section titled `Study` facing another section titled `Study` across the
    picture. It is gone; that rail is the series list.

    AN EXPORT IS UNAFFECTED, which is the part worth checking before removing a patient
    identifier from an image: `capturePanel` builds its caption from `meta`, so a saved PNG
    still carries the name, the id, the date and the MOS-SAFE-001 statement.

    AND THE EXPORT STOPPED READING A RAIL. The capture's caption and file name were taken
    from `el.railDate.textContent` and `el.railDesc.textContent` -- the file name of a
    clinical artefact depending on what a rail happened to have drawn, placeholder text
    included. Both now come from the series rows the rail was filled from.
    """
    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    markup = (VIEWER / "index.html").read_text(encoding="utf-8")
    styles = (VIEWER / "styles.css").read_text(encoding="utf-8")

    label = re.search(r"panel\.label = (.*?);", app, re.S)
    assert label, "no panel label is built"
    assert "00100010" not in label.group(1), (
        "the panel label carries the patient's name again -- four identical copies in a "
        "2x2, in the corner the reader reads the series from"
    )

    assert 'data-section="study"' not in markup, (
        "the left rail has a study block again, facing the `Study` panel across the picture "
        "with the same tags in it"
    )
    assert "rail-date" not in markup and "rail-desc" not in markup, (
        "the rail's study fields are back in the markup"
    )
    assert not re.search(r"^\.rail-study", styles, re.M), (
        "the rules for a block this surface no longer has are back in the stylesheet"
    )

    # The export reads the rows, not a rail.
    capture = re.search(r"const meta = \{(.*?)\};", app, re.S)
    assert capture, "no capture metadata"
    assert "el.rail" not in capture.group(1), (
        "an exported picture's caption is read out of a rail's DOM again, so it carries "
        "whatever that rail had drawn -- placeholder text included"
    )
    assert "studyDate(dv(study" in capture.group(1), (
        "the capture's study date does not come from the series rows"
    )
    assert "el.railDate" not in app and "el.railDesc" not in app, (
        "something still reads the removed rail's elements"
    )
def test_a_lost_graphics_context_takes_the_caption_with_it_and_gives_it_back() -> None:
    """The browser can take the picture away, and nothing here was listening.

    FOUND BY ACCIDENT, ON THE RUNNING SURFACE. `gl.isContextLost()` came back true on one
    panel while its HUD went on naming the series, the patient, the window, the slice and
    the orientation, with the scale bar still drawn beneath them and a note overlay on top.
    There was no anatomy. No notice, no refusal, nothing in the console the reader would
    see. The console did hold `ERR_INSUFFICIENT_RESOURCES`, which is how the context went:
    this viewer opens ONE WebGL context PER PANEL -- four in a 2x2 -- and `setLayout`
    builds new ones on every layout change.

    A LOST CONTEXT IS ORDINARY. A driver reset, a laptop switching GPUs, an OS reclaiming
    resources, a tab backgrounded by some drivers, or simply too many live contexts. It is
    not an error in this code and it cannot be prevented from here; what can be prevented
    is a caption that outlives its picture, which `draw`'s own comment calls "the one
    failure mode a viewer must not have".

    WHAT IS ASSERTED HERE, all of it verified live with `WEBGL_lose_context`:
      - the loss is heard, and `preventDefault()` is called, without which the event's
        default action makes the loss permanent and `webglcontextrestored` never fires;
      - the HUD is blanked through the same `blankHud` the refusal path uses;
      - a refusal is written where the picture was, and a notice is raised;
      - nothing draws while there is no context, because the wheel and the keyboard go on
        calling `draw` -- measured, every one of those threw;
      - the restore rebuilds the viewport, because shaders, textures and buffers belonged
        to the context that went;
      - and it carries the window across, because a fresh `Viewport` has none and `draw`
        reads one: measured, `TypeError: Cannot read properties of undefined (reading
        'center')` on the first frame after a restore, from this very handler before the
        list was carried.
    """
    app = (VIEWER / "app.js").read_text(encoding="utf-8")

    lost = re.search(r"addEventListener\('webglcontextlost'.*?\n  \}\);", app, re.S)
    assert lost, "nothing listens for the loss of a panel's graphics context"
    body = lost.group(0)
    assert "e.preventDefault()" in body, (
        "without `preventDefault` the loss is permanent and the context is never restored"
    )
    assert "blankHud(panel)" in body, (
        "the caption outlives the picture: the series, the window, the slice and the "
        "orientation letters go on describing an image that is not on screen"
    )
    assert "panel.contextLost = true" in body, (
        "nothing stops `draw` while there is no context, and the wheel keeps calling it"
    )
    assert "panel.hud.empty" in body and "notice(" in body, (
        "the panel goes blank without saying why"
    )

    restored = re.search(r"addEventListener\('webglcontextrestored'.*?\n  \}\);", app, re.S)
    assert restored, "a restored context is never taken up; the panel stays blank for good"
    back = restored.group(0)
    assert "new Viewport(canvas)" in back, (
        "the old viewport's shaders and textures belonged to the context that went"
    )
    assert "setWindow(acrossTheLoss.window.center" in back, (
        "the window is not carried across the loss, and a fresh viewport has none: `draw` "
        "reads `.center` on the first frame and throws"
    )
    assert "panel.contextLost = false" in back, "the panel never starts drawing again"

    # `draw` has to honour the flag, or setting it is decoration.
    draw = re.search(r"\nfunction draw\(p\) \{(.*?)\n\}", app, re.S)
    assert draw and "if (p.contextLost) return;" in draw.group(1), (
        "`draw` ignores the flag, so every wheel tick between the loss and the restore "
        "reaches a dead context"
    )
    # THE PLACE, NOT ONLY THE PRESENCE. This assertion passed while the line that hides the
    # panel's message ran FIRST: the next redraw of a panel whose context had gone -- a
    # wheel notch, a window resize through `drawAll`, a measurement added, a cine tick 60ms
    # later -- took down the only sentence saying why the panel was blank and then returned
    # without drawing. A black rectangle with no picture, no caption and no reason.
    # WITHOUT THE PROSE: `_code` exists for exactly this, and the comment that explains
    # this defect quotes the line it is about, which put the quote before the code.
    body = _code(draw.group(1))
    assert body.index("if (p.contextLost) return;") < body.index("p.hud.empty.hidden = true"), (
        "`draw` hides the panel's own explanation before it honours the lost-context flag, "
        "so the first redraw after a loss erases the message the loss handler wrote"
    )
def test_a_panel_that_leaves_the_grid_gives_its_graphics_context_back() -> None:
    """The layout button was manufacturing the failure the handler above reports.

    A WEBGL CONTEXT IS NOT GARBAGE THE WAY AN OBJECT IS. `setLayout` rebuilds every panel
    -- it must, because a context is bound to its canvas -- and dropped the old ones with
    `el.grid.innerHTML = ''`. That releases a context only when the canvas is COLLECTED,
    which is neither prompt nor promised. Meanwhile the browser caps how many it will keep
    alive: sixteen in Chrome. Past the cap it does not refuse the new context. It
    FORCE-LOSES an old one, and a forced loss fires `webglcontextlost` on whichever panel
    owned it.

    MEASURED on the running viewer, driving the layout buttons and nothing else -- no
    study, no series, no network, `getContext` hooked and contexts counted by identity:

        cycles of 2x2 <-> 1x1   contexts created   alive   force-lost   canvases on screen
        3                       16                 16      0            1
        4                       21                 16      5            1
        6                       31                 16      15           1

    Thirty-one contexts for one canvas, the browser killing five per cycle to stay under
    its ceiling. Each held a linked program, a vertex buffer and two textures, the image
    texture being a whole 512x512 R16I frame -- which is what `ERR_INSUFFICIENT_RESOURCES`
    in the console of the original report was made of.

    AFTER, same six cycles, same probe, and again with a real series loaded:

        cycles   created   alive   released deliberately   canvases on screen
        6        31        1       30                      1
        6 (with a loaded series)  33        1       32     1

    `alive` is now the number on screen, which is the only defensible number.

    WHY THE RETIREMENT FLAG, and why it is checked BEFORE `preventDefault`. Releasing a
    context fires `webglcontextlost` like any other loss, asynchronously, after the node
    has left the grid. Unguarded, a 2x2 -> 1x1 raises four alarms about a picture nobody
    lost -- and calls `preventDefault`, which asks the browser to keep the context
    RESTORABLE. That is the precise opposite of handing it back, and it would have made
    this fix do nothing while reading as though it worked.
    """
    app = _code((VIEWER / "app.js").read_text(encoding="utf-8"))
    render = _code((VIEWER / "src" / "render" / "viewport.js").read_text(encoding="utf-8"))

    # 1. The viewport can give its context back at all.
    dispose = re.search(r"\n  dispose\(\) \{(.*?)\n  \}", render, re.S)
    assert dispose, "`Viewport` has no `dispose`, so a panel's context can only be dropped"
    released = dispose.group(1)
    assert "WEBGL_lose_context" in released and "loseContext()" in released, (
        "`Viewport.dispose` does not call `WEBGL_lose_context.loseContext()`, which is the "
        "only way to hand a context back on purpose -- deleting the textures and the "
        "program frees what the context HELD and not the context itself"
    )
    for held in ("deleteTexture", "deleteBuffer", "deleteProgram"):
        assert held in released, f"`Viewport.dispose` never calls `{held}`"

    # 2. `setLayout` uses it, and uses it before the nodes go.
    layout = app[app.index("function setLayout("):]
    layout = layout[: layout.index("\nfunction ")]
    assert "el.grid.innerHTML = ''" in layout, "setLayout no longer clears the grid; re-read this test"
    assert layout.index("viewport.dispose()") < layout.index("el.grid.innerHTML = ''"), (
        "`setLayout` drops the panel nodes without disposing their viewports first, so "
        "every layout change leaks one WebGL context per panel until the browser starts "
        "force-losing them"
    )
    assert "p.retired = true" in layout, (
        "`setLayout` disposes without retiring, so each deliberate release arrives at the "
        "`webglcontextlost` handler as news"
    )
    assert layout.index("p.retired = true") < layout.index("viewport.dispose()"), (
        "the retirement flag is set after the dispose that fires the event it guards"
    )

    # 3. The handler honours it, and honours it first.
    lost = app[app.index("addEventListener('webglcontextlost'"):]
    lost = lost[: lost.index("addEventListener('webglcontextrestored'")]
    assert "if (panel.retired) return;" in lost, (
        "the lost-context handler does not check for a retired panel, so a plain layout "
        "change raises one alarm per outgoing panel about a picture nobody lost"
    )
    assert lost.index("if (panel.retired) return;") < lost.index("e.preventDefault();"), (
        "the handler calls `preventDefault()` before deciding whether the panel was "
        "retired. `preventDefault` asks the browser to keep the context RESTORABLE, so on "
        "a deliberate release it undoes the release -- and the leak survives a fix that "
        "reads as though it worked"
    )


def test_a_narrow_panel_does_not_put_the_readout_on_the_laterality_marker() -> None:
    """The bottom band holds a centre column and a right-hand readout, and on a narrow
    panel it holds neither of them properly.

    MEASURED at 1024x768 in a 2x2, with each panel 283x285 (panel-relative coordinates):

        .hud-br  "axial 17 / 32 · 5.20 mm · 100%"   [156, 30, 113, 30]  -- after this fix
        before:                                     [ 52,105, 130,  30]
        P        the posterior laterality marker     [136,252,  10, 23]  8x23 of overlap
        .hud.scale "50 mm"                           [112,224,  59, 27]  20x4 of overlap

    The readout wraps to its `max-width: 46%`, the box grows to the full 130px and its left
    edge reaches the panel's midline -- where the scale bar and the marker live. Squeezing
    it instead is not available: clearing the widest scale bar leaves `0.375W - 40`, which
    is 66px at this width, a four-line readout written over the anatomy.

    WHAT IT COSTS. `styles.css` says of those markers that they are "the only marks on
    screen that distinguish the patient's left from their right". A slice counter written
    across one of them is a laterality mark a reader has to decipher.

    ASKED OF THE PANEL, NOT THE WINDOW. Whether the readout wraps depends on the PANEL: at
    1280 in a 2x2 it is 411px and the line fits; at 1024 it is 283px and it does not. The
    same 1024px window in 1x1 has a 788px panel and no collision at all. A media query
    knows the window and nothing about the layout, the rails' widths or a splitter the
    reader has dragged -- so this is a container query, and `.vp` is the container.
    """
    styles = (VIEWER / "styles.css").read_text(encoding="utf-8")

    assert ".vp { container-type: inline-size; }" in styles, (
        "`.vp` is not a query container, so the HUD can only respond to the window -- and "
        "the window does not know how wide the panel ended up"
    )
    block = re.search(r"@container \(max-width: (\d+)px\) \{(.*?)\n\}", styles, re.S)
    assert block, "no container query for the narrow panel"
    threshold = int(block.group(1))
    # 283px panels collide; 411px ones do not. The threshold has to separate them.
    assert 300 <= threshold <= 400, (
        f"the threshold is {threshold}px: a 283px panel must be inside it and a 411px "
        f"panel outside, because those are the two that were measured"
    )
    body = block.group(2)
    assert "top:" in body and "bottom: auto" in body, (
        "the readout still hangs off the bottom of a narrow panel, where the scale bar and "
        "the laterality marker are"
    )
    assert re.search(r"max-width:\s*40%", body), (
        "the readout keeps its 46% cap on a narrow panel; at 283px that puts its left edge "
        "at 147, which is where the top-centre `A` marker ends"
    )
def test_a_refused_frame_takes_its_caption_with_it() -> None:
    """The picture went black, the caption stayed, and one of them was a claim.

    REPRODUCED ON THE RUNNING SURFACE. A 2x2 of a four-series MR; the fourth panel made
    active and given a 20 mm slab, so its label corner carries the standing `PROJECTION`
    chip; then a two-series study is opened, and `openStudy` empties every panel the new
    study does not fill. Measured on the cleared panel:

        .empty      "This study has no further image series for this panel."
        .hud-tl     ""                     <- emptied
        .hud-tl.projecting::after           PROJECTION   <- still there

    THE CHIP IS A CLASS, NOT TEXT. `.hud-tl.projecting::after` draws it from the element,
    so `p.hud.tl.innerHTML = ''` never touched it. Shown red against exactly this: with the
    one line that removes the class taken out, the chip came back on the cleared panel;
    with it in, the panel is blank.

    AND THE OTHER PATH WAS WORSE. `draw`'s refusal handler -- the one whose own comment says
    "A REFUSAL MUST NOT LEAVE THE LAST PICTURE ON SCREEN" -- cleared the frame and the
    viewport and nothing else: the series name, the window, the slice counter, the
    orientation letters, the scale bar and the link badge all stayed, describing a frame
    that had just been refused. A caption is the other half of a picture.

    ONE INSTANCE FOR BOTH, because they drifted once already: `clearPanel` emptied four
    corners by hand and the refusal emptied none, and neither removed the chip.
    """
    app = (VIEWER / "app.js").read_text(encoding="utf-8")

    body = re.search(r"function blankHud\(p\) \{(.*?)\n\}", app, re.S)
    assert body, "no blankHud: the two paths that blank a panel have no shared definition"
    b = body.group(1)
    for needed, why in (
        ("classList.remove('projecting')", "the PROJECTION chip is a class and survives an emptied corner"),
        ("p.hud.tr.textContent = ''", "the window and level stay on a panel with no frame"),
        ("p.hud.br.textContent = ''", "the slice counter stays"),
        ("p.hud.scale.hidden = true", "the scale bar stays, measuring nothing"),
        ("hideLink(p)", "the correspondence badge stays, about a frame that is gone -- "
                        "and with it `_linkMode`, which is what lets the crosshair's "
                        "absence be suppressed by a badge nobody can see"),
        ("p.hud.edges[side].textContent = ''", "the laterality letters stay"),
        ("p.annotations.clear()", "the measurements stay, drawn over nothing"),
        ("p.canvas.setAttribute('aria-label'",
         "a screen reader goes on announcing the series, the plane and the slice of a "
         "picture that has been taken down"),
        ("el.footTech.textContent = ''",
         "the footer's technical line describes the active panel, and `renderFooterTech` "
         "is at the END of `draw` -- which a refusal and a lost context both return "
         "before reaching"),
    ):
        assert needed in b, f"blankHud does not take back: {why}"

    clear = re.search(r"function clearPanel\(p, why\) \{(.*?)\n\}", app, re.S)
    assert clear and "blankHud(p)" in clear.group(1), (
        "clearPanel blanks the HUD by hand again, which is how it came to miss the chip"
    )
    # THE CATCH AROUND THE RESLICE, not the first `catch` in the file: this gate
    # matched the one around the presets fetch and failed for the wrong reason.
    refusal = re.search(r"frame = reslice\(.*?catch \(err\) \{(.*?)\n  \}", app, re.S)
    assert refusal and "blankHud(p)" in refusal.group(1), (
        "the refusal path clears the frame and leaves the caption: the panel then names a "
        "series it is not showing"
    )
def test_the_exported_capture_carries_the_whole_statement() -> None:
    """`fillText` neither wraps nor clips, and the statement is wider than a small panel.

    MEASURED ON THE PIXELS OF A REAL EXPORT, not on arithmetic. A 2x2 at a 1024px window
    gives a 283px panel, so `capturePanel` composes a 283px-wide canvas. The MOS-SAFE-001
    statement at `600 11px system-ui` is 463px:

        room for text          283 - 2*14 = 255px
        characters exported    44 of 77
        what did not           "NOT FOR CLINICAL DECISION MAKING."
        ink                    reached x=282 on a 283px canvas, i.e. ran off it

    The requirement is that the statement appears VERBATIM, and the half that went off the
    edge is the half about clinical decisions. `MOS-UI-008` is why it is on the picture at
    all: an exported image leaves this surface the moment it is saved.

    AFTER: the same panel exports a 283x427 canvas -- the caption band grew by 71px -- with
    the statement on two lines and ink reaching x=250 inside a 255px room.

    THE CAPTION LINES TOO, and they were the quieter half of the same defect: a patient
    name, a protocol description or a window readout ran off the same edge with nothing
    saying so. They are not a requirement, which is why nobody had noticed.

    WRAPPED, NOT SHRUNK AND NOT CLIPPED. Shrinking the type to fit a 283px panel puts the
    statement at about 6px, which is verbatim and unreadable; clipping loses text that must
    be whole. The band takes the rows it needs and the picture above it is untouched.
    """
    export = (VIEWER / "src" / "ui" / "export.js").read_text(encoding="utf-8")

    assert "function wrapToWidth(" in export, (
        "nothing breaks a caption line to the width of the picture, so `fillText` draws "
        "past the canvas and the rest is simply not in the file"
    )
    # The statement is wrapped and drawn row by row, not in one call.
    assert re.search(r"statementLines = wrapToWidth\(", export), (
        "the statement is still drawn in one `fillText`, which on a narrow capture exports "
        "44 of its 77 characters"
    )
    assert not re.search(r"ctx\.fillText\(STATEMENT", export), (
        "the statement is drawn whole again; on a 283px capture that is 208px of it "
        "outside the canvas"
    )
    # The band's height comes from the rows that will be drawn, not the strings handed in.
    height = re.search(r"const captionHeight = (.*?);", export, re.S)
    assert height, "no captionHeight"
    assert "captionRows" in height.group(1) and "statementLines.length" in height.group(1), (
        "the caption band is still sized from the NUMBER OF STRINGS, so a string that "
        "wraps is drawn outside the band it was given"
    )
    # A word with no spaces in it -- a UID, a protocol name -- must break too.
    wrap = re.search(r"function wrapToWidth\(.*?\n\}", export, re.S)
    # THE PUSH, NOT THE MEASURE.  also appears in the loop that
    # finds the cut, so asking for the substring alone stayed green against a break
    # that stopped pushing the piece.
    assert wrap and "out.push(rest.slice(0, cut));" in wrap.group(0), (
        "wrapping breaks on spaces only, so a long identifier with none goes back over "
        "the edge"
    )

def test_the_link_is_gated_on_the_plane_being_compared_not_on_the_acquisition() -> None:
    """The gate ran on one axis and the comparison on another.

    `positionLinkable` compared `source.frames[0].normal` against the target's -- the axis
    the SLICES advance along -- while `followIndex` then compared `planeOrdinate` values,
    which are projections on the axis the DISPLAYED PLANE advances along. For an axial the
    two vectors are equal and the gate was sound. For a reconstruction they are not: a
    coronal's normal is `cross(ex, down)` and rotates with the in-plane cosines, so a pair
    of series differing only by an in-plane rotation passes a gate reading 0.000 degrees
    and is then compared along two axes up to 90 degrees apart.

    MEASURED, against the demo corpus's source series and the same physical volume restated
    feet-first -- IOP [-1,0,0,0,-1,0], origin at the opposite corner, one FrameOfReferenceUID:

        acquired normals   [0,0,1] and [0,0,1]      dihedral 0.000 deg -> allowed
        coronal normals    [0,1,0] and [0,-1,0]     antiparallel

        coronal 100 -> 100, reported 0.000 mm, badge `position-linked` kind `exact`
        true patient y:  -41.65 mm and +41.65 mm  ->  83.30 mm apart

    `describeLink` printed no distance clause at all, because 0.000 is under its 0.01 mm
    threshold: the reader got the strongest assurance the surface can give on the most wrong
    answer it can produce. The AXIAL link between the very same pair is correct, which is
    what makes it hard to see.
    """
    code = _code(_js("image", "sync.js"))
    body = code[code.index("export function positionLinkable("):]
    body = body[: body.index("\n}")]

    # NO DEFAULT ON `plane`. The obvious default is the axial, and that is the one value
    # which is right for the acquired plane and wrong for every reconstruction -- so a
    # caller that forgot to say which plane it meant would get a confident, plausible answer
    # to a question it did not ask, which is the defect this parameter exists to fix.
    assert "export function positionLinkable(source, target, plane) {" in code, (
        "positionLinkable takes a default plane, so an omitted argument is answered rather "
        "than refused"
    )

    assert "planeNormal(source, plane)" in body and "planeNormal(target, plane)" in body, (
        "the gate is back on the acquired slice normals, which is not the axis the "
        "ordinates below it are measured along"
    )
    assert "frames[0].normal" not in body, (
        "the acquired normal is still what the dihedral is taken on"
    )
    assert "export function planeNormal" in _js("image", "mpr.js"), (
        "mpr.js no longer exposes the normal of the displayed plane, so sync.js cannot gate "
        "on the axis it compares"
    )

    # AND THE SIGN, which is the other half of it. `dihedralDegrees` takes |cos| so that an
    # antiparallel pair reads 0 degrees -- correct, the planes ARE parallel -- but every
    # ordinate downstream is a SIGNED projection and the same point projects to opposite
    # numbers along opposite normals. Feet-first against head-first is exactly that pair.
    assert re.search(r"sign: dot < 0 \? -1 : 1", body), (
        "the link no longer reports which direction the target measures the axis in, so an "
        "antiparallel pair is compared as though the two agreed"
    )
    follow = code[code.index("export function followIndex("):]
    follow = follow[: follow.index("\n}")]
    # ONE SIGNED ORDINATE FOR BOTH BRANCHES. The acquired branch read `check.sign * depth`
    # and the reconstructed one `check.sign * sourceOrdinate`; they are the same expression
    # over different sources of the ordinate, and they are one line now.
    assert "check.sign * sourceOrdinate" in follow, (
        "the ordinate is not signed before it is searched for, so a series whose plane "
        "normal runs the other way matches at the mirrored end of the volume"
    )
    assert ".depth" in follow, (
        "the acquired plane's ordinate no longer comes from the frame's own precomputed "
        "depth, which is the projection the loader already did"
    )
    # `-1 * null` is 0, and 0 is a position. The guard below it tests for null.
    assert "sourceOrdinate === null ? null :" in follow, (
        "the sign is applied to the ordinate before it is known to exist, so an absent "
        "ordinate becomes a real position of zero"
    )
    assert "positionLinkable(source, target, sourcePlane)" in follow, (
        "followIndex gates on a fixed plane rather than the one the panels are showing"
    )


def test_a_clamp_to_the_end_of_a_series_is_not_reported_as_a_correspondence() -> None:
    """`nearestByPosition` predicted this failure in its own docstring, and had it.

    "a caller that ignores the distance will clamp to slice 0 and call it synchronised" --
    and `followIndex` was that caller. A nearest-slice search always returns an index,
    including for a depth outside the target series entirely, where it returns the end slice
    and a large distance. Every such result was reported as `LINK.POSITION`, which
    `linkBadge` renders as a green chip reading `position-linked`, kind `exact`.

    MEASURED, against the demo corpus's two studies -- 64 slices from z=0 and 40 from z=7,
    both at 2 mm: source slice 63 is at z=126, the companion ends at z=85, and the two
    panels were badged `position-linked / exact` 41 mm apart. The distance was computed and
    correct; it reached the reader only through `title`, which is to say on hover, over a
    chip that had already told them the link was exact.
    """
    code = _code(_js("image", "sync.js"))
    assert "CLAMPED: 'clamped'" in code, "there is no mode for a clamp, so it reads as a link"

    body = code[code.index("function positionResult("):]
    body = body[: body.index("\n}")]
    assert "distanceMm > reach + CELL_EPS" in body, (
        "the residual is not tested against the slice's own cell, so an out-of-range depth "
        "is reported as a correspondence"
    )

    # THE CELL IS DERIVED FROM THE TARGET'S OWN NEIGHBOURS, not from a threshold: a 0.5 mm
    # series and a 5 mm series do not agree on what "near" is, and an unevenly spaced
    # acquisition has no single pitch to compare against.
    cell = code[code.index("function halfCellMm("):]
    cell = cell[: cell.index("\n}")]
    assert "planeOrdinate(stack, plane, index - 1)" in cell, cell[:200]
    assert "planeOrdinate(stack, plane, index + 1)" in cell, cell[:200]
    # The LARGER of the two: an interior index of an uneven series may legitimately sit up
    # to half the wider gap from the depth that chose it. `Math.min` refuses a
    # correspondence that genuinely holds -- measured, on a target with one 12 mm gap among
    # 2 mm pitches, a depth 5 mm inside that gap.
    assert "Math.max(...gaps) / 2" in cell, (
        "the cell is taken from the narrower neighbouring gap, so a depth inside a wide gap "
        "of an unevenly spaced series is called out-of-range when the series does cover it"
    )

    # AND THE BADGE, which is the whole point: the tooltip always carried the distance.
    badge = code[code.index("export function linkBadge("):]
    badge = badge[: badge.index("\n}")]
    assert re.search(r"LINK\.CLAMPED\) return \{ text: '[^']+', kind: 'weak' \}", badge), (
        "the clamp is badged with the same `exact` chip as a true correspondence, so the "
        "one thing the reader actually sees still overstates it"
    )


def test_the_unlinkable_pair_is_told_which_of_the_two_reasons_applies() -> None:
    """One sentence used to cover both, and it was false for one of them.

    An axial and a coronal cannot link by slice because neither IS a slice of the other --
    that is a fact about the question, not about the data, and `reference.js` already draws
    the answer that does exist. Two coronals that cannot link have a different problem: a
    frame of reference they do not share, or planes too far apart in angle. A reader who is
    told the wrong one goes looking for the wrong fix.
    """
    code = _js("image", "sync.js")
    assert "a reconstructed plane has no patient-space slice position" not in code, (
        "the sentence that outlived its reason is still shown to readers"
    )
    assert "advance along different axes" in code, (
        "the cross-plane pair is not told why it cannot link"
    )
    assert "the reference line shows where" in code, (
        "the reader is told what does not work without being told what does"
    )
    # `positionLinkable`'s own reasons still reach the same-plane failures.
    body = _code(code)[_code(code).index("export function followIndex("):]
    body = body[: body.index("\n}")]
    assert "reason: check.reason" in body, (
        "a same-plane pair that cannot link is given the cross-plane sentence instead of "
        "the frame-of-reference or dihedral one that actually applies"
    )
