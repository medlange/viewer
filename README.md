# Viewer

A DICOMweb study viewer. It runs in a browser, reads DICOM over
[PS3.18](https://dicom.nema.org/medical/dicom/current/output/html/part18.html) QIDO-RS and
WADO-RS, and renders CT, MR and PT with WebGL2.

**RESEARCH USE ONLY — NOT FOR DIAGNOSTIC USE. NOT FOR CLINICAL DECISION MAKING.**

---

## What it needs

An origin that serves QIDO-RS and WADO-RS, and a static file server pointed at this
directory. That is the whole list.

```bash
python -m http.server 8080 --directory viewer
```

There is **no build step, no bundler, no package manager and no runtime dependency**.
`index.html` loads ES modules directly from `src/`; 48 files, ~20 000 lines, all of them
in this tree. Nothing is fetched at run time from anywhere but the origin it is configured
against. The reasoning is recorded in `../docs/adr/BUILD_VS_ADOPT.md`: a dependency
delivered into a medical device's UI is a SOUP element under IEC 62304 §8.1.2 whose
characterisation cost scales with what it *ships*, not with what is *used*.

## Configuration

`viewer-config.js` is a plain classic script that sets one global before the application
loads. The file in this tree holds the viewer's own defaults — a plain DICOMweb client,
no tenant, no consumer class, no product name:

```js
window.VIEWER_CONFIG = {
  dicomWebRoot: '/dicomweb',
};
```

| key | default | what it does |
|---|---|---|
| `dicomWebRoot` | `/dicomweb` | the base the QIDO/WADO paths hang off |
| `tenant` | *(none)* | appended as a path segment, for origins that scope by one |
| `surfaceHeader` + `surface` | *(none)* | a request header declaring a consumer class. Both or neither: a header name without a value is not sent |
| `productName` | *(none)* | the name in the tab title, the heading, and the About dialog |

A host overrides by **replacing this file** — a bind mount, a build step, a handler that
serves different bytes at this path. It does not edit it.
`../medos/deploy/compose/viewer-config.js` is that file for this repository's own deployment.
Nothing under `src/` reads anything but `window.VIEWER_CONFIG`.

## What it does not know

- **Whose it is.** The product name, the tenant and the consumer class all arrive from
  configuration or not at all. The string `MedicalOS` does not occur in this tree.
- **That a platform exists.** Every request it makes goes to the configured DICOMweb root.
  It calls no `/api/` of any kind.

Both facts are asserted mechanically, not promised —
`tests/test_independence.py`.

## Layout

```
index.html          the shell: rails, viewport grid, dialogs
app.js              wiring — layout, panels, tools, keyboard, session
viewer-config.js    the host seam (above)
presets.json        window/level presets
protocols.json      hanging protocols: which series land in which panel
build.json          version and transfer syntax, read by the About dialog
i18n/               12 translation tables
src/
  core/             state, registry, session store, i18n
  dicom/            DICOMweb client, instance parsing, date formatting
  image/            volume build, MPR, oblique, SEG, SR, fusion, measurement, units
  render/           WebGL2 viewport, annotations, transforms
  tools/            measurement tools
  ui/               rails, panels, dialogs, export, icons
```

`src/dicom/dicomweb.js` is the only module that issues a network request.

## Tests

In `tests/`, beside the code they read. They need pytest and nothing else — no fixtures,
no shared harness, no import from anywhere outside this directory — so they run from here:

```bash
cd viewer && pytest tests
```

`tests/js/` holds four harnesses that drive `src/image/` against real DICOM geometry under
node. They are executed from the platform's suite, which is where the Docker and corpus
machinery lives.

**The rule for this directory: a test here may read `viewer/` and nothing else.** A viewer
whose own suite reaches into a deployment is a viewer that knows its host, which is the
coupling this separation exists to remove. The mirror halves — that *this* deployment
mounts a configuration over `viewer-config.js`, and substitutes the MOS-SAFE-001 sentence
into the response body — are asserted in `../tests/unit/test_viewer_deployment.py`. The
direction is one-way: the platform may read the viewer, the viewer may not read the
platform.

## Known host leak

`build.json` carries `platform_version`. That is a fact about a host, in a file this tree
ships, and it is the same defect the rest of this directory no longer has.
