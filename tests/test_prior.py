# SPDX-License-Identifier: Apache-2.0
"""A current study beside its prior, and the one thing that pairing must never get wrong.

WHAT WAS MISSING, AND WHY IT WAS THE LARGEST GAP ON THIS SURFACE
----------------------------------------------------------------
Whether a nodule grew is a question about two studies. This viewer could hold one: a
single module-level `studyUID`, written by `openStudy`, read by the rail, the banner, the
auto-layout, the capture caption and the CSV. Opening a second study did not put it beside
the first -- it REPLACED it, and cleared the measurements taken on the first on the way
past, because a measurement belongs to a patient and nothing scoped it further.

The word `prior` appeared nowhere in the tree.

WHAT THE PANEL NOW CARRIES. `loadSeriesInto` had always been handed the study -- it is the
first half of every WADO-RS path it builds -- and threw it away once the request was made.
It records it now, and that one field is what makes two panels able to disagree about
which study they are showing.

THE SAFETY ARGUMENT, which is the reason most of this file is about refusal rather than
about display. Two pictures side by side ASSERT, by being side by side, that they are the
same person. Nothing else on the screen says it as loudly, and a reader comparing a lesion
across two studies is reading the DIFFERENCE -- which is exactly the signal a wrong pairing
manufactures out of nothing. So identity is checked on PatientID, twice, and never on the
name: de-identified corpora routinely give many patients one `PatientName`, and this
archive holds nineteen studies under `anonim_patient` belonging to different people.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

VIEWER = Path(__file__).resolve().parents[1]

_LINE_COMMENT = re.compile(r"^\s*//.*$", re.M)
_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.S)


def _code(text: str) -> str:
    """The source with its comments gone.

    Every gate in this repository that skipped this step has at some point passed against
    its own defect, satisfied by the comment explaining the thing it forbids.
    """
    return _LINE_COMMENT.sub("", _BLOCK_COMMENT.sub("", text))


def _app() -> str:
    return _code((VIEWER / "app.js").read_text(encoding="utf-8"))


def _fn(src: str, name: str) -> str:
    """One function's body, from its declaration to the next one at column zero."""
    start = src.index(f"function {name}(")
    rest = src[start:]
    end = rest.find("\nfunction ", 1)
    return rest if end < 0 else rest[:end]


def test_a_panel_knows_which_study_it_is_showing() -> None:
    """One variable for the whole surface is what made a prior impossible.

    `panel.studyUID` is the field, and it has to survive the three places a panel's
    identity is rebuilt or destroyed or the comparison decays into two pictures that no
    longer know what they are:

        loadSeriesInto   written, beside `panel.seriesUID`
        setLayout        carried across the rebuild -- a reader who presses 2x2 with a
                         prior open would otherwise get two panels showing two studies and
                         both answering the chrome with whatever the ACTIVE panel holds
        clearPanel       cleared -- an emptied panel that still names a study is how a
                         prior's identifiers end up over a current study's picture
    """
    app = _app()

    load = _fn(app, "loadSeriesInto")
    assert "panel.studyUID = study;" in load, (
        "`loadSeriesInto` does not record which study it loaded, so the panel cannot be "
        "asked -- and every part of the chrome falls back to the one study the surface "
        "arrived at"
    )

    layout = _fn(app, "setLayout")
    assert "studyUID: p.studyUID" in layout and "studyUID: old.studyUID" in layout, (
        "a layout change drops each panel's study, so a comparison dissolves the moment "
        "the reader presses 1x2 or 2x2"
    )

    clear = _fn(app, "clearPanel")
    assert "p.studyUID = null;" in clear, (
        "a cleared panel keeps naming the study it used to hold; the rail, the banner and "
        "an exported caption all ask the active panel that question"
    )


