// Spreadsheet formula protection for text the Query Builder copies out as a table.
// Loaded as a classic script in the webview (exposes window.CellText) and required by unit
// tests. It must stay behaviourally identical to `neutralizeFormula` in src/utils/exportCsv.ts
// (the CSV export); test/unit/queryBuilderCellText.test.ts compares the two.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.CellText = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const PLAIN_NUMBER = /^[-+]?(\d+(?:\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;
  // Signed numbers and phone numbers such as `-1,234.5` or `+1 (555) 123-4567`.
  const NUMBER_OR_PHONE = /^[-+][\d\s().,/-]*$/;

  /**
   * A spreadsheet runs a cell that starts with `=`, `+`, `-`, `@`, tab or carriage return
   * as a formula. Prefix such text with an apostrophe, which spreadsheets read as "text".
   * Plain numbers and phone numbers are left alone.
   */
  function neutralizeFormula(text) {
    if (!/^'*[=+\-@\t\r]/.test(text) || PLAIN_NUMBER.test(text) || (NUMBER_OR_PHONE.test(text) && /\d/.test(text))) {
      return text;
    }

    return `'${text}`;
  }

  return { neutralizeFormula };
});
