/* =====================================================================================
 * TID 1500 measurement readout.
 *
 * WHY THE IMAGE LIBRARY IS SKIPPED
 * ---------------------------------
 * A Comprehensive 3D SR written by MedicalOS carries a full TID 1600 Image Library: one
 * NUM content item per geometric property per source frame. On a 64-slice study that is
 * several hundred NUM items -- rows, columns, pixel spacing, slice thickness, position and
 * orientation for every slice -- none of which is a measurement. Rendering them would bury
 * the six numbers a reader actually wants under three hundred they do not.
 *
 * So this reader walks the content tree and collects NUM items only from the
 * `Imaging Measurements` subtree. That is a display decision, and it is the kind of
 * decision that must be stated: this panel is NOT a complete rendering of the document. A
 * reader who needs the whole tree has the SR itself, which is what `MOS-IMG-157` checks a
 * foreign viewer against.
 *
 * NO UNITS ARE CONVERTED, EVER
 * -----------------------------
 * The value and the UCUM unit are displayed exactly as the document carries them. A viewer
 * that helpfully turned ml into cm3, or mm into cm, would be reporting a number the
 * document does not contain, and the SR is the record.
 *
 * Spec: MOS-IMG-157, MOS-CORE-004 (vocabulary), MOS-UI-008.
 * ===================================================================================== */

const T = {
  CONTENT_SEQUENCE: '0040a730',
  VALUE_TYPE: '0040a040',
  CONCEPT_NAME: '0040a043',
  CODE_MEANING: '00080104',
  CODE_VALUE: '00080100',
  MEASURED_VALUE: '0040a300',
  NUMERIC_VALUE: '0040a30a',
  UNITS: '004008ea',
};

/** Subtrees whose NUM items are geometry, not findings. */
const SKIP_SUBTREES = ['image library'];

/**
 * @returns {Array<{name:string, value:number, unit:string, path:string}>}
 */
export function readStructuredReport(instance) {
  const root = instance.dataset[T.CONTENT_SEQUENCE];
  if (!root) return [];

  const rows = [];
  walk(root, [], rows);
  return rows;
}

function conceptName(item) {
  return item[T.CONCEPT_NAME]?.[0]?.[T.CODE_MEANING] || '';
}

function walk(items, path, out) {
  for (const item of items) {
    const name = conceptName(item);
    const lowered = name.toLowerCase();
    if (SKIP_SUBTREES.some((s) => lowered.includes(s))) continue;

    if (item[T.VALUE_TYPE] === 'NUM') {
      const measured = item[T.MEASURED_VALUE]?.[0];
      const raw = measured?.[T.NUMERIC_VALUE];
      const value = Number(Array.isArray(raw) || typeof raw === 'object' ? raw?.[0] : raw);
      if (Number.isFinite(value)) {
        out.push({
          name: name || '(unnamed)',
          value,
          unit: measured?.[T.UNITS]?.[0]?.[T.CODE_VALUE] || '',
          path: path.join(' › '),
        });
      }
    }

    const children = item[T.CONTENT_SEQUENCE];
    if (children) walk(children, name ? [...path, name] : path, out);
  }
}
