'use client'

/** Triggers a browser download for in-memory text content.
 *  Shared by CSV export and CSV template download (DRY). */
export function downloadTextFile(fileName: string, text: string, mime = 'text/csv'): void {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
}
