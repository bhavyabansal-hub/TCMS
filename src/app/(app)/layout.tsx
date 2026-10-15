import { AppShell } from '@/components/app-shell'

/** Shared layout for every authenticated page: sidebar + topbar + footer. */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>
}
