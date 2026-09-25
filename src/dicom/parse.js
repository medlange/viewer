/* =====================================================================================
 * A DICOM Part 10 reader for EXPLICIT VR LITTLE ENDIAN, and for nothing else.
 *
 * WHY THE NARROWNESS IS THE POINT
 * --------------------------------
 * `docs/adr/BUILD_VS_ADOPT.md`'s Viewer row records that this viewer exists because
 * OHIF's delivered surface could not be bounded to MedicalOS's requirement without a
 * fork. A parser that accepted every transfer syntax would re-acquire that surface
 * immediately: JPEG2000, JPEG-LS and JPEG-Lossless each mean a third-party decoder --
 * OpenJPEG, CharLS, libjpeg-turbo -- which is 6.1 MB of WASM and three more SOUP items
 * under IEC 62304 section 8.1.2. That is the exact cost the row says we are avoiding.
 *
 * So this file DECODES NO IMAGE FORMAT. Uncompressed pixel data is a byte range; it is
 * handed to WebGL as a typed array and never touched by a codec. Measured on the live
 * archive on 2026-09-21, every CT, SEG, SR and RTSTRUCT object was Explicit VR Little
 * Endian, so the narrow reader is not a limitation today -- it is the whole requirement.
 *
 * WHEN THE ARCHIVE IS NOT UNCOMPRESSED
 * -------------------------------------
 * A hospital PACS will serve JPEG2000. The answer is NOT to add a decoder here. DICOMweb
 * lets a client name the transfer syntax it wants, and the MedicalOS Gateway
 * (`MOS-DATA-015`) is already the only route from this viewer to the archive. Transcoding
 * belongs there, in Orthanc, server-side, where it is one already-characterised dependency
 * instead of three new ones inside the clinician surface. `dicomweb.js` asks for
 * Explicit VR LE explicitly for that reason.
 *
 * REFUSAL, NOT APPROXIMATION
 * ---------------------------
 * `MOS-CORE-038` was reversed on the argument that this viewer stays small enough to
 * specify completely. A parser that guessed -- sniffed the VR, assumed implicit, fell
 * back to "probably little endian" -- would produce PIXELS THAT ARE WRONG rather than an
 * error, and a viewer that silently renders the wrong image is the failure mode the
 * reversal's counter-argument (register row, point 2) warns about. Every unsupported
 * input here throws `DicomRefusal` naming what it found and what it needed. Nothing in
 * this file ever falls back.
 *
 * Spec: MOS-CORE-038 (reversed at release 0.4.0), MOS-UI-009a (MOS-UI-009 withdrawn at
 * specification 0.3.0), MOS-DATA-015, MOS-REL-027.
 * ===================================================================================== */

/** Explicit VR Little Endian. The only dataset encoding this reader accepts. */
export const EXPLICIT_VR_LE = '1.2.840.10008.1.2.1';

/** Implicit VR LE -- named so the refusal can say what it was, not just that it failed. */
const IMPLICIT_VR_LE = '1.2.840.10008.1.2';

/** Transfer syntaxes we can name in a refusal. Naming beats "unsupported". */
const KNOWN_SYNTAXES = Object.freeze({
  [EXPLICIT_VR_LE]: 'Explicit VR Little Endian',
  [IMPLICIT_VR_LE]: 'Implicit VR Little Endian',
  '1.2.840.10008.1.2.2': 'Explicit VR Big Endian',
  '1.2.840.10008.1.2.4.50': 'JPEG Baseline (Process 1)',
  '1.2.840.10008.1.2.4.51': 'JPEG Extended (Process 2 & 4)',
  '1.2.840.10008.1.2.4.57': 'JPEG Lossless (Process 14)',
  '1.2.840.10008.1.2.4.70': 'JPEG Lossless (Process 14, SV1)',
  '1.2.840.10008.1.2.4.80': 'JPEG-LS Lossless',
  '1.2.840.10008.1.2.4.81': 'JPEG-LS Near-Lossless',
  '1.2.840.10008.1.2.4.90': 'JPEG 2000 Lossless',
  '1.2.840.10008.1.2.4.91': 'JPEG 2000',
  '1.2.840.10008.1.2.5': 'RLE Lossless',
});

/**
 * A refusal, not a bug. Carries the machine-readable `reason` so a surface can render it
 * the way `MOS-SAFE-089a` requires a REJECTED job to be rendered: distinctly, and with the
 * reason verbatim rather than paraphrased.
 */
