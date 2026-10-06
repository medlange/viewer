# SPDX-License-Identifier: Apache-2.0
"""The worklist upload verb (U4): files from disk into the archive, in the viewer.

What is pinned here is the contract a DICOMweb origin actually holds this surface to:
the multipart/related body assembled BY HAND (a FormData encoder emits multipart/
form-data with Content-Disposition parts, which an origin is entitled to reject
outright — the same reason `medos.dicomweb.client.stow` assembles its body by hand),
the STOW-RS target `{root}/studies`, MOS-IMG-084's partial-store shape (200 with a
non-empty FailedSOPSequence is reported, not swallowed), and the shell seam (the
module never imports app.js; the shell hands it the root, the refresh and the
notice bar).

Spec: roadmap U4; MOS-IMG-084; PS3.18 STOW-RS.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
UPLOAD = (ROOT / "src" / "ui" / "upload.js").read_text(encoding="utf-8")
SHELL = (ROOT / "app.js").read_text(encoding="utf-8")
INDEX = (ROOT / "index.html").read_text(encoding="utf-8")


def test_the_wire_shape_is_stow_rs_multipart_assembled_by_hand() -> None:
    assert "multipart/related" in UPLOAD
    assert 'type="${MULTIPART_DICOM}"' in UPLOAD
    assert "Content-Type: ${MULTIPART_DICOM}" in UPLOAD
    assert "Content-Length: ${file.size}" in UPLOAD
    assert "new FormData" not in UPLOAD, (
        "FormData emits multipart/form-data with Content-Disposition parts, which a "
        "DICOMweb origin may reject outright; the body is assembled by hand, the same "
        "construction as medos.dicomweb.client.stow"
    )
    assert "Content-Disposition:" not in UPLOAD


def test_the_target_is_the_same_root_the_reads_use() -> None:
    assert re.search(r"\$\{String\(root\)\.replace\(/\\/\+\$/, ''\)\}/studies", UPLOAD), (
        "STOW-RS posts to {root}/studies — the root reads already use, tenant included, "
        "so credential injection and tenancy are the enforced ones, not a second path"
    )


def test_a_partial_store_is_reported_not_swallowed() -> None:
    """MOS-IMG-084: 200 with a non-empty FailedSOPSequence (0008,1198 in DICOM JSON)
    is a result the reader must see."""
    assert "00081198" in UPLOAD
    assert re.search(r"failed = seq\.length", UPLOAD)
    assert "upload.partial" in UPLOAD


def test_a_refused_batch_announces_and_keeps_the_files() -> None:
    assert re.search(
        r"catch \(err\) \{[\s\S]*?announce\(String\(err\.message \|\| err\), 'err'\)", UPLOAD
    )
    assert re.search(r"finally \{[\s\S]*?input\.value = ''", UPLOAD)


def test_drag_drop_is_wired_with_the_prevent_default_the_browser_requires() -> None:
    assert "dragover" in UPLOAD and "e.preventDefault()" in UPLOAD
    assert "wl-drop" in UPLOAD
    assert "wl-drop" in (ROOT / "styles.css").read_text(encoding="utf-8")


def test_the_shell_hands_the_module_its_seam() -> None:
    assert "import { bindUpload } from './src/ui/upload.js'" in SHELL
    assert re.search(
        r"bindUpload\(\{[\s\S]*?root: dicomWebRoot\(\),[\s\S]*?"
        r"onDone: \(\) => showStudies\(\),[\s\S]*?"
        r"announce: \(message, kind\) => notice\(message, kind\),",
        SHELL,
    )
    assert "from '../app.js'" not in UPLOAD and "from './app.js'" not in UPLOAD, (
        "src/ui modules must not import the shell — test_architecture fails that, and "
        "the upload verb is no exception"
    )


def test_the_button_lives_in_the_worklist_header() -> None:
    assert 'id="wl-upload"' in INDEX
    assert INDEX.index('id="wl-upload"') > INDEX.index('id="study-list"')


def test_every_upload_string_exists_in_every_language() -> None:
    keys = ["wl.upload", "upload.sending", "upload.done", "upload.partial"]
    locales = sorted((ROOT / "i18n").glob("*.json"))
    assert len(locales) >= 10, "the locale set shrank; is that a deletion?"
    for path in locales:
        data = json.loads(path.read_text(encoding="utf-8"))
        missing = [k for k in keys if k not in data]
        assert not missing, f"{path.name} is missing the upload strings: {missing}"
