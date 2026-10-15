// CSV parsing utilities — pure functions, no business logic, no I/O.
// Used by import features to turn an uploaded CSV document into rows and to
// decode the multi-step `steps` field. Quote handling follows RFC 4180:
// fields may be wrapped in double quotes and may contain commas, escaped
// quotes ("" ) and real line breaks. Lines whose FIRST cell starts with '#'
// are treated as comments (the import template ships its instructions that
// way) and are skipped.

/** One parsed CSV document as a matrix of raw cell strings. */
export type CsvMatrix = string[][]

/** Upper bound for one uploaded CSV document (1 MB of text is far more
 *  than the per-import row cap can produce, yet tiny for the server). */
export const MAX_CSV_BYTES = 1_000_000

/** Upper bound for data rows per import — keeps one request from mutating
 *  the DB for minutes and gives users a clear "split the file" message. */
export const MAX_IMPORT_ROWS = 200

/** Parses a whole CSV document into a matrix of cells.
 *  - Quote-aware (commas, "" escapes and newlines inside quotes are data).
 *  - Skips comment lines that start with '#' outside of quotes.
 *  - Tolerates CRLF and a trailing newline. */
export function parseCsvDocument(text: string): CsvMatrix {
  const matrix: CsvMatrix = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false

  const endCell = () => {
    row.push(cell)
    cell = ''
  }
  const endRow = () => {
    endCell()
    // Comment line: first cell starts with '#' and the line is not quoted.
    if (row[0].trimStart().startsWith('#')) {
      row = []
      return
    }
    // Skip completely empty lines (e.g. trailing newline), keep real rows.
    if (row.length === 1 && row[0].trim() === '') {
      row = []
      return
    }
    matrix.push(row)
    row = []
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        cell += ch
      }
      continue
    }

    if (ch === '"' && cell === '') {
      inQuotes = true
      continue
    }
    if (ch === ',') {
      endCell()
      continue
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      endRow()
      continue
    }
    cell += ch
  }
  // Flush the last row when the file does not end with a newline.
  if (cell !== '' || row.length > 0) endRow()
  return matrix
}

/** Splits a tag cell on `;` and `,`, trims, drops empties and de-duplicates. */
export function parseCsvTags(raw: string): string[] {
  const seen = new Set<string>()
  for (const tag of raw.split(/[;,]/)) {
    const t = tag.trim()
    if (t) seen.add(t)
  }
  return [...seen]
}