export class DicomRefusal extends Error {
  constructor(reason, detail) {
    super(detail);
    this.name = 'DicomRefusal';
    this.reason = reason;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------------------
 * VR tables
 *
 * PS3.5 section 7.1.2: these six VRs carry a 2-byte reserved field and a 4-byte length.
 * Everything else carries a 2-byte length. Getting this wrong does not throw -- it walks
 * the parser off by two bytes and produces plausible garbage for the rest of the object,
 * which is why the set is written out rather than computed.
 * ----------------------------------------------------------------------------------- */
const LONG_FORM_VRS = new Set(['OB', 'OW', 'OF', 'OD', 'OL', 'OV', 'SQ', 'UT', 'OW', 'UN', 'OB']);

/** VRs whose value is text. Everything else is read as bytes or numbers. */
const TEXT_VRS = new Set([
  'AE', 'AS', 'CS', 'DA', 'DS', 'DT', 'IS', 'LO', 'LT',
  'PN', 'SH', 'ST', 'TM', 'UC', 'UI', 'UR', 'UT',
]);

/** Numeric VRs: [TypedArray, bytes per element]. */
const NUMERIC_VRS = Object.freeze({
  US: [Uint16Array, 2], SS: [Int16Array, 2],
  UL: [Uint32Array, 4], SL: [Int32Array, 4],
  FL: [Float32Array, 4], FD: [Float64Array, 8],
});

const textDecoder = new TextDecoder('latin1');

/**
 * `(group,element)` as the lowercase 8-hex string used as a key throughout.
 *
 * ARITHMETIC, NOT BITWISE, AND THE REASON IS A BUG THIS ALREADY HAD.
 * The obvious form is `(group << 16 >>> 0 | element)`. It is wrong for every group with
 * the high bit set, because `|` coerces its result back to a SIGNED 32-bit integer: for
 * the item tag (FFFE,E000) it yields -73728, whose `.toString(16)` is "-12000", so no
 * sequence item is ever recognised and every SQ parses to an empty array. Pixel data
 * (7FE0,0010) stays positive, so images render perfectly while SEG and SR come back
 * empty -- a failure that looks like missing data rather than a parser defect.
 * Multiplying keeps the value in the float domain where it is never truncated.
 */
export function tag(group, element) {
  return (group * 0x10000 + element).toString(16).padStart(8, '0');
}

/* -------------------------------------------------------------------------------------
 * The reader
 * ----------------------------------------------------------------------------------- */

class Cursor {
  constructor(view, offset, end) {
    this.view = view;
    this.offset = offset;
    this.end = end;
  }
  get done() { return this.offset >= this.end; }
  u16() { const v = this.view.getUint16(this.offset, true); this.offset += 2; return v; }
  u32() { const v = this.view.getUint32(this.offset, true); this.offset += 4; return v; }
  ascii(n) {
    const s = textDecoder.decode(new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, n));
    this.offset += n;
    return s;
  }
}

/**
 * Read one element header. Returns `{tagKey, vr, length, valueOffset}`.
 *
 * `length === 0xFFFFFFFF` is "undefined length" and is legal for SQ and for encapsulated
 * pixel data. The caller decides what that means; this function only reports it.
 */
function readElementHeader(c) {
  const group = c.u16();
  const element = c.u16();
  const tagKey = tag(group, element);

  // PS3.5 7.5: items and delimiters carry no VR, in any encoding.
  if (group === 0xfffe) {
    const length = c.u32();
    return { tagKey, vr: null, length, valueOffset: c.offset };
  }

  const vr = c.ascii(2);
  let length;
  if (LONG_FORM_VRS.has(vr)) {
    c.offset += 2;               // reserved
    length = c.u32();
  } else {
    length = c.u16();
  }
  return { tagKey, vr, length, valueOffset: c.offset };
}

function readValue(c, vr, length, view) {
  const abs = view.byteOffset + c.offset;

  if (TEXT_VRS.has(vr)) {
    const raw = textDecoder.decode(new Uint8Array(view.buffer, abs, length));
    // PS3.5 6.2: values are padded to even length with a space or, for UI, a NUL.
    return raw.replace(/[\0 ]+$/, '');
  }

  const numeric = NUMERIC_VRS[vr];
  if (numeric) {
    const [Arr, size] = numeric;
    const n = Math.floor(length / size);
    // A DataView's byteOffset is not guaranteed aligned for a typed-array view, so copy.
    const out = new Arr(n);
    for (let i = 0; i < n; i++) {
      const o = c.offset + i * size;
      out[i] = Arr === Uint16Array ? view.getUint16(o, true)
        : Arr === Int16Array ? view.getInt16(o, true)
        : Arr === Uint32Array ? view.getUint32(o, true)
        : Arr === Int32Array ? view.getInt32(o, true)
        : Arr === Float32Array ? view.getFloat32(o, true)
        : view.getFloat64(o, true);
    }
    return n === 1 ? out[0] : out;
  }

  // OB/OW/UN/unknown: hand back the byte range without copying. Pixel data lands here,
  // and copying a 512x512x16-bit frame per access is the difference between a viewer
  // that scrolls and one that stutters.
  return new Uint8Array(view.buffer, abs, length);
}

/**
 * Parse a dataset between `[offset, end)` into a flat `{tagKey: value}` map.
 * Sequences become arrays of nested maps.
 */
function parseDataset(view, offset, end, depth = 0) {
  if (depth > 8) {
    throw new DicomRefusal('sequence_too_deep', 'nesting exceeded 8 levels; refusing to recurse further');
  }
  const out = {};
  const c = new Cursor(view, offset, end);

  while (!c.done) {
    if (c.end - c.offset < 8) break;
    const { tagKey, vr, length, valueOffset } = readElementHeader(c);

    // Sequence delimiter closes an undefined-length parent.
    if (tagKey === 'fffee0dd' || tagKey === 'fffee00d') break;

    if (vr === 'SQ' || (vr === null && tagKey === 'fffee000')) {
      const undefinedLength = length === 0xffffffff;
      const stop = undefinedLength ? c.end : valueOffset + length;
      if (vr === 'SQ') {
        out[tagKey] = parseSequence(view, valueOffset, stop, depth + 1, undefinedLength);
        if (!undefinedLength) { c.offset = stop; continue; }
        // Undefined length: parseSequence reports where it stopped.
        c.offset = out[tagKey].__end;
        delete out[tagKey].__end;
        continue;
      }
    }

    if (length === 0xffffffff) {
      // Encapsulated pixel data. This reader accepts no compressed syntax, so reaching
      // here means the dataset lied about its transfer syntax or we were handed a
      // fragmented object. Refuse rather than return a fragment table as an image.
      throw new DicomRefusal(
        'encapsulated_pixel_data',
        `element ${tagKey} has undefined length, which means encapsulated (compressed) ` +
        `pixel data. This reader accepts uncompressed Explicit VR Little Endian only; ` +
        `transcode at the Gateway.`,
      );
    }

    out[tagKey] = readValue(c, vr, length, view);
    c.offset = valueOffset + length;
  }
  return out;
}

function parseSequence(view, offset, end, depth, undefinedLength) {
  const items = [];
  const c = new Cursor(view, offset, end);
  while (!c.done) {
    if (c.end - c.offset < 8) break;
    const start = c.offset;
    const { tagKey, length, valueOffset } = readElementHeader(c);
    if (tagKey === 'fffee0dd') { c.offset = valueOffset; break; }  // sequence delimiter
    if (tagKey !== 'fffee000') { c.offset = start; break; }        // not an item: done
    const itemEnd = length === 0xffffffff ? c.end : valueOffset + length;
    items.push(parseDataset(view, valueOffset, itemEnd, depth));
    if (length === 0xffffffff) {
      // Walk to the item delimiter.
      let p = valueOffset;
      while (p < c.end - 8) {
        if (view.getUint16(p, true) === 0xfffe && view.getUint16(p + 2, true) === 0xe00d) { p += 8; break; }
        p += 2;
      }
      c.offset = p;
    } else {
      c.offset = itemEnd;
    }
  }
  if (undefinedLength) items.__end = c.offset;
  return items;
}

/**
 * Read a DICOM Part 10 byte buffer.
 *
 * Returns `{meta, dataset, transferSyntax}`. Throws `DicomRefusal` for anything this
 * reader will not handle, always naming what it found.
 */
export function readPart10(buffer) {
  const bytes = new Uint8Array(buffer);

  // PS3.10 7.1: 128-byte preamble then 'DICM'. Some archives omit the preamble; accept
  // both, but require the magic -- without it this is not a Part 10 file and guessing is
  // how you end up rendering a JPEG's header as CT.
  let start;
  if (bytes.length > 132 && String.fromCharCode(bytes[128], bytes[129], bytes[130], bytes[131]) === 'DICM') {
    start = 132;
  } else if (bytes.length > 4 && String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === 'DICM') {
    start = 4;
  } else {
    throw new DicomRefusal('not_part10', "no 'DICM' magic at offset 0 or 128; this is not a DICOM Part 10 object");
  }

  const view = new DataView(buffer);

  // The file meta group is ALWAYS Explicit VR LE (PS3.10 7.1), whatever the dataset is.
  // Read its length first so we know exactly where the dataset begins.
  const probe = new Cursor(view, start, bytes.length);
  const first = readElementHeader(probe);
  if (first.tagKey !== '00020000') {
    throw new DicomRefusal('no_file_meta', `expected (0002,0000) FileMetaInformationGroupLength, found ${first.tagKey}`);
  }
  const groupLength = view.getUint32(first.valueOffset, true);
  const metaEnd = first.valueOffset + first.length + groupLength;
  const meta = parseDataset(view, start, metaEnd);

  const transferSyntax = meta['00020010'] || EXPLICIT_VR_LE;
  if (transferSyntax !== EXPLICIT_VR_LE) {
    const name = KNOWN_SYNTAXES[transferSyntax] || 'an unrecognised transfer syntax';
    throw new DicomRefusal(
      'unsupported_transfer_syntax',
      `the object is ${name} (${transferSyntax}). This viewer reads Explicit VR Little ` +
      `Endian (${EXPLICIT_VR_LE}) only, by design: see the Viewer row of ` +
      `docs/adr/BUILD_VS_ADOPT.md. Ask the Gateway to transcode.`,
    );
  }

  return { meta, dataset: parseDataset(view, metaEnd, bytes.length), transferSyntax };
}
