# SPDX-License-Identifier: Apache-2.0
"""The segmentation toggle must survive a series change.

Measured 2026-10-04: `loadDerived` attaches SEGs once per study open, but
`loadSeriesInto` nulls `panel.seg` with the old stack every time the reader clicks
another series -- and nothing re-attached it. The overlay toggle kept flipping
alpha onto a null seg: pressed, lit, dead. These gates pin the fix: the study's
SEG instances are cached, and the series-load path re-attaches before the first
draw of the new stack.

Spec: user-reported defect, UI pass 2026-10-04.
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SHELL = (ROOT / "app.js").read_text(encoding="utf-8")


def test_the_studys_seg_instances_are_cached_for_reattach() -> None:
    assert "const studySegInstances = new Map();" in SHELL
    assert "studySegInstances.set(study, instances);" in SHELL, (
        "loadDerived must keep the parsed SEG instances; retrieving them again on "
        "every series click would work but would bill the network for a reader's "
        "navigation"
    )


def test_a_series_change_reattaches_the_seg_before_the_first_draw() -> None:
    assert "function attachSegsToPanel(study, panel)" in SHELL
    assert "decodeSegmentation(inst, panel.stack)" in SHELL, (
        "re-attachment reuses the same alignment rule as the initial attach: seg.js "
        "decides by geometry, never by assuming the SEG belongs to the active panel"
    )
    # The call must sit on the FINAL stack assignment (the progressive one would
    # attach against a partial stack and misalign).
    final = SHELL.split("const stack = buildStack(instances);", 1)[-1]
    assert "attachSegsToPanel(study, panel);" in final.split("function ", 1)[0], (
        "the re-attach must run after the full stack is built, before the panel "
        "draws the new series"
    )


def test_reattachment_respects_the_placement_rules() -> None:
    assert "if (!decoded.planes.size) continue;" in SHELL, (
        "an empty placement is not an attachment, the same rule loadDerived applies"
    )
    # loadDerived itself must now read from the cache it fills, or the two paths
    # could disagree about which label map a panel holds.
    assert SHELL.count("studySegInstances.get(study)") >= 1
