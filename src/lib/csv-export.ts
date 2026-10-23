// CSV export helpers shared by every export (test cases, bugs, work logs) — backlog B6.
// Pure functions (no browser or Node APIs) so the exports and scripts/verify-csv-export.mjs
// use the exact same code.
//
// - Every cell is RFC-4180 quoted (commas, quotes and newlines inside a value are safe).
// - Formula injection (OWASP "CSV Injection"): a cell whose first non-blank character is
//   = + - @ or that starts with TAB / CR is prefixed with an apostrophe, so Excel,
//   LibreOffice and Google Sheets show it as text instead of executing it.

const FORMULA_START = /^\s*[=+\-@]|^[\t\r]/

/** One quoted, formula-safe CSV cell. */
export function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value)
  const safe = FORMULA_START.test(text) ? `'${text}` : text
  return `"${safe.replace(/"/g, '""')}"`
}

/** Full CSV document (header row + data rows), CRLF-free `\n` line endings. */
export function toCsv(rows: unknown[][]): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\n')
}
