# SPDX-License-Identifier: Apache-2.0
"""The transfer-syntax limitation is a contract, not a file header.

WHY THIS FILE EXISTS
---------------------
The viewer retrieves Explicit VR Little Endian only and ships no image codec. That
fact lived ONLY in the header comment of src/dicom/dicomweb.js — an integrator's
first contact with a real archive (JPEG-LS, JPEG 2000, HTJ2K) is a refusal they
cannot interpret, and nothing in the README or the guides said it was coming. The
README now carries a "Transfer syntax" section; this gate pins both halves of the
story so the doc and the code cannot drift apart:

  * every retrieve NAMES the uncompressed transfer syntax in its Accept header --
    the mechanism PS3.18 6.1.1.8 makes load-bearing (a conformant origin honours the
    request or answers 406);
  * the two refusal paths are named, never silent: 406 -> `transcode_refused` at the
    series level, and a compressed object that slips through ->
    `unsupported_transfer_syntax` per instance, carried in warnings until it reaches
    the reader as a notice;
  * the README section exists and names the compressed syntaxes an integrator will
    actually meet, so the limitation is findable before the deployment, not during it.

Spec: MOS-UI-002, MOS-DATA-015; the reasoning is the Viewer row of
docs/adr/BUILD_VS_ADOPT.md.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLIENT = (ROOT / "src" / "dicom" / "dicomweb.js").read_text(encoding="utf-8")
PARSER = (ROOT / "src" / "dicom" / "parse.js").read_text(encoding="utf-8")
README = (ROOT / "README.md").read_text(encoding="utf-8")


def test_every_retrieve_names_the_uncompressed_transfer_syntax() -> None:
    """The Accept header is the mechanism, not a formality: it is how a viewer with
    no codec keeps compressed bytes from ever reaching a decoder that cannot read
    them. Both retrieves (single instance and series) must name it."""
    accepts = re.findall(
        r"accept = `multipart/related[^`]*transfer-syntax=\$\{UNCOMPRESSED\}`", CLIENT
    )
    assert len(accepts) == 2, (
        f"{len(accepts)} retrieve Accept header(s) name transfer-syntax; "
        "retrieveInstance and retrieveSeries both must -- an origin can only honour "
        "or refuse a request it was actually sent"
    )
    assert "const UNCOMPRESSED = '1.2.840.10008.1.2.1'" in CLIENT, (
        "the named syntax is no longer Explicit VR Little Endian; the README's "
        "'Transfer syntax' section and the wire have come apart"
    )


def test_the_refusals_are_named_at_both_levels() -> None:
    """406 at the door, named; a compressed instance inside, named. The silent
    failure this replaces is 'wrong pixels that look like a window problem'."""
    assert "'transcode_refused'" in CLIENT, (
        "dicomweb.js does not name the 406 refusal; a reader told only '406 Not "
        "Acceptable' cannot tell a transcoding gap from a broken archive"
    )
    assert "unsupported_transfer_syntax" in PARSER, (
        "parse.js does not name the per-instance refusal for a compressed object; a "
        "silently dropped instance is the wrong-pixels failure parse.js exists to "
        "prevent, one level down"
    )


def test_the_readme_carries_the_transfer_syntax_story() -> None:
    """The integrator-facing half: the limitation must be in the document a host
    reads before pointing this viewer at their PACS, naming the compressed syntaxes
    they will actually meet."""
    assert "## Transfer syntax" in README, (
        "README.md has no 'Transfer syntax' section; the limitation is documented "
        "only in code headers again"
    )
    section = README[README.index("## Transfer syntax"):]
    section = section[: section.index("\n## ")] if "\n## " in section else section
    for needle in ("1.2.840.10008.1.2.1", "transcode_refused",
                   "unsupported_transfer_syntax", "JPEG-LS", "JPEG 2000"):
        assert needle in section, (
            f"the README's 'Transfer syntax' section never names {needle!r}; an "
            "integrator hitting it in the field has no way to know it was promised"
        )
