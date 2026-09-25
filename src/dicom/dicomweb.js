/* =====================================================================================
 * The DICOMweb client. The viewer's ONLY route to pixels, and it goes through the Gateway.
 *
 * MOS-UI-002, on what this file may not do, verbatim:
 *   "[neither surface may] address the PACS, hold a PACS credential, or resolve a PACS
 *    network address"
 * So there is no Orthanc host here, no DIMSE, and no second base URL. `root` is the
 * Gateway's tenant-scoped DICOMweb prefix and nothing else. Chapter 14's AT-08 plane P4
 * asserts a TCP connect from this container to the PACS is refused; this file is written
 * so that assertion stays true by construction rather than by firewall alone.
 *
 * THE TRANSFER-SYNTAX REQUEST IS LOAD-BEARING
 * --------------------------------------------
 * Every retrieve names `transfer-syntax=1.2.840.10008.1.2.1` in its Accept header. That is
 * not a formality: it is the mechanism by which this viewer avoids shipping an image
 * codec at all. PS3.18 6.1.1.8 requires a DICOMweb origin server to honour an explicit
 * transfer-syntax request or answer 406; Orthanc transcodes. So the decoder that a
 * compressed archive needs lives in the Gateway -- one dependency already characterised
 * under IEC 62304 section 8.1.2 -- instead of three new WASM ones inside the clinician
 * surface. The Viewer row of docs/adr/BUILD_VS_ADOPT.md rests on this working.
 *
 * If the origin refuses, `retrieveSeries` says so in those terms rather than falling back,
 * because a silent fallback to a compressed syntax would land in `parse.js`'s refusal with
 * a much less useful message.
 *
 * Spec: MOS-UI-002, MOS-DATA-015, MOS-UI-005, MOS-SAFE-089a.
 * ===================================================================================== */

import { DicomRefusal, readPart10 } from './parse.js';

const UNCOMPRESSED = '1.2.840.10008.1.2.1';

/**
 * THE SURFACE HEADER IS A HOST'S, NOT A VIEWER'S.
 *
 * `X-MedicalOS-Surface: clinical_viewer` is how the Gateway knows which consumer class is
 * asking, which is what makes `MOS-UI-005`'s closed value space and `MOS-DATA-040`'s
 * `pixel_phi.action: ALLOW` -- "only when the consumer class is clinical_viewer" --
 * checkable at the origin rather than trusted.
 *
 * None of that is DICOMweb. A conformant origin that is not the MedicalOS Gateway has no
 * idea what this header means, and a viewer that always sends it is a viewer with one
 * deployment's vocabulary compiled in. So it is CONFIGURED: an extension that needs the
 * header names it, and a viewer pointed at a plain archive sends none.
 *
 * ABSENT MEANS ABSENT, not a default. Sending a consumer class to an origin that has not
 * been told what this surface is would be asserting something nobody granted.
 *
 * THE NAME COMES FROM CONFIGURATION TOO, and that is not fastidiousness. A constant here
 * spelling one vendor's header is the same defect as a constant spelling one vendor's
 * value, one step quieter -- it says this viewer knows which platform it belongs to. A
 * gate caught exactly that: the value had moved out and the name had not.

/**
 * Study-level attributes asked for beyond QIDO's required minimum.
 *
 * (0008,1030) StudyDescription, (0008,0050) AccessionNumber, (0008,0060) Modality. Keyword
 * form would be friendlier to read and is NOT used: PS3.18 6.7.1.1 allows either, and an
 * origin that does not recognise a keyword answers with the attribute missing rather than
 * with an error -- which is the same silence this list already had. Tag form is what every
 * conformant origin resolves.
 *
 * (0010,0020) PatientID AND (0008,0020) StudyDate ARE ASKED FOR EXPLICITLY although PS3.18
 * Table 6.7.1-2 already requires an origin to return both at study level. The prior list
 * pairs two studies on PatientID and orders them by StudyDate, and "the standard says it
 * comes back anyway" is the kind of assumption that fails on one origin, quietly, in the
 * one place where a missing id would make two studies look unpairable -- or, worse, make a
 * blank id equal to another blank id. `samePatient` refuses an empty id for that reason;
 * asking for the attribute is the other half of the same care.
 */
const STUDY_FIELDS = ['00081030', '00080050', '00080060', '00100020', '00080020'];

/**
 * (0008,103E) SeriesDescription, (0008,0060) Modality, (0020,0011) SeriesNumber,
 * (0020,1209) NumberOfSeriesRelatedInstances -- the Instances column of the study
 * row's sub-table, and the count the series rail shows before anything is loaded.
 */
