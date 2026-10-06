# Plugin API reference

The contract a manifest plugin's `setup(api)` receives. Implemented by
`src/core/plugins.js`; `PLUGIN_API_VERSION = '1.0.0'`, and only the MAJOR digit is
load-bearing — a plugin naming a different major in its manifest `api` (or its
`PLUGIN_API` export) is refused before `setup` runs. The developer guide is
[extensions.md](extensions.md); the worked example is
[examples/hello-plugin.js](../examples/hello-plugin.js).

## version

`api.version` — string, semver. The contract below is what `1.x` means.

## register / KINDS

`api.register(contribution)` — the registry's `register()`
(`src/core/registry.js`). A duplicate id is refused, never overwritten: two
contributions on one id would resolve by load order and the loser would be invisible.
`api.KINDS` — `PANEL`, `TOOL`, `OVERLAY`, `ACTION`.

Contribution contracts, all four kinds:

| kind | fields | the shell calls |
|---|---|---|
| PANEL | `id, kind, slot: 'left' \| 'right', title, order` | `mount(host) → teardown` |
| TOOL | `id, kind, title, key, icon?, order?, compute?` | `handlers(panel, location, commit, setPreview) → { onDown, onMove, onUp, onCancel }` |
| OVERLAY | `id, kind, title?, order?` | `draw({ panel, annotations, state })` after the annotation layer, every draw |
| ACTION | `id, kind, title, icon?, order?` | `onClick({ studyUid, reloadStudy })` — a button on the study bar |

- **PANEL** — `mount` renders into `host`, subscribes to state, and returns its
  teardown; the shell calls the teardown before any remount. A panel never imports
  the shell (`app.js`).
- **TOOL** — armed for ONE measurement, not a mode. `onDown` returns `false` to leave
  the gesture to the default bindings (middle/right drag stay pan and zoom);
  `onCancel` disarms without measuring (Escape); `commit` files the measurement.
- **OVERLAY** — `annotations` is the panel's `AnnotationLayer` (an `<svg>` whose
  `pointer-events` is already `'none'`). A throw is logged by id and skipped.
- **ACTION** — `studyUid` is the open study; `reloadStudy` re-opens it (dropping the
  series cache first, so derived objects the platform stored arrive as new series).

## state

`api.state` — a read-only seam over `src/core/state.js`. Notification is synchronous
and ordered: a subscriber sees the new state before the next change can run.

| member | what it does |
|---|---|
| `get()` | the frozen state object |
| `subscribe(fn)` | `fn(state, changedKeys, origin)` on every change; returns the unsubscribe |
| `subscribeTo(keys, fn)` | the same, only when one of `keys` changed |

Keys: `panels` (viewport panels, each with its stack/index/plane), `active` (which
panel the keyboard acts on), `studyUID` (the open study, or null), `series` (the
study's QIDO rows), `link` (`{ scroll, window, zoomPan }`), `principal`,
`measurements` (SR-derived rows), `selectedMeasurement`, `hiddenMeasurements`,
`cursor`, `srMeasurements`, `notice`.

## dicomweb

`api.dicomweb` — the configured `DicomWebClient` (`src/dicom/dicomweb.js`), the
viewer's only route to pixels. The host's Authorization rides it: `authHeaderProvider`
is re-read per request (or `authToken` is sent as `Bearer <token>`; absent both, no
Authorization header is sent).

| method | returns |
|---|---|
| `studies({ filter, offset, limit })` | QIDO study rows, server-filtered and paged (`limit + 1` is asked, so the caller can tell the last page from a full one) |
| `series(studyUID)` | QIDO series rows of the study, description included |
| `instancesOf(studyUID, seriesUID)` | QIDO instance rows — for choosing a representative slice without pulling pixels |
| `retrieveInstance(studyUID, seriesUID, sopUID, signal?)` | one parsed instance |
| `retrieveSeries(studyUID, seriesUID, onInstance?, signal?)` | `{ instances, warnings }`; a per-instance refusal lands in `warnings`, never thrown away |

Every retrieve names `transfer-syntax=1.2.840.10008.1.2.1` (Explicit VR Little
Endian) in its Accept header: the viewer ships no image codec, so an origin that
cannot transcode answers **406 → `transcode_refused`**, and a compressed object that
slips through is refused per instance as `unsupported_transfer_syntax`. See the
viewer README's **Transfer syntax**.

## context

`api.context` — the open study, live (getters read state at access time).

| member | what it is |
|---|---|
| `studyUID` | the open study's UID, or null |
| `series` | the open study's series rows, as state holds them |

## notice

`api.notice(message, kind?)` — the shell's status bar. `kind` is `'warn'` (default:
interrupts) or `'info'` (waits for a pause). Plain strings: the status bar is not
translated, by design — the same rule as every shipped notice.