def test_two_studies_are_paired_on_the_patient_id_and_never_on_the_name() -> None:
    """The failure this whole feature could produce, and the two checks against it.

    A name is not an identity. `PatientName` is repeated across de-identified corpora --
    nineteen studies in this project's own archive share `anonim_patient` and belong to
    different people -- so pairing on it would put two patients side by side under one
    banner, which is the exact artefact a comparison is least able to survive.

    AND AN EMPTY ID IS NOT A MATCH. Two studies with no PatientID would compare equal
    under any `a === b`, which is how "unknown" becomes "the same person".

    CHECKED TWICE, ON TWO DIFFERENT ANSWERS FROM THE ARCHIVE. The picker filters by
    PatientID, and a filter is a REQUEST; the study row is an answer, and the series rows
    -- the ones whose pixels are about to be drawn -- are a second, separate answer. An
    origin that matches loosely on case, padding or an unintended wildcard returns rows
    the caller did not ask for, and a surface that checks the row it was told about rather
    than the row it is about to render has checked the wrong thing.
    """
    app = _app()
    same = _fn(app, "samePatient")

    assert "00100020" in same, "`samePatient` does not read PatientID"
    assert "00100010" not in same, (
        "`samePatient` reads PatientName. A name is not an identity: this archive holds "
        "nineteen studies under one name belonging to different people"
    )
    assert re.search(r"Boolean\(\s*one\s*\)|one\s*&&|if\s*\(!\s*one\s*\)", same), (
        "`samePatient` does not refuse an empty id, so two studies that name no patient "
        "compare equal and 'unknown' becomes 'the same person'"
    )

    compare = _fn(app, "comparePrior")
    assert "samePatient" in compare, (
        "`comparePrior` places a study beside the current one without checking that they "
        "name the same patient"
    )
    assert "priorSeries[0]" in compare, (
        "the identity re-check reads something other than the series rows that are about "
        "to be drawn -- the study row the picker was built from is a different answer "
        "from the archive than the one whose pixels arrive"
    )
    assert compare.index("samePatient") < compare.index("loadSeriesInto"), (
        "the patient check happens after the pixels are loaded into the panel, so a "
        "mismatched study is drawn and then complained about"
    )
    assert "priors.refused" in compare, "a refusal that does not say what was refused"


def test_the_chrome_follows_the_panel_and_not_the_surface() -> None:
    """The banner names a patient and a study. With two open it has to name the right one.

    A banner left behind on a panel click is not a stale label; it is the WRONG study's
    identifiers over the RIGHT study's picture, which is the same artefact as a mismatched
    pair and arrives by a quieter route.
    """
    app = _app()

    assert "function activeStudy()" in app and "function syncChromeToActiveStudy()" in app, (
        "there is no single answer to 'which study is the reader working in'"
    )
    assert "syncChromeToActiveStudy();" in _fn(app, "setActive"), (
        "clicking a panel does not re-point the chrome, so the banner and the series rail "
        "go on describing the study the reader clicked AWAY from"
    )

    # AND THE EXPORT READS THE PANEL'S OWN STUDY. Capturing the prior while the banner
    # shows the current study must not caption the prior's pixels with the current
    # study's date -- the single worst artefact this feature could put on disk.
    capture = _fn(app, "captureActivePanel")
    assert "studyRows(p.studyUID)" in capture, (
        "the capture's caption is built from the surface's study rather than from the "
        "panel's own, so exporting a prior labels it with the current study"
    )
    assert "seriesIndex" not in capture, (
        "the capture still reads the single-study index this change replaced"
    )


def test_a_thumbnail_is_fetched_under_the_study_its_row_belongs_to() -> None:
    """Found in the network log, not in the code, and it is this refactor's own defect.

    `paintAllThumbs` guarded every await with `studyUID !== study` -- the module-level
    arrival study. That was the same question while the surface held one study and stopped
    being one the moment the series rail could be rendered for a study the reader had not
    arrived at. Clicking a prior re-renders that list from the PRIOR's series while
    `studyUID` does not move, so the guard passed and the loop asked the archive for the
    prior's series UID under the current study's UID.

    MEASURED on the running viewer: four requests of the shape

        /studies/{current}/series/{prior}/instances?includefield=00200013
        -> 204 No Content, then aborted

    A 204 is the harmless version. The same pairing against an origin that resolves it
    differently paints one study's thumbnail onto another study's row.
    """
    app = _app()
    thumbs = _fn(app, "paintAllThumbs")

    assert "studyUID !== study" not in thumbs, (
        "the thumbnail loop still guards on the arrival study, so it goes on painting "
        "into a list that now belongs to a different one"
    )
    assert thumbs.count("activeStudy() !== study") >= 2, (
        "the guard is not applied after every await; each one is a chance for the list to "
        "change under the loop"
    )
    assert "paintAllThumbs(uid)" in _fn(app, "renderSeriesList"), (
        "the list hands the painter a study other than the one it just rendered"
    )


