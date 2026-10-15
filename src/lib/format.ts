import type { TestCaseStatus, Priority, BugStatus, Severity, Verdict, Role } from '@/types'

export function statusColor(status: TestCaseStatus): string {
  const map: Record<TestCaseStatus, string> = {
    draft: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-400/15 dark:text-slate-300 dark:border-slate-400/20',
    in_review: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/25',
    needs_revision: 'bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-500/15 dark:text-orange-300 dark:border-orange-500/25',
    approved: 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/25',
    active: 'bg-green-100 text-green-700 border-green-200 dark:bg-green-500/15 dark:text-green-300 dark:border-green-500/25',
    deprecated: 'bg-zinc-200 text-zinc-600 border-zinc-300 dark:bg-zinc-500/20 dark:text-zinc-300 dark:border-zinc-500/25',
  }
  return map[status] ?? 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-400/15 dark:text-slate-300 dark:border-slate-400/20'
}

export function priorityColor(priority: Priority): string {
  const map: Record<Priority, string> = {
    P0: 'bg-red-100 text-red-700 border-red-200 dark:bg-red-500/15 dark:text-red-300 dark:border-red-500/25',
    P1: 'bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-500/15 dark:text-orange-300 dark:border-orange-500/25',
    P2: 'bg-yellow-100 text-yellow-700 border-yellow-200 dark:bg-yellow-500/15 dark:text-yellow-300 dark:border-yellow-500/25',
    P3: 'bg-sky-100 text-sky-700 border-sky-200 dark:bg-sky-500/15 dark:text-sky-300 dark:border-sky-500/25',
  }
  return map[priority]
}

export function bugStatusColor(status: BugStatus): string {
  const map: Record<BugStatus, string> = {
    open: 'bg-rose-100 text-rose-700 border-rose-200 dark:bg-rose-500/15 dark:text-rose-300 dark:border-rose-500/25',
    in_progress: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/25',
    resolved: 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/25',
    closed: 'bg-slate-200 text-slate-700 border-slate-300 dark:bg-slate-400/15 dark:text-slate-300 dark:border-slate-400/20',
    wont_fix: 'bg-zinc-200 text-zinc-600 border-zinc-300 dark:bg-zinc-500/20 dark:text-zinc-300 dark:border-zinc-500/25',
  }
  return map[status]
}

export function severityColor(severity: Severity): string {
  const map: Record<Severity, string> = {
    critical: 'bg-red-600 text-white border-red-700',
    high: 'bg-orange-500 text-white border-orange-600',
    medium: 'bg-amber-400 text-amber-950 border-amber-500',
    low: 'bg-sky-200 text-sky-800 border-sky-300',
  }
  return map[severity]
}

export function verdictColor(verdict: Verdict | string): string {
  const map: Record<string, string> = {
    approved: 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/25',
    failed: 'bg-rose-100 text-rose-700 border-rose-200 dark:bg-rose-500/15 dark:text-rose-300 dark:border-rose-500/25',
    needs_revision: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/25',
  }
  return map[verdict] ?? 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-400/15 dark:text-slate-300 dark:border-slate-400/20'
}

export function roleColor(role: Role): string {
  const map: Record<Role, string> = {
    vp: 'bg-purple-100 text-purple-700 border-purple-200 dark:bg-purple-500/15 dark:text-purple-300 dark:border-purple-500/25',
    manager: 'bg-indigo-100 text-indigo-700 border-indigo-200 dark:bg-indigo-500/15 dark:text-indigo-300 dark:border-indigo-500/25',
    product: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/25',
    developer: 'bg-cyan-100 text-cyan-700 border-cyan-200 dark:bg-cyan-500/15 dark:text-cyan-300 dark:border-cyan-500/25',
    qa_engineer: 'bg-teal-100 text-teal-700 border-teal-200 dark:bg-teal-500/15 dark:text-teal-300 dark:border-teal-500/25',
    viewer: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-400/15 dark:text-slate-300 dark:border-slate-400/20',
  }
  return map[role]
}

export function actionColor(action: string): string {
  if (action.startsWith('CREATE')) return 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/25'
  if (action.startsWith('UPDATE')) return 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/25'
  if (action.startsWith('DELETE')) return 'bg-rose-100 text-rose-700 border-rose-200 dark:bg-rose-500/15 dark:text-rose-300 dark:border-rose-500/25'
  if (action.startsWith('STATUS')) return 'bg-sky-100 text-sky-700 border-sky-200 dark:bg-sky-500/15 dark:text-sky-300 dark:border-sky-500/25'
  if (action.startsWith('LOGIN')) return 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-400/15 dark:text-slate-300 dark:border-slate-400/20'
  if (action.startsWith('REVIEW')) return 'bg-purple-100 text-purple-700 border-purple-200 dark:bg-purple-500/15 dark:text-purple-300 dark:border-purple-500/25'
  return 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-400/15 dark:text-slate-300 dark:border-slate-400/20'
}

