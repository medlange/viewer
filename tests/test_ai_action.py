# SPDX-License-Identifier: Apache-2.0
"""The analyze verb: the first ACTION contribution, wired plug-n-play.

WHY A SEPARATE FILE AND NOT PART OF test_architecture
------------------------------------------------------
The architecture gates are generic: they catch a module that imports the shell, a
contribution nobody imports, a string missing from a locale. What they cannot catch
is the FEATURE'S contract: that the dialog POSTs exactly CONTRACT.md §9's two-member
body, that the model list comes from configuration and not from a discovery call the
platform has no route for, and that a run which never COMPLETEDs never reloads the
study out from under the reader. Those are behaviours, asserted here against the
source the way this suite does it -- by reading the module, the same way a reviewer
does.

Spec: roadmap G-U3; MOS-SAFE-089a (one job-creation path); MOS-UI-366 (the capability
list is configured, not discovered).
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ACTION = (ROOT / "src" / "ui" / "ai-action.js").read_text(encoding="utf-8")
DIALOG = (ROOT / "src" / "ui" / "ai-dialog.js").read_text(encoding="utf-8")
SHELL = (ROOT / "app.js").read_text(encoding="utf-8")


def test_the_analyze_verb_registers_as_an_action() -> None:
    assert "KINDS.ACTION" in ACTION, (
        "ai-action.js must register as an ACTION contribution -- the study-screen "
        "verb kind, not a TOOL (it is not an interaction over pixels)"
    )
    assert re.search(r"id:\s*'analyze'", ACTION), "the verb's id is 'analyze'"
    assert "openAnalyzeDialog" in ACTION


def test_the_dialog_posts_contract_section_9s_body_and_nothing_else() -> None:
    """MOS-SAFE-089a: one job-creation path, the button's exact request."""
    assert re.search(
        r"JSON\.stringify\(\{\s*study_instance_uid:\s*studyUid,\s*capabilities\s*\}\)",
        DIALOG,
    ), (
        "the analyze dialog must POST exactly {study_instance_uid, capabilities} -- "
        "CONTRACT.md §9's shape, the same body the MedicalOS panel sends. A second "
        "job-creation shape is a second path, and MOS-SAFE-089a forbids it."
    )
    assert "`${apiRoot}/jobs`" in DIALOG, "the request goes to /api/v1/jobs"


def test_the_selection_is_submitted_as_a_dependency_closure() -> None:
    """`emphysema_laa` needs `lung_segmentation` in the SAME job (CONTRACT.md §7).

    Measured 2026-10-03: submitting the lone selection made every `emphysema_laa`
    run FAIL with `capability_resolution_failed`. The wire body is the closure, not
    the selection.
    """
    assert "function closureFor(" in DIALOG, (
        "the dialog must compute the transitive depends_on closure of the selection"
    )
    assert re.search(
        r"capabilities:\s*closureFor\(capability,\s*depsById\)", DIALOG,
    ), "the POST body is the closure of the selected capability"
    assert "out.add(id)" in DIALOG and "depsById.get(id)" in DIALOG, (
        "the closure walks depends_on transitively and is cycle-safe"
    )


def test_the_model_list_is_configured_and_the_edges_are_platform_data() -> None:
    """MOS-UI-366 fixed the offered list as the configured list when the platform
    had no route to read; the route exists now (`GET /api/v1/capabilities`). The
    list stays configured -- a deployment whitelists what its readers may run --
    but `depends_on` edges are platform data and MUST NOT be duplicated into
    viewer-config.js, where they would rot."""
    assert "cfg.capabilities" in DIALOG, (
        "the dialog must read window.VIEWER_CONFIG.capabilities -- the deployment's "
        "configured list -- and render the unconfigured state when it is absent"
    )
    assert "loadCapabilityDescriptors" in DIALOG
    assert "`${apiRoot}/capabilities`" in DIALOG, (
        "the dependency edges are read from the platform's GET /api/v1/capabilities"
    )
    assert re.search(r"if \(!response\.ok\) return null;", DIALOG), (
        "a platform without the route (or a proxy hiding it) must degrade to empty "
        "edges -- the pre-route behaviour -- not render an error the reader cannot "
        "act on"
    )
    assert "ai.noneConfigured" in DIALOG


def test_a_refused_submit_renders_the_problem_and_recovers() -> None:
    """The 401 out-of-the-box state must be a sentence, not a dead button."""
    assert "run.disabled = false" in DIALOG, (
        "after a refused submit the button must re-enable, so the reader can retry "
        "once a credential exists -- a dialog that locks shut after one refusal "
        "teaches the reader never to press it"
    )
    assert "String(err.message || err)" in DIALOG


def test_only_a_completed_run_reloads_the_study() -> None:
    assert "if (job.state === 'COMPLETED')" in DIALOG, (
        "the reload callback fires only on COMPLETED; FAILED/REJECTED/CANCELLED "
        "render their state and leave the study where the reader had it"
    )


def test_the_shell_hands_the_action_its_context() -> None:
    assert "contributions(KINDS.ACTION)" in SHELL, (
        "app.js must render registered ACTIONs on the study bar"
    )
    assert re.search(r"openStudy\(studyUID\)", SHELL), (
        "the reload the action is handed re-opens the study through openStudy -- a "
        "browser reload would drop the reader at the study list, because the page "
        "keeps its state client-side"
    )


def test_every_ai_string_exists_in_every_language() -> None:
    keys = [
        "ai.action", "ai.title", "ai.study", "ai.model", "ai.alsoRuns",
        "ai.noneConfigured",
        "ai.submit", "ai.submitting", "ai.running", "ai.done", "ai.refresh",
        "ai.failed",
    ]
    locales = sorted((ROOT / "i18n").glob("*.json"))
    assert len(locales) >= 10, "the locale set shrank; is that a deletion?"
    for path in locales:
        data = json.loads(path.read_text(encoding="utf-8"))
        missing = [k for k in keys if k not in data]
        assert not missing, f"{path.name} is missing the analyze strings: {missing}"
