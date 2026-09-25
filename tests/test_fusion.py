# SPDX-License-Identifier: Apache-2.0
"""Two acquisitions in one picture, and the three debts that buys.

WHY THIS RESAMPLES WHERE `seg.js` REFUSES TO. `decodeSegmentation` raises
`segmentation_geometry_mismatch` rather than resample, and its reason is written there:
"Resampling one onto the other would move boundaries without saying so." That is right
about a SEGMENTATION -- a mask is an assertion somebody authored, and moving it alters the
assertion.

A PET is not an assertion. It is a measured field, and PET and CT are never acquired on
one grid: this project's own synthetic pair is 128x128 at 2.8 mm against 320x448 at
0.7 mm. Refusing to resample would not be caution, it would be refusing the modality pair.

SO THE DEBT IS PAID IN STATEMENTS INSTEAD, and each of the three is tested here:

    which series is drawn through this one
    that its values are RESAMPLED
    that the numbers underneath are still the BASE series'

The third is the one that matters. Every ROI, every caliper and the cursor readout read
`frame.pixels`, which is the acquisition the panel is OF. An ROI drawn over the uptake
reports Hounsfield units of the CT beneath it, and nothing about the picture suggests it:
the bright thing the reader is measuring is the thing that is not being measured.

VERIFIED ARITHMETICALLY, IN THE BROWSER, against the shipped module rather than a copy.
Two source slices 10 mm apart holding 0/10/20/30 and 100/110/120/130, a target plane
exactly halfway between them at a finer pitch:

    corner (0,0) -> 50      corner (0,2) -> 60
    corner (2,0) -> 70      corner (2,2) -> 80      centre -> 65

every one exact. And the refusals: a different frame of reference refused by name; a
target 40 mm beyond the source's last slice sampled 0 of 4 pixels rather than clamping to
that slice's values; a target wider than the source sampled 4 of 16 and reported the other
12 as outside rather than as zero uptake.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

VIEWER = Path(__file__).resolve().parents[1]

_LINE_COMMENT = re.compile(r"^\s*//.*$", re.M)
_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.S)


def _code(text: str) -> str:
    return _LINE_COMMENT.sub("", _BLOCK_COMMENT.sub("", text))


def _js(*parts: str) -> str:
    return _code((VIEWER.joinpath("src", *parts)).read_text(encoding="utf-8"))


def _app() -> str:
    return _code((VIEWER / "app.js").read_text(encoding="utf-8"))


def _fn(src: str, name: str) -> str:
    start = src.index(f"function {name}(")
    rest = src[start:]
    end = rest.find("\nfunction ", 1)
    return rest if end < 0 else rest[:end]


def _shader() -> str:
    """The fragment source as the GPU gets it, comments and all."""
    raw = (VIEWER / "src" / "render" / "viewport.js").read_text(encoding="utf-8")
    start = raw.index("const FRAGMENT = `")
    end = raw.index("`;", start + 18)
    return raw[start + 18:end]


def test_a_second_acquisition_is_positioned_and_never_extrapolated() -> None:
    """Outside the overlaid volume there is no measurement, and none is drawn.

    CLAMPING IS THE FAILURE THIS GUARDS. A patient point beyond the last slice of the
    fused series has no value in it; returning the nearest one paints that slice's uptake
    across everything past it, which is an extrapolation that looks exactly like data --
    and on a PET, where the whole judgement is whether a bright thing is where a reader
    thinks it is, that is the worst available failure.
    """
    fusion = _js("image", "fusion.js")

    assert "export function resampleOnto(" in fusion, "there is no resampler"
    assert "function bracket(" in fusion and "function sampleFrame(" in fusion, (
        "the depth search and the in-plane sample are not separable, which is how one of "
        "them ends up clamping while the other does not"
    )

    bracket = _fn(fusion, "bracket")
    assert "if (depth < lo || depth > hi) return null;" in bracket, (
        "a depth outside the fused volume is not refused, so the end slice's values are "
        "painted across everything beyond it"
    )

    sample = _fn(fusion, "sampleFrame")
    assert "col > columns - 1 || row > rows - 1) return null;" in sample, (
        "a point beside the fused acquisition takes an edge value, which is a guess drawn "
        "as a fact"
    )

    # AND THE CALLER IS TOLD HOW MUCH WAS REACHED. "no uptake here" and "this series does
    # not reach here" look identical on screen; only a number tells them apart.
    assert "inside," in fusion and "total:" in fusion, (
        "the result does not report how much of the frame the fused series covered"
    )


def test_the_pair_must_assert_one_coordinate_system() -> None:
    """Drawing one series THROUGH another is a larger claim than linking them.

    `positionLinkable` refuses to link two series that do not share a frame of reference,
    and a fusion asserts more: not that the two scroll together, but that this pixel and
    that pixel are the same place in the patient.
    """
    fusion = _js("image", "fusion.js")
    assert "fusion_frame_of_reference" in fusion, (
        "two series with different frames of reference can be fused, so the surface will "
        "assert a correspondence the headers deny"
    )
    assert "a !== b" in fusion and "!a || !b" in fusion, (
        "an ABSENT frame of reference passes the check -- two series that both say "
        "nothing are not thereby the same coordinate system"
    )
    # THE IMPORT, not the name. `"DicomRefusal" in fusion` passed against
    # `const DicomRefusal = Error;` -- which is the whole defect, spelled so the assertion
    # still finds its word. The eighth time a gate here has been satisfied by a fragment
    # of the line it required, and the rule does not change: ask at the site.
    assert "import { DicomRefusal } from '../dicom/parse.js';" in fusion, (
        "the refusals are not this repository's refusal type, so nothing downstream can "
        "tell a refusal from a bug -- and `describe()` cannot render one for the reader"
    )
    assert fusion.count("new DicomRefusal(") >= 3, (
        "some path throws something other than a refusal"
    )


def test_the_overlay_fades_with_its_own_value() -> None:
    """A constant alpha is a coloured fog, not a fusion.

    Most of a PET is cold background INSIDE the patient. Painted at a fixed strength, that
    background covers the anatomy everywhere at once and the CT underneath becomes a haze
    with a bright spot in it -- so the reader loses exactly the thing the fusion was for,
    which is seeing the uptake against the structure it sits in.
    """
    shader = _shader()
    assert "u_fusionAlpha * t" in shader, (
        "the overlay is drawn at a constant alpha, so its cold background is painted over "
        "the anatomy at the same strength as its hottest voxel"
    )

    # AND IT IS DRAWN UNDER THE SEGMENTATION. Order is an argument: a segmentation is an
    # assertion somebody authored, a fusion is a second measurement, and hiding the
    # assertion under the measurement lets uptake cover a boundary being checked against.
    assert shader.index("u_hasFusion") < shader.index("if (u_hasOverlay)"), (
        "the fusion is composited over the segmentation, so uptake can hide the boundary "
        "a reader is comparing it against"
    )

    # NOT A RAINBOW. A rainbow map is not monotonic in lightness, so two different values
    # come out equally bright and a reader ordering them by eye orders them wrong.
    assert "vec3(t * 3.0, t * 3.0 - 1.0, t * 3.0 - 2.0)" in shader, (
        "the colour ramp is not the hot-metal one; a map that is not monotonic in "
        "lightness makes two different uptakes look equally bright"
    )


def test_the_shader_source_carries_no_backtick() -> None:
    """It is a template literal, and a backtick in a comment ends it.

    THIS IS NOT HYPOTHETICAL. Two backticks were written into shader comments while this
    feature was built -- around `image/fusion.js` and around a variable name -- and the
    whole page died with `SyntaxError: Unexpected identifier 'image'`, pointing twenty
    lines above them at a uniform declaration that was fine. The viewer did not render at
    all; not the panel, not the worklist, nothing.

    A gate rather than a note, because the failure is total, the message points elsewhere,
    and the habit that causes it -- quoting an identifier in prose -- is this repository's
    house style everywhere else.
    """
    assert "`" not in _shader(), (
        "the fragment shader source contains a backtick, which terminates the template "
        "literal it lives in: the module then fails to parse and the entire surface is "
        "blank, with a syntax error naming a line that is not the problem"
    )


def test_the_panel_says_what_is_drawn_through_it_and_what_it_is_not() -> None:
    """The third debt, and the one a reader gets hurt by.

    Every ROI, every caliper and the cursor readout read `frame.pixels` -- the acquisition
    the panel is OF. With a PET fused over a CT, an ROI drawn around the uptake reports
    HOUNSFIELD UNITS of the CT beneath it. The picture gives no hint: the bright thing the
    reader is measuring is precisely the thing that is not being measured.
    """
    app = _app()
    mark = _fn(app, "fusionMark")

    assert "fusion.resampled" in mark, (
        "the panel does not say the overlaid values are resampled, which is the statement "
        "`seg.js` pays for by refusing to resample at all"
    )
    assert "p.fusion.label" in mark and "p.fusion.modality" in mark, (
        "the overlaid series is not named, so a coloured picture arrives from nowhere"
    )
    assert "sampled.inside" in mark and "sampled.total" in mark, (
        "coverage is not shown, so 'no uptake here' and 'this series does not reach here' "
        "are the same picture"
    )
    # ASKED OF THE LINE, not of its exact spelling -- the same assertion in
    # `test_prior.py` pinned the whole statement and went red the moment this
    # caption was appended to it, which is a correct edit failed by a gate reading text.
    tl = re.search(r"p\.hud\.tl\.innerHTML = ([^;]+);", app)
    assert tl and "fusionMark(p, frame)" in tl.group(1), (
        "the mark is not drawn on the panel"
    )

    strings = json.loads((VIEWER / "i18n" / "ru.json").read_text(encoding="utf-8"))
    assert "measur" in strings["fusion.resampled"] or "измер" in strings["fusion.resampled"], (
        "the resampling note does not say the values cannot be measured, which is the "
        "half of it that matters"
    )


def test_an_ambiguous_fusion_is_refused_rather_than_resolved() -> None:
    """With two candidates, picking the first picks by sort order.

    Which measurement a reader is shown would then be decided by how the archive happened
    to return a series list -- and nothing on screen would say a choice had been made.
    """
    candidate = _fn(_app(), "fusionCandidate")
    assert "rows.length > 1" in candidate and "fusion_ambiguous" in candidate, (
        "more than one candidate is resolved silently"
    )
    assert "!== mine" in candidate, (
        "a series can be fused with another of its own modality -- laying a CT over its "
        "own reconstruction is a picture of nothing"
    )
    assert "s) => dv(s, '0008103E', '?')" in candidate, (
        "the refusal does not name the candidates, so the reader cannot act on it"
    )


def test_the_fusion_goes_when_the_frame_it_was_sampled_onto_goes() -> None:
    """A resampling is onto ONE frame. Keeping it past that frame is a caption for a
    picture that is not there -- the failure `blankHud` exists for, one layer down.
    """
    app = _app()
    assert "p.fusion = null;" in _fn(app, "clearPanel"), (
        "a cleared panel keeps a retrieved volume and a resampling of a frame that no "
        "longer exists"
    )
    assert "panel.fusion = null;" in _fn(app, "loadSeriesInto"), (
        "loading a new series keeps the previous fusion, so one acquisition's uptake is "
        "drawn through another's anatomy -- captioned correctly and wrong"
    )

    apply_ = _fn(app, "applyFusion")
    assert "p._fusionAt !== at" in apply_, (
        "the resampling is repeated on every draw, including a window drag that changes "
        "no geometry at all"
    )
    assert "p.plane}|${p.index}" in apply_, (
        "the cache key does not include the plane and the slice, so scrolling shows the "
        "first slice's uptake on every slice"
    )


def test_every_string_the_fusion_shows_exists_in_every_language() -> None:
    app = _app()
    asked = set(re.findall(r"t\(\s*'(fusion\.[A-Za-z]+|toggle\.fusion[A-Za-z]*)'", app))
    assert len(asked) >= 6, f"the scan found only {sorted(asked)}"

    folder = VIEWER / "i18n"
    tables = {
        p.stem: json.loads(p.read_text(encoding="utf-8"))
        for p in sorted(folder.glob("*.json"))
    }
    short = {code: sorted(asked - set(t)) for code, t in tables.items() if asked - set(t)}
    assert not short, (
        "the fusion speaks English in these languages -- including its refusals, which is "
        "a refusal a reader cannot read:\n"
        + "\n".join(f"    {code}: {', '.join(m)}" for code, m in sorted(short.items()))
    )
