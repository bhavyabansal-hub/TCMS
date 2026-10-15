// Route-level loading skeleton for every authenticated page.
// While Next fetches/compiles the target segment (most visible in dev mode),
// this renders INSTANTLY so page switches never feel like a dead click.
export default function AppLoading() {
  return (
    <div className="space-y-4 animate-in fade-in duration-150">
      <div className="space-y-2">
        <div className="h-7 w-44 rounded-md bg-muted animate-pulse" />
        <div className="h-4 w-64 rounded-md bg-muted/70 animate-pulse" />
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <div className="h-40 rounded-lg border bg-muted/40 animate-pulse md:col-span-2" />
        <div className="h-40 rounded-lg border bg-muted/40 animate-pulse" />
      </div>
      <div className="h-64 rounded-lg border bg-muted/30 animate-pulse" />
    </div>
  )
}