def test_a_measurement_is_filed_under_the_study_it_was_taken_on() -> None:
    """Two studies on screen means the session's list holds measurements from both.

    `remember(studyUID, ...)` wrote the WHOLE list under the arrival study. With a prior
    open, a caliper placed on the prior's panel would have been written into the current
    study's record, recalled onto the current study on the next visit, and listed there as
    a number taken from a picture it was never taken from.

    AND THE MARKING IS NOT THE ONE THE READER HAS LEARNED TO SKIP. "· another series"
    describes an ordinary, safe, within-study situation; a reader who has seen it a
    hundred times reads it as "not the picture you are on, and that is fine". The same
    marking on a row measured on a different STUDY -- a different day, the very thing
    being compared -- would inherit that learned harmlessness. This surface has already
    been burnt from the other side: a caliper from one patient sat in this table while
    another patient's study was open, marked "· another series".
    """
    app = _app()

    assert "get studyUID() { return p.studyUID; }" in app, (
        "a measurement's address does not carry the study, so the record cannot say which "
        "of two open studies it was taken on"
    )

    # AND THE RECORD COPIES IT OFF THE ADDRESS. This is the half a gate on the getter
    # alone cannot see, and it is not hypothetical: with the getter in place and this line
    # missing, a caliper drawn on the prior's panel was still written into the CURRENT
    # study's record, because `describeMeasurement` builds a frozen record from a fixed
    # list of fields and the store then fell back to the one study the shell had a
    # variable for. MEASURED on the running viewer -- the record landed under the study
    # the reader arrived at, with the prior on screen and active.
    #
    # `remeasure` too, or the first drag of a handle rebuilds the record without it and
    # moves the measurement into the arrival study's record wearing an edit as a disguise.
    measure = _code((VIEWER / "src" / "image" / "measure.js").read_text(encoding="utf-8"))
    assert "studyUID: location.studyUID ?? null," in measure, (
        "`describeMeasurement` does not copy the study off the address, so every record "
        "is filed under whichever study the shell arrived at"
    )
    assert "studyUID: m.studyUID ?? null," in measure, (
        "`remeasure` drops the study when a handle is dragged, so editing a measurement "
        "on a prior moves it into the current study's record"
    )

    remember = app[app.index("subscribeTo(['measurements']"):]
    remember = remember[:remember.index("mountPanels()")]
    assert "remember(studyUID, getState().measurements)" not in remember, (
        "the whole list is still written under one study, so a prior's measurements are "
        "filed in the current study's record"
    )
    assert "m.studyUID" in remember and "for (const [uid, held] of byStudy)" in remember, (
        "measurements are not split by the study they were taken on before being stored"
    )

    panel = _code((VIEWER / "src" / "ui" / "measurements-panel.js").read_text(encoding="utf-8"))
    assert "otherStudy" in panel and "another study" in panel, (
        "the measurements table does not distinguish a row measured on another STUDY from "
        "one measured on another series"
    )
    assert re.search(r"otherStudy\s*=\s*\(m\)\s*=>.*studyUID", panel), (
        "the cross-study test does not read the measurement's study"
    )
    assert "elsewhere(m) && !otherStudy(m)" in panel, (
        "both markings can print on one row; the series note then buries the study note, "
        "which is the one that matters"
    )


