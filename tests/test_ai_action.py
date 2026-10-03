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
        r"JSON\.stringify\(\{\s*study_instance_uid:\s*studyUid,\s*"
        r"capabilities:\s*\[capability\]\s*\}\)",
        DIALOG,
    ), (
        "the analyze dialog must POST exactly {study_instance_uid, capabilities:[one]} "
        "-- CONTRACT.md §9's shape, the same body the MedicalOS panel sends. A second "
        "job-creation shape is a second path, and MOS-SAFE-089a forbids it."
    )
    assert "`${apiRoot}/jobs`" in DIALOG, "the request goes to /api/v1/jobs"


def test_the_model_list_is_configuration_not_discovery() -> None:
    """MOS-UI-366: the offered list is the configured list; the platform has no
    GET /capabilities route, so a dialog that 'fetches the models' would 404."""
    assert "cfg.capabilities" in DIALOG, (
        "the dialog must read window.VIEWER_CONFIG.capabilities -- the deployment's "
        "configured list -- and render the unconfigured state when it is absent"
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
        "ai.action", "ai.title", "ai.study", "ai.model", "ai.noneConfigured",
        "ai.submit", "ai.submitting", "ai.running", "ai.done", "ai.refresh",
        "ai.failed",
    ]
    locales = sorted((ROOT / "i18n").glob("*.json"))
    assert len(locales) >= 10, "the locale set shrank; is that a deletion?"
    for path in locales:
        data = json.loads(path.read_text(encoding="utf-8"))
        missing = [k for k in keys if k not in data]
        assert not missing, f"{path.name} is missing the analyze strings: {missing}"