const SERIES_FIELDS = [
  '0008103E', '00080060', '00200011', '00201209',
  // STUDY-LEVEL ATTRIBUTES, ASKED FOR AT SERIES LEVEL ON PURPOSE. The viewer can be
  // reached without passing through the study list -- a deep link, a reload, a hand-typed
  // UID -- and the patient banner has to be right on all of those paths. QIDO returns
  // study attributes on a series query when they are asked for, so this is one round trip
  // rather than a second query whose failure mode is a banner with no name in it.
  '00100010', '00100020', '00081030', '00080020', '00080030', '00080050',
];

export class DicomWebClient {
  /**
   * @param {object} o
   * @param {string} o.root  Gateway DICOMweb prefix, e.g. `/dicomweb/<tenant>`.
   * @param {() => (string|null)} [o.authHeaderProvider] the operator's own credential.
   *        A callback, re-read per request, never stored -- same contract as
   *        `MedicalOSClient`. Returning null sends no Authorization header at all, which
   *        is correct when the proxy supplies one.
   * @param {string} [o.surfaceHeader]  the header a host reads its consumer class from.
   * @param {string} [o.surface]  the class to declare in it. BOTH or NEITHER: a name with
   *        no value is a blank assertion and a value with no name has nowhere to go.
   */
  constructor({ root, authHeaderProvider = () => null, surfaceHeader = null, surface = null }) {
    if (!root) throw new Error('DicomWebClient needs a DICOMweb root');
    this.root = root.replace(/\/+$/, '');
    this.authHeaderProvider = authHeaderProvider;
    this.surfaceHeader = surfaceHeader && surface ? String(surfaceHeader) : null;
    this.surface = this.surfaceHeader ? String(surface) : null;
  }

