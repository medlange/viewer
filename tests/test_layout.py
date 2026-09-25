# SPDX-License-Identifier: Apache-2.0
"""A case opens laid out, under an arrangement that has a name and can be taken over.

WHAT WAS THERE. Two `if`s in `openStudy`:

    if (images.length >= 4 && panels.length < 4) setLayout(2, 2);
    else if (images.length > 1 && panels.length < 2) setLayout(2, 1);

and three layout buttons -- 1x1, 1x2, 2x2. The arrangement had no name, so a reader could
not tell a rule from an accident, and it could only ever GROW the grid: a reader coming
from 3x3 on a multi-sequence MR opened a single-series CT into nine panels, eight of them
reading "this study has no further image series for this panel".

WHAT IT IS BUILT ON. `MOS-UI-209`: "A case MUST open with its series already laid out,
under a named hanging protocol ... The reader MUST NOT have to find the series, choose
between them, or construct the layout."

AND WHAT IT IS NOT BUILT UNDER, which matters as much. The rest of that requirement binds
the protocol to `a hangingProtocolModule from the extension package` named `in ohif.lock`,
and `MOS-UI-213` binds every requirement in §19.4.4 to "OHIF configuration or a module
contributed from the extension package". OHIF went at specification 0.4.0; there is no
extension package loaded and no `ohif.lock`. So §19.4.4 does not reach this surface -- the
same finding `src/image/mpr.js` records for `MOS-UI-211`, including the correction of its
own earlier header, which had claimed the requirement DID reach it.

The substance is built regardless, and `MOS-UI-209` stays UNMET as written: it selects a
protocol by an annotation campaign's `capability_id`, and the clinical viewer has no
campaign. Recording that is the point of this docstring; a green test file is not a claim
of compliance with a requirement addressed to something else.
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


def _app() -> str:
    return _code((VIEWER / "app.js").read_text(encoding="utf-8"))


def _fn(src: str, name: str) -> str:
    start = src.index(f"function {name}(")
    rest = src[start:]
    end = rest.find("\nfunction ", 1)
    return rest if end < 0 else rest[:end]


def _table() -> dict:
    return json.loads((VIEWER / "protocols.json").read_text(encoding="utf-8"))


def test_the_protocol_table_is_data_and_its_last_rule_cannot_fail() -> None:
    """A table whose last rule can fail arranges nothing and reports an arrangement.

    The fallback is DECLARED rather than left to the code, for the same reason
    `presets.json` carries the source of every window: a rule that exists only as an
    `||` in a function is a rule nobody can read, change or disagree with.
    """
    table = _table()
    protocols = table.get("protocols")
    assert isinstance(protocols, list) and len(protocols) >= 3, (
        "protocols.json carries no usable table"
    )

    for entry in protocols:
        for field in ("id", "name", "when", "layout"):
            assert field in entry, f"a protocol is missing `{field}`: {entry}"
        assert isinstance(entry["name"], str) and entry["name"].strip(), (
            f"protocol `{entry['id']}` has no name, and a nameless protocol is the thing "
            "this whole mechanism exists to stop being"
        )
        rows, cols = entry["layout"].get("rows"), entry["layout"].get("cols")
        assert isinstance(rows, int) and isinstance(cols, int) and rows >= 1 and cols >= 1, (
            f"protocol `{entry['id']}` declares no usable grid"
        )

    assert not protocols[-1]["when"], (
        "the last protocol has conditions, so a study meeting none of them is laid out by "
        "nothing while the surface goes on saying a protocol arranged it"
    )
    assert all(p["when"] for p in protocols[:-1]), (
        "a catch-all sits above a more specific rule, which can never then be reached"
    )

    ids = [p["id"] for p in protocols]
    assert len(ids) == len(set(ids)), f"duplicate protocol ids: {ids}"
    assert "prior-comparison" in ids, (
        "there is no protocol for a current study beside its prior, which is the one "
        "arrangement this surface makes FOR the reader rather than being asked for"
    )


def test_an_unknown_condition_does_not_match() -> None:
    """A typo in `when` must lose its own rule, not capture every study.

    `Object.entries(when).every(...)` over a lookup table is the shape that gets this
    right; the shape that gets it wrong is a switch with a `default: return true`, where a
    misspelled key becomes a condition that is always satisfied. The rule then sits above
    the real ones as a catch-all, and the first case to open is arranged by a mistake that
    looks exactly like a decision.
    """
    app = _app()
    choose = _fn(app, "chooseProtocol")

    # THE WHOLE CONJUNCTION, not the call inside it. Asked as a substring, this assertion
    # passed against its own defect: negating it to
    # `!hasOwnProperty.call(answers, key) || answers[key](want)` -- which grants every
    # unknown key -- still contains `hasOwnProperty.call(answers, key)`. That is the
    # seventh time a gate in this repository has been satisfied by a fragment of the line
    # it was written to require, and the rule each time is the same: ask for the
    # construct, at its site.
    assert (
        "Object.prototype.hasOwnProperty.call(answers, key) && answers[key](want)" in choose
    ), (
        "`chooseProtocol` does not require a condition to be one it can answer AND to "
        "hold; an unknown key is then either a crash or a free pass, and a rule built on "
        "a typo sits above the real ones catching every study"
    )
    assert re.search(r"Object\.entries\(p\.when\)\.every\(", choose), (
        "the conditions are not required to hold together; a rule that matches on ANY of "
        "its conditions is a rule that does not mean what it reads as"
    )
    assert "if (!p || !p.when || !p.layout) return false;" in choose, (
        "a malformed entry is not skipped, so one bad row in the file takes the arrangement"
    )

    load = _fn(app, "loadProtocols")
    assert "Object.keys(p.when).length === 0" in load, (
        "a file with no catch-all is trusted to have one anyway"
    )
    assert "PROTOCOLS = held.some" in load and "...PROTOCOLS]" in load, (
        "the built-in fallback is not appended to a table that lacks one"
    )


def test_the_arrangement_says_who_made_it() -> None:
    """An arrangement that appears without saying why teaches the reader it is arbitrary.

    And then on the day it puts the scout in panel one, they assume it always did.

    THE NAME SURVIVES BEING OVERRIDDEN, struck through rather than cleared. The question
    it answers -- "why did it open like that" -- does not stop being asked when the reader
    rearranges; clearing the name would delete the answer at the moment they were most
    likely to want it.
    """
    app = _app()

    assert "function renderProtocolName()" in app, "nothing names the arrangement"
    assert "protocolOverridden" in _fn(app, "setLayout"), (
        "a layout the reader picks does not mark the protocol as overridden, so the rail "
        "goes on claiming a rule arranged a screen the reader arranged"
    )
    assert "by === 'reader'" in _fn(app, "setLayout"), (
        "`setLayout` cannot tell a protocol's call from the reader's, so the protocol "
        "overrides itself the moment it applies"
    )

    opened = _fn(app, "openStudy")
    assert "chooseProtocol(seriesIndex)" in opened, "a case opens without consulting the table"
    assert "{ by: 'protocol' }" in opened, (
        "the protocol applies its own layout as though the reader had, and immediately "
        "marks itself overridden"
    )
    assert "images.length >= 4 && panels.length < 4" not in opened, (
        "the hard-coded auto-layout is still there beside the table"
    )

    # AND IT IS SOMEWHERE IT CANNOT BE CLIPPED. `.bar-tools` is `overflow: hidden` and does
    # not wrap; six controls were measured clipped out of it, out of paint and out of
    # hit-testing both. A name that can be clipped is not a name.
    markup = (VIEWER / "index.html").read_text(encoding="utf-8")
    rail = markup[markup.index("<aside"):markup.index("</aside>")]
    assert 'id="protocol"' in rail, (
        "the protocol's name is not in the rail, so it lives on the one row of this "
        "surface that clips its contents without saying so"
    )


def test_the_prior_comparison_names_itself_even_when_the_grid_already_fits() -> None:
    """The first version only named it while growing the grid.

    On a study the CT protocol had already opened into two panels, opening a prior left
    the name reading "CT reconstructions, side by side" -- unstruck, and therefore
    claiming to describe a screen that had become a current-and-prior comparison.
    Measured on the running viewer, which is the only way this shows up.
    """
    compare = _fn(_app(), "comparePrior")

    assert "if (!protocolOverridden) {" in compare, (
        "the comparison names itself over a reader who has already arranged the screen, "
        "or does not name itself at all"
    )
    assert compare.index("protocolInForce = pair") < compare.index("if (panels.length < 2)"), (
        "the comparison protocol is named only inside the branch that grows the grid, so "
        "a screen that already had two panels keeps the previous protocol's name"
    )


def test_a_reader_can_reach_every_layout_from_the_keyboard() -> None:
    """A picker only a pointer can reach puts every layout past 2x2 out of reach.

    Which would undo, in one control, most of what this surface has done about the
    keyboard: the panels are focusable, the series rows are buttons, the rail headings are
    disclosures, and the measurement rows answer Enter.
    """
    app = _app()
    picker = _fn(app, "buildLayoutPicker")

    assert "LAYOUT_MAX" in app and re.search(r"LAYOUT_MAX = 4", app), (
        "the picker's bound is not declared"
    )
    assert "role', 'grid'" in picker and "role', 'gridcell'" in picker, (
        "the picker is not a grid to anything that cannot see it"
    )
    assert "ArrowRight" in picker and "ArrowUp" in picker, (
        "the cells cannot be reached with the arrow keys"
    )
    assert "'Escape'" in picker, "the picker cannot be dismissed from the keyboard"
    assert "aria-expanded" in picker, (
        "nothing tells a screen reader whether the picker is open"
    )
    assert "button.focus()" in picker, (
        "focus is not returned to the control that opened the picker, so dismissing it "
        "drops the reader at the top of the document"
    )

    # NO WRAPPING ACROSS ROWS. Arrowing off the right edge of row 2 onto row 3 moves the
    # selection two panels in a direction nobody pressed.
    assert "Math.floor(to / LAYOUT_MAX) !== Math.floor(here / LAYOUT_MAX)" in picker, (
        "the arrow keys wrap from the end of one row to the start of the next"
    )

    # AND THE SHAPE IS SPELLED ONE WAY. The three quick buttons say `1×2` for one row of
    # two; a picker reading `2×1` for that shape makes the reader translate between two
    # spellings of one layout on one toolbar.
    assert "`${r}×${c}`" in picker, "the picker's readout spells the shape the other way round"


def test_the_withdrawn_requirement_is_not_cited_as_though_it_applied() -> None:
    """`openStudy` used to say "MOS-UI-209 wants a case laid out on arrival".

    It does want that, and it does not reach this surface: §19.4.4 is bound by
    `MOS-UI-213` to OHIF configuration or an extension-package module, and both are gone.
    `src/image/mpr.js` carries the same correction for `MOS-UI-211` -- and carries, in
    full, the earlier version of its own header that claimed the requirement applied. A
    citation is a claim about authority, and one that has expired is worse than none
    because it stops anybody checking.
    """
    app = (VIEWER / "app.js").read_text(encoding="utf-8")
    assert "MOS-UI-209 wants a case laid out on arrival" not in app, (
        "the withdrawn citation is back in `openStudy`"
    )

    table = (VIEWER / "protocols.json").read_text(encoding="utf-8")
    for owed in ("MOS-UI-209", "MOS-UI-213", "UNMET"):
        assert owed in table, (
            f"protocols.json does not record `{owed}`; the substance is built and the "
            "status of the requirement it comes from is left for somebody to rediscover"
        )


def test_every_string_the_layout_controls_show_exists_in_every_language() -> None:
    # BOTH SPELLINGS. `t('key', 'English')` in the shell and `data-i18n="key"` in the
    # markup are the two ways this surface asks for a string, and a scan that knows only
    # one of them reports a rail heading as translated because it never looked there.
    app = _app()
    markup = (VIEWER / "index.html").read_text(encoding="utf-8")
    asked = set(re.findall(r"t\(\s*'(layout\.[A-Za-z]+)'", app))
    asked |= set(re.findall(r'data-i18n="(rail\.layout|layout\.[A-Za-z]+)"', markup))
    assert {"layout.more", "layout.pick", "layout.overridden", "rail.layout"} <= asked, (
        f"the scan found only {sorted(asked)}"
    )

    folder = VIEWER / "i18n"
    tables = {p.stem: json.loads(p.read_text(encoding="utf-8")) for p in sorted(folder.glob("*.json"))}
    short = {code: sorted(asked - set(table)) for code, table in tables.items() if asked - set(table)}
    assert not short, (
        "the layout controls speak English in these languages:\n"
        + "\n".join(f"    {code}: {', '.join(missing)}" for code, missing in sorted(short.items()))
    )
