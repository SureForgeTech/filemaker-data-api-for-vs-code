// Pure result-table transformations, kept separate from DOM rendering.
/* global module */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else /** @type {any} */ (root).QueryResultModel = api;
})(typeof self !== 'undefined' ? self : this, function () {
  /** @typedef {Record<string, unknown> & { recordId?: unknown, fieldData?: Record<string, unknown> }} QueryRecord */
  /** @typedef {{ column: string, direction: 'ascending' | 'descending' }} ResultSort */
  const US_DATE_PATTERN = /^\d{1,2}\/\d{1,2}\/\d{4}(?: \d{1,2}:\d{2}(?::\d{2})?)?$/;

  /** @param {unknown} value */
  function toCellValue(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
    try { return JSON.stringify(value); } catch { return String(value); }
  }

  /** @param {QueryRecord} record @param {string} column */
  function getCellRaw(record, column) {
    if (column === 'recordId') return record.recordId;
    const data = record.fieldData && typeof record.fieldData === 'object' ? record.fieldData : {};
    return data[column];
  }

  /** @param {unknown} left @param {unknown} right @param {Intl.Collator} collator */
  function compareCells(left, right, collator) {
    if (typeof left === 'number' && typeof right === 'number') return left - right;
    if (typeof left === 'string' && typeof right === 'string' && US_DATE_PATTERN.test(left) && US_DATE_PATTERN.test(right)) {
      const leftTime = Date.parse(left);
      const rightTime = Date.parse(right);
      if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime - rightTime;
    }
    return collator.compare(toCellValue(left), toCellValue(right));
  }

  /** @param {QueryRecord[]} records @param {ResultSort | undefined} sort */
  function sortRecords(records, sort) {
    if (!sort) return records;
    const factor = sort.direction === 'descending' ? -1 : 1;
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    return records.map((record, index) => ({ record, index })).sort((a, b) => {
      const left = getCellRaw(a.record, sort.column);
      const right = getCellRaw(b.record, sort.column);
      const leftEmpty = left === undefined || left === null || left === '';
      const rightEmpty = right === undefined || right === null || right === '';
      if (leftEmpty !== rightEmpty) return leftEmpty ? 1 : -1;
      const compared = compareCells(left, right, collator);
      return compared === 0 ? a.index - b.index : compared * factor;
    }).map(({ record }) => record);
  }

  return { compareCells, getCellRaw, sortRecords, toCellValue };
});