  #headers(accept) {
    const h = { Accept: accept };
    if (this.surfaceHeader) h[this.surfaceHeader] = this.surface;
    const auth = this.authHeaderProvider();
    if (auth) h.Authorization = auth;
    return h;
  }

  async #json(path) {
    const res = await fetch(`${this.root}${path}`, { headers: this.#headers('application/dicom+json') });
    if (res.status === 204) return [];
    if (!res.ok) throw new DicomRefusal('dicomweb_error', `${res.status} ${res.statusText} for ${path}`);
    return res.json();
  }

  /**
   * QIDO: studies visible to this credential.
   *
   * `includefield` IS NOT OPTIONAL POLISH. PS3.18 10.6.1.5 makes the study-level return
   * set a small required minimum plus whatever the server chooses, and StudyDescription is
   * not in the minimum. This archive does not volunteer it, so `showStudies` -- which has
   * rendered `00081030` since it was written -- drew an empty span for every row, and the
   * study list distinguished studies by patient name, date and instance count alone.
   *
   * FOUND WITH TWO ROWS THAT WERE THE SAME ROW. The demo corpus's phantom and its
   * `--companion` study share a patient, a date and a modality by construction, because
   * they are two acquisitions of one patient -- which is the whole point of the companion.
   * In the picker they came out as two identical lines differing only in `64 inst` against
   * `40 inst`, and a reader choosing between them had nothing to choose on. That is a
   * synthetic pair, but the arrangement is not: a CT and its delayed phase, or a study read
   * twice, are the same shape and far more common.
   *
   * AccessionNumber goes with it for the same reason -- it is what a reader is given on
   * paper and the one identifier they can match against a worklist.
   */
  /**
   * QIDO: studies visible to this credential, matching `filter`.
   *
   * SERVER-SIDE, and that is the whole point. This took no match keys, no `limit` and no
   * `offset` -- it asked for EVERY study the credential could see and rendered the lot
   * into un-virtualised markup. On a developer archive of five that is invisible; on a
   * real one it is either silently truncated by whatever the origin caps at, or it is not
   * truncated and the surface dies. A worklist that cannot ask a question of the archive
   * is a list, and a list is not how anyone finds a study.
   *
   * `filter` keys are DICOM keywords, which PS3.18 6.7.1.1 accepts as match keys beside
   * tags. A wildcard is the caller's to add: `PatientName: 'SMITH*'` matches, `'SMITH'`
   * does not, and pretending otherwise would make an exact search impossible to express.
   *
   * `limit` is asked for ONE HIGHER than the page, so the caller can tell "this is the
   * last page" from "this page is exactly full" -- QIDO returns no total, so the only
   * honest way to know there is more is to ask for one more.
   */
  studies({ filter = {}, offset = 0, limit = 50 } = {}) {
    const q = new URLSearchParams();
    q.set('includefield', STUDY_FIELDS.join(','));
    for (const [key, value] of Object.entries(filter)) {
      if (value !== undefined && value !== null && String(value).trim() !== '') {
        q.set(key, String(value).trim());
      }
    }
    q.set('limit', String(limit + 1));
    if (offset) q.set('offset', String(offset));
    return this.#json(`/studies?${q}`);
  }

  /** QIDO: series of one study, with the description the panel header shows. */
  series(studyUID) {
    return this.#json(`/studies/${studyUID}/series?includefield=${SERIES_FIELDS.join(',')}`);
  }

  /**
   * WADO-RS: every instance of one series, parsed.
   *
   * Returns `{instances, warnings}`. An instance that refuses individually does NOT fail
   * the series -- a study with one bad frame should still display the other 63 -- but the
   * refusal is carried out in `warnings` so the surface can render it. Dropping it
   * silently would be the "wrong pixels without an error" failure `parse.js` exists to
   * prevent, one level up.
   */
  /**
   * QIDO: the instances of one series, for choosing a representative slice.
   *
   * Separate from `retrieveSeries` because the answer is a few kilobytes of JSON and
   * the series itself is tens of megabytes of pixels. A thumbnail that had to pull the
   * whole series to show one slice would cost as much as opening it, which is the
   * reason the series list had no thumbnails in the first place.
   */
  async instancesOf(studyUID, seriesUID) {
    return this.#json(`/studies/${studyUID}/series/${seriesUID}/instances` + '?includefield=00200013');
  }

  /**
   * WADO-RS: ONE instance, parsed.
   *
   * MEASURED on a lumbar MR series: 707 KB for the single instance against 7.8 MB for
   * the eleven-slice series -- about 9%. Eight series of thumbnails therefore cost
   * less than opening one series, which is what makes painting them all on study load
   * affordable.
   */
  async retrieveInstance(studyUID, seriesUID, sopUID, signal = null) {
    const accept = `multipart/related; type="application/dicom"; transfer-syntax=${UNCOMPRESSED}`;
    const res = await fetch(
      `${this.root}/studies/${studyUID}/series/${seriesUID}/instances/${sopUID}`,
      { headers: this.#headers(accept), signal },
    );
    if (!res.ok) {
      throw new DicomRefusal('dicomweb_error',
        `${res.status} ${res.statusText} retrieving instance ${sopUID}`);
    }
    const boundary = boundaryOf(res.headers.get('Content-Type') || '');
    const parts = splitMultipart(new Uint8Array(await res.arrayBuffer()), boundary);
    if (!parts.length) throw new DicomRefusal('parse_failed', 'no part in the response');
    return readPart10(parts[0].slice().buffer);
  }

  async retrieveSeries(studyUID, seriesUID, onInstance = null, signal = null) {
    const accept = `multipart/related; type="application/dicom"; transfer-syntax=${UNCOMPRESSED}`;
    // `signal` matters more here than on a normal fetch: this response is tens of
    // megabytes and is consumed incrementally, so an abandoned series keeps arriving,
    // keeps parsing and keeps calling back long after the reader has moved on.
    const res = await fetch(`${this.root}/studies/${studyUID}/series/${seriesUID}`, {
      headers: this.#headers(accept), signal,
    });

    if (res.status === 406) {
      throw new DicomRefusal(
        'transcode_refused',
        `the Gateway answered 406 for transfer-syntax=${UNCOMPRESSED}. This viewer ships no ` +
        `image codec on purpose (see the Viewer row of docs/adr/BUILD_VS_ADOPT.md); the ` +
        `archive must be able to serve or transcode to uncompressed. Enable transcoding in ` +
        `Orthanc rather than adding a decoder here.`,
      );
    }
    if (!res.ok) {
      throw new DicomRefusal('dicomweb_error', `${res.status} ${res.statusText} retrieving series ${seriesUID}`);
    }

    const boundary = boundaryOf(res.headers.get('Content-Type') || '');
    const instances = [];
    const warnings = [];

    const take = (part) => {
      try {
        // `part` is a view into a chunk buffer; readPart10 needs its own aligned
        // ArrayBuffer because it constructs a DataView at offset 0.
        const instance = readPart10(part.slice().buffer);
        instances.push(instance);
        // The accumulating array is passed EXPLICITLY as the third argument rather than
        // left for the caller to close over. A caller writing
        //     const { instances } = await retrieveSeries(..., () => use(instances))
        // captures `instances` in its temporal dead zone: the callback fires during the
        // await, before the destructuring binds it, and every call throws ReferenceError.
        // That is exactly the bug this signature prevents, and it was a real one -- it
        // silently disabled progressive rendering while looking like it worked.
        if (onInstance) onInstance(instance, instances.length, instances);
      } catch (err) {
        warnings.push(err instanceof DicomRefusal ? { reason: err.reason, detail: err.detail }
          : { reason: 'parse_failed', detail: String(err && err.message) });
      }
    };

    // STREAMING, AND THE REASON IT IS WORTH THE COMPLEXITY.
    // The one-shot form is `await res.arrayBuffer()` then split. It is four lines and it
    // means NOTHING reaches the screen until the last byte of the last slice arrives --
    // measured at 81.4 MB for a 148-slice study, because the archive is uncompressed by
    // design (see parse.js). A reader stares at an empty viewport for the whole transfer.
    // Reading the body incrementally lets the first slice render while the rest is still
    // in flight, which is the single largest perceived-performance difference between this
    // viewer and the incumbent, and it costs one scanner and no dependency.
    if (res.body && res.body.getReader) {
      for await (const part of streamMultipart(res.body.getReader(), boundary)) take(part);
    } else {
      // No streams (old browser, or a polyfilled fetch): same result, later.
      for (const part of splitMultipart(new Uint8Array(await res.arrayBuffer()), boundary)) take(part);
    }
    return { instances, warnings };
  }
}

/**
 * Yield each `application/dicom` part as it completes, from a ReadableStream reader.
 *
 * A part is complete only once the NEXT delimiter has been seen, so this always runs one
 * part behind the network -- which is correct and unavoidable: the length is not declared,
 * the delimiter is the only terminator, and guessing from Content-Length would be wrong for
 * the last part.
 *
 * The buffer is compacted after every emit so peak memory is one part plus one chunk, not
 * the whole series.
 */
async function* streamMultipart(reader, boundary) {
  const delim = ascii(`--${boundary}`);
  const headerEnd = ascii('\r\n\r\n');

  let buf = new Uint8Array(0);
  let bodyStart = -1;      // start of the current part's payload, or -1 while seeking
  let scanned = 0;         // how far we have searched for the terminating delimiter
  let done = false;

  const append = (chunk) => {
    const next = new Uint8Array(buf.length + chunk.length);
    next.set(buf, 0);
    next.set(chunk, buf.length);
    buf = next;
  };

  while (!done) {
    const { value, done: finished } = await reader.read();
    done = finished;
    if (value) append(value);

    for (;;) {
      if (bodyStart === -1) {
        const d = indexOfBytes(buf, delim, 0);
        if (d === -1) break;
        if (buf[d + delim.length] === 0x2d && buf[d + delim.length + 1] === 0x2d) return; // closing
        const h = indexOfBytes(buf, headerEnd, d + delim.length);
        if (h === -1) break;
        bodyStart = h + headerEnd.length;
        scanned = bodyStart;
        continue;
      }

      // Overlap the search window by delim.length-1 so a delimiter split across two chunks
      // is still found.
      const at = indexOfBytes(buf, delim, Math.max(bodyStart, scanned - delim.length));
      if (at === -1) {
        scanned = Math.max(bodyStart, buf.length - delim.length);
        break;
      }
      yield buf.subarray(bodyStart, at - 2);      // the CRLF before the delimiter is not payload
      buf = buf.subarray(at);                     // compact: drop everything consumed
      bodyStart = -1;
      scanned = 0;
    }
  }
}

/* -------------------------------------------------------------------------------------
 * multipart/related
 *
 * Written out rather than pulled in, because every library that does this is either a
 * Node stream API or brings a dependency, and the whole format is a boundary string and
 * a blank line. PS3.18 8.6.
 * ----------------------------------------------------------------------------------- */

function boundaryOf(contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) throw new DicomRefusal('no_multipart_boundary', `Content-Type carried no boundary: ${contentType}`);
  return (m[1] || m[2]).trim();
}

/** Byte-exact search; the payload is binary and must never be decoded to a string. */
function indexOfBytes(haystack, needle, from = 0) {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

const ascii = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

function splitMultipart(bytes, boundary) {
  const delim = ascii(`--${boundary}`);
  const headerEnd = ascii('\r\n\r\n');
  const parts = [];

  let pos = indexOfBytes(bytes, delim, 0);
  while (pos !== -1) {
    const afterDelim = pos + delim.length;
    // Closing delimiter is `--boundary--`.
    if (bytes[afterDelim] === 0x2d && bytes[afterDelim + 1] === 0x2d) break;

    const bodyStart = indexOfBytes(bytes, headerEnd, afterDelim);
    if (bodyStart === -1) break;

    const next = indexOfBytes(bytes, delim, bodyStart + headerEnd.length);
    // Trailing CRLF before the next delimiter belongs to the delimiter, not the body.
    const bodyEnd = (next === -1 ? bytes.length : next) - 2;
    parts.push(bytes.subarray(bodyStart + headerEnd.length, bodyEnd));
    pos = next;
  }
  return parts;
}