// ---------- Shared review/verdict colors (used by multiple views) ----------

export function reviewStatusColor(status: string): string {
  if (status === 'completed') return 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/25'
  if (status === 'in_progress') return 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/25'
  return 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-400/15 dark:text-slate-300 dark:border-slate-400/20'
}

// Alias for module reviews (same colors, clearer name at call site).
export const moduleReviewStatusColor = reviewStatusColor

export function verdictHex(verdict: string): string {
  if (verdict === 'approved') return '#10b981'
  if (verdict === 'failed') return '#f43f5e'
  return '#f59e0b'
}

export function severityDot(severity: string): string {
  if (severity === 'critical') return 'bg-red-600'
  if (severity === 'high') return 'bg-orange-500'
  if (severity === 'medium') return 'bg-amber-400'
  return 'bg-sky-300'
}

export function formatDateTime(iso: string | null | Date): string {
  if (!iso) return '—'
  const d = typeof iso === 'string' ? new Date(iso) : iso
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function formatDate(iso: string | null | Date): string {
  if (!iso) return '—'
  const d = typeof iso === 'string' ? new Date(iso) : iso
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit' })
}

export function timeAgo(iso: string | null | Date): string {
  if (!iso) return '—'
  const d = typeof iso === 'string' ? new Date(iso) : iso
  if (isNaN(d.getTime())) return '—'
  const diff = Date.now() - d.getTime()
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const days = Math.floor(hr / 24)
  if (days < 7) return `${days}d ago`
  return formatDate(iso)
}

export function minutesToHuman(min: number): string {
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

export function truncate(s: string, len: number): string {
  if (s.length <= len) return s
  return s.slice(0, len - 1) + '…'
}

/** Two-letter avatar initials ("Alice Admin" -> "AA") — single shared helper. */
export function initials(name: string): string {
  return name
    .split(' ')
    .map((n) => n[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

/** Chart-safe hex palette for test-case statuses (recharts fills / color maps). */
export const STATUS_HEX: Record<string, string> = {
  draft: '#64748b',
  in_review: '#f59e0b',
  needs_revision: '#f97316',
  approved: '#10b981',
  active: '#22c55e',
  deprecated: '#a3a3a3',
}

/** Hex for a status, with the shared neutral fallback used by every chart. */
export function statusHex(status: string): string {
  return STATUS_HEX[status] ?? '#94a3b8'
}

/** Chart-safe hex palette for bug severities (recharts fills / legends). */
export const SEVERITY_HEX: Record<string, string> = {
  critical: '#dc2626',
  high: '#ea580c',
  medium: '#f59e0b',
  low: '#0ea5e9',
}

/** Chart-safe hex palette for priorities. */
export const PRIORITY_HEX: Record<string, string> = {
  P0: '#ef4444',
  P1: '#f97316',
  P2: '#eab308',
  P3: '#0ea5e9',
}

/** Chart-safe hex palette for bug statuses. */
export const BUG_STATUS_HEX: Record<string, string> = {
  open: '#f43f5e',
  in_progress: '#f59e0b',
  resolved: '#10b981',
  closed: '#64748b',
  wont_fix: '#a1a1aa',
}

/** Hex lookups with the shared neutral fallback (#94a3b8) used by every chart. */
export function severityHex(severity: string): string {
  return SEVERITY_HEX[severity] ?? '#94a3b8'
}
export function priorityHex(priority: string): string {
  return PRIORITY_HEX[priority] ?? '#94a3b8'
}
export function bugStatusHex(status: string): string {
  return BUG_STATUS_HEX[status] ?? '#94a3b8'
}

// ---------- Shared date helpers (timezone-safe YYYY-MM-DD) ----------

/** Today's date as YYYY-MM-DD in the user's local timezone (UTC slicing alone
 *  shifts the calendar day for non-UTC users, e.g. IST evenings). */
export function todayISO(): string {
  const d = new Date()
  const tz = d.getTimezoneOffset() * 60000
  return new Date(d.getTime() - tz).toISOString().slice(0, 10)
}

/** Date N days ago as YYYY-MM-DD in the user's local timezone. */
export function isoDaysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  const tz = d.getTimezoneOffset() * 60000
  return new Date(d.getTime() - tz).toISOString().slice(0, 10)
}