def test_a_panel_says_which_study_it_is_only_when_that_distinguishes_it() -> None:
    """The patient's name argument, run in the other direction.

    That name was taken OUT of the panel label because one study opened into every panel
    and four identical copies distinguished nothing. A prior makes panels able to differ,
    and the moment two panels can show two studies a label naming only the series is the
    ambiguity that removal was avoiding -- in the one place a reader must not have it.

    SO IT APPEARS EXACTLY WHEN IT DISCRIMINATES: nothing with one study open, every panel
    marked with two. Marking only the prior would leave an unmarked panel to be read as
    the current study by convention rather than by statement.
    """
    app = _app()
    mark = _fn(app, "studyMark")

    assert "open.size < 2" in mark and "return ''" in mark, (
        "the study mark is drawn with a single study open, which is the repetition that "
        "cannot vary that this surface removed from the panel label once already"
    )
    assert "00080020" in mark, "the mark is not the study's date"
    assert "p.studyUID" in mark, "the mark does not come from the panel's own study"

    # THE MARK IS IN THE LINE, not the line spelled exactly. This asserted the whole
    # statement and went red the day a fusion caption was appended to the same corner --
    # a correct edit, failed by a gate reading spelling. That is the third time today, and
    # the two earlier ones were in code somebody else had written; this one was mine, an
    # hour old, and written between the two complaints about the habit.
    tl = re.search(r"p\.hud\.tl\.innerHTML = ([^;]+);", app)
    assert tl and "studyMark(p)" in tl.group(1), (
        "the panel label does not carry the study mark"
    )
    assert "drawAll();" in _fn(app, "comparePrior"), (
        "opening a prior redraws only the panel it loaded, so the panel holding the "
        "current study stays unmarked -- and an unmarked panel beside a dated one reads "
        "as a convention rather than as a statement"
    )

    # AND WHEN THE SET SHRINKS BACK TO ONE. `openStudy` loads panels one at a time, so
    # while panel 0 was loading, panel 1 still held the PREVIOUS study: the set had two
    # members and panel 0 was dated. Panel 1 then loaded, the set became one study, and
    # nothing redrew panel 0. MEASURED by going back to the worklist and opening another
    # patient -- one panel marked, its neighbour not, with one study on screen.
    #
    # The mark was never WRONG: it reads `p.studyUID` and can only name its own panel's
    # study. But a mark that lingers where it discriminates nothing is one a reader learns
    # to ignore, and it is needed on the day it means something.
    assert "drawAll();" in _fn(app, "openStudy"), (
        "`openStudy` never settles the marks after its sequential loads, so a panel keeps "
        "a study date left over from the moment a neighbour still held the last patient"
    )


def test_the_prior_list_is_a_query_and_not_a_slice_of_the_worklist() -> None:
    """A prior older than the page the reader happened to be on is still a prior.

    The worklist is one page of a filtered, sorted query. Building the prior list by
    filtering it would make a patient's older studies invisible whenever the reader had
    navigated, and their absence would look exactly like the patient not having any.
    """
    app = _app()
    priors = _fn(app, "loadPriors")

    assert "client.studies(" in priors and "PatientID" in priors, (
        "the prior list is not a query by patient identity"
    )
    assert "dv(s, '0020000D') !== uid" in priors, (
        "the study being read is not excluded from its own list of priors"
    )
    assert "priors.noId" in priors, (
        "a study with no PatientID gets no explanation, so a reader sees an absent "
        "section and concludes the patient has no priors rather than that the question "
        "could not be asked by identity"
    )
    assert "if (!priors.length) return;" in priors, (
        "an empty section is rendered; a heading that is always empty teaches the reader "
        "to stop looking at it"
    )

    # AND THE FIELDS IT PAIRS ON ARE ASKED FOR RATHER THAN ASSUMED.
    wire = (VIEWER / "src" / "dicom" / "dicomweb.js").read_text(encoding="utf-8")
    fields = re.search(r"const STUDY_FIELDS = \[(.*?)\];", wire, re.S).group(1)
    assert "00100020" in fields, (
        "PatientID is not in the study query's includefield. PS3.18 requires an origin to "
        "return it anyway, and 'the standard says so' is what fails quietly on one origin "
        "-- in the one place a missing id would make two studies unpairable, or make two "
        "blank ids equal"
    )
    assert "00080020" in fields, "StudyDate is not asked for, and the list is ordered by it"


def test_every_string_this_feature_shows_exists_in_every_language() -> None:
    """A refusal a reader cannot read is a refusal that did not happen.

    The keys are asserted here as well as by the parity gate in
    `test_architecture.py`, because that one checks the tables AGREE -- and a key
    missing from all twelve agrees perfectly while showing English to everybody.
    """
    app = _app()
    asked = set(re.findall(r"t\(\s*'(priors\.[A-Za-z]+)'", app))
    asked.add("rail.priors")
    assert len(asked) >= 5, f"only {sorted(asked)} — the scan is wrong, not the feature"

    folder = VIEWER / "i18n"
    tables = {
        p.stem: json.loads(p.read_text(encoding="utf-8"))
        for p in sorted(folder.glob("*.json"))
    }
    assert len(tables) >= 11, "the language tables are missing"

    short = {
        code: sorted(asked - set(table))
        for code, table in tables.items()
        if asked - set(table)
    }
    assert not short, (
        "the prior comparison speaks English in these languages:\n"
        + "\n".join(
            f"    {code}: {', '.join(missing)}" for code, missing in sorted(short.items())
        )
    )
