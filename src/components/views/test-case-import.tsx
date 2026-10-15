'use client'

// Import Test Cases panel — the second tab of the Test Cases view.
// Flow: pick a module/submodule -> download the sample CSV -> fill it ->
// upload it -> see the per-row result. Visible ONLY to roles holding
// create_test_case (the view-level gate lives in test-cases.tsx; the API
// re-checks server-side via ensurePermission).

import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Upload, FileSpreadsheet, CheckCircle2, XCircle, ArrowRight, Info } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { REFERENCE_STALE_TIME_MS, modulesApi, testCasesApi } from '@/lib/client/api'
import { invalidateAfterMutation } from '@/lib/client/invalidate'
import { downloadTextFile } from '@/lib/client/download'
import { handleApiError } from '@/lib/errors'
import { toast } from 'sonner'
import type { ImportTestCasesResult } from '@/types'
import { QueryErrorAlert } from '@/components/shared/query-error'

/** Mirror of the server's MAX_CSV_BYTES (src/lib/server/csv.ts) — reject
 *  oversized files instantly in the browser instead of after an upload. */
const MAX_CSV_BYTES = 1_000_000

export function ImportTestCasesPanel({
  onImported,
}: {
  /** Called after a successful import so the parent can jump to the
   *  test-case list filtered by the imported module. */
  onImported: (moduleId: string) => void
}) {
  const qc = useQueryClient()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [moduleId, setModuleId] = useState('')
  const [fileName, setFileName] = useState('')
  const [csv, setCsv] = useState('')
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<ImportTestCasesResult | null>(null)

  const {
    data: treeData,
    isError: modulesError,
    refetch: modulesRefetch,
  } = useQuery({
    queryKey: ['modules', 'tree'],
    staleTime: REFERENCE_STALE_TIME_MS,
    queryFn: modulesApi.tree,
  })
  const flatModules = treeData?.flat ?? []

  async function downloadTemplate() {
    try {
      const template = await testCasesApi.importTemplate()
      downloadTextFile(template.fileName, template.csv)
      toast.success('Sample CSV downloaded — fill it and upload it back here')
    } catch (err) {
      handleApiError(err, 'Failed to download the sample CSV')
    }
  }

  async function handleFileChange(file: File | undefined) {
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.csv')) {
      toast.error('Only .csv files can be imported')
      return
    }
    if (file.size > MAX_CSV_BYTES) {
      toast.error(
        `File is too large (${Math.round(file.size / 1000)} KB). The limit is 1 MB — split it into smaller batches.`
      )
      return
    }
    const text = await file.text()
    if (!text.trim()) {
      toast.error('The selected file is empty')
      return
    }
    setFileName(file.name)
    setCsv(text)
    setResult(null)
    toast.info(`Loaded "${file.name}" — ready to import`)
  }

  async function handleImport() {
    if (!moduleId) {
      toast.error('Choose the module or submodule to import into')
      return
    }
    if (!csv) {
      toast.error('Choose a CSV file first')
      return
    }
    setImporting(true)
    try {
      const res = await testCasesApi.importCsv({ moduleId, fileName, csv })
      setResult(res)
      setCsv('')
      setFileName('')
      if (fileInputRef.current) fileInputRef.current.value = ''
      invalidateAfterMutation(qc, 'testCases')
      if (res.failed === 0) {
        toast.success(`Imported ${res.imported} test case${res.imported === 1 ? '' : 's'} into "${res.moduleName}"`)
      } else {
        toast.warning(`Imported ${res.imported}, failed ${res.failed} — check the details below`)
      }
    } catch (err) {
      handleApiError(err, 'Import failed')
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* How it works */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Info className="h-4 w-4 text-sky-600" /> How importing works
          </CardTitle>
          <CardDescription>
            Bulk-create draft test cases from a CSV file. Every imported case lands in the module you pick below.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
          <div className="rounded-md border bg-muted/30 p-3">
            <div className="font-medium mb-1 flex items-center gap-1.5"><Download className="h-3.5 w-3.5" /> 1. Download the sample</div>
            <p className="text-muted-foreground text-xs">It already contains the exact headings this website uses, plus example rows — title and description are the only required fields.</p>
          </div>
          <div className="rounded-md border bg-muted/30 p-3">
            <div className="font-medium mb-1 flex items-center gap-1.5"><FileSpreadsheet className="h-3.5 w-3.5" /> 2. Fill in your cases</div>
            <p className="text-muted-foreground text-xs">One test case per row. "title" and "description" are required; priority, expected result and tags are optional.</p>
          </div>
          <div className="rounded-md border bg-muted/30 p-3">
            <div className="font-medium mb-1 flex items-center gap-1.5"><Upload className="h-3.5 w-3.5" /> 3. Upload it here</div>
            <p className="text-muted-foreground text-xs">Pick the target module, upload, and the cases appear in that module as drafts.</p>
          </div>
        </CardContent>
      </Card>

      {/* Upload controls */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Import file</CardTitle>
          <CardDescription>The target module or submodule is required — every row of the file is imported into it.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {modulesError ? (
            <QueryErrorAlert
              title="Could not load the module list"
              message="You cannot pick a target module until it loads."
              onRetry={modulesRefetch}
            />
          ) : null}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Module or submodule *</Label>
              <Select value={moduleId} onValueChange={setModuleId}>
                <SelectTrigger><SelectValue placeholder="Choose where to import" /></SelectTrigger>
                <SelectContent>
                  {flatModules.map((m) => (
                    <SelectItem key={m.moduleId} value={m.moduleId}>
                      {'\u00A0'.repeat(m.depth * 2)}
                      {m.depth > 0 ? '↳ ' : ''}{m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>CSV file *</Label>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => handleFileChange(e.target.files?.[0])}
              />
              <Button variant="outline" className="w-full justify-start font-normal" onClick={() => fileInputRef.current?.click()}>
                <FileSpreadsheet className="h-4 w-4 mr-2 text-muted-foreground" />
                {fileName || 'Choose a .csv file...'}
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={downloadTemplate}>
              <Download className="h-4 w-4 mr-1" /> Download Sample CSV
            </Button>
            <Button onClick={handleImport} disabled={importing || !moduleId || !csv}>
              <Upload className="h-4 w-4 mr-1" /> {importing ? 'Importing...' : 'Upload & Import'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {result && <ImportResultCard result={result} onGoToModule={() => onImported(result.moduleId)} />}
    </div>
  )
}

/** Per-row outcome of the last import, with a shortcut to the target module. */
function ImportResultCard({
  result,
  onGoToModule,
}: {
  result: ImportTestCasesResult
  onGoToModule: () => void
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="text-base">Import result — "{result.moduleName}"</CardTitle>
          <CardDescription>{result.totalRows} rows processed from your file</CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Badge className="bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/25">
            <CheckCircle2 className="h-3 w-3 mr-1" /> {result.imported} imported
          </Badge>
          {result.failed > 0 && (
            <Badge variant="destructive">
              <XCircle className="h-3 w-3 mr-1" /> {result.failed} failed
            </Badge>
          )}
          {result.imported > 0 && (
            <Button size="sm" variant="outline" onClick={onGoToModule}>
              View in module <ArrowRight className="h-3.5 w-3.5 ml-1" />
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">Row</TableHead>
              <TableHead>Title</TableHead>
              <TableHead className="w-24">Status</TableHead>
              <TableHead>Detail</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.results.map((r) => (
              <TableRow key={r.row}>
                <TableCell className="font-mono text-xs text-muted-foreground">#{r.row}</TableCell>
                <TableCell className="font-medium max-w-xs truncate">{r.title}</TableCell>
                <TableCell>
                  {r.status === 'created' ? (
                    <Badge className="bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/25">created</Badge>
                  ) : (
                    <Badge variant="destructive">failed</Badge>
                  )}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {r.status === 'created' ? 'Draft test case created' : r.error}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
