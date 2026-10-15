'use client'

// Permissions view — VP-only control panel for the runtime-togglable
// role × action matrix. One switch per cell; toggles call PUT /api/permissions
// and take effect immediately (cache is invalidated server-side).

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ShieldCheck, Loader2 } from 'lucide-react'
import { useAuthStore } from '@/store'
import { permissionsApi } from '@/lib/client/api'
import { handleApiError } from '@/lib/errors'
import { PERMISSION_ACTIONS, PERMISSION_ACTION_LABELS, ROLES, ROLE_LABELS, type PermissionToggle, type Role } from '@/types'
import { PageHeader } from '@/components/shared/page-header'
import { QueryErrorAlert } from '@/components/shared/query-error'
import { PermissionDenied } from '@/components/shared/permission-denied'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

export function SettingsPermissionsView() {
  const { user, can } = useAuthStore()
  const queryClient = useQueryClient()

  const { data, isLoading, isError, refetch } = useQuery<PermissionToggle[]>({
    queryKey: ['permissions', 'matrix'],
    queryFn: permissionsApi.matrix,
    enabled: !!user && can('manage_permissions'),
  })

  const toggleMutation = useMutation({
    mutationFn: (input: { role: Role; action: string; enabled: boolean }) => permissionsApi.toggle(input),
    onSuccess: (updated) => {
      toast.success(`${ROLE_LABELS[updated.role]} ${updated.enabled ? 'granted' : 'revoked'}: ${PERMISSION_ACTION_LABELS[updated.action]}`)
      queryClient.invalidateQueries({ queryKey: ['permissions', 'matrix'] })
    },
    onError: (err: unknown) => handleApiError(err, 'Failed to update permission'),
  })

  if (!user) return null

  if (!can('manage_permissions')) {
    return <PermissionDenied title="No access" description="Only roles with manage-permissions rights can open this panel." />
  }

  const cell = (role: Role, action: string) =>
    (data ?? []).find((t) => t.role === role && t.action === action)

  return (
    <div className="space-y-4">
      <PageHeader
        title="Permissions"
        description="Enable or disable any capability for any role — changes apply instantly across the app."
      />

      {isError ? (
        <QueryErrorAlert
          title="Could not load the permission matrix"
          onRetry={() => refetch()}
        />
      ) : isLoading || !data ? (
        <div className="space-y-3">
          <Skeleton className="h-10 w-64" />
          <Skeleton className="h-96" />
        </div>
      ) : (
        <div className="rounded-lg border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-52 sticky left-0 bg-background z-10">Capability</TableHead>
                {ROLES.map((role) => (
                  <TableHead key={role} className="text-center">
                    {ROLE_LABELS[role]}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {PERMISSION_ACTIONS.map((action) => (
                <TableRow key={action}>
                  <TableCell className="font-medium sticky left-0 bg-background z-10">{PERMISSION_ACTION_LABELS[action]}</TableCell>
                  {ROLES.map((role) => {
                    const toggle = cell(role, action)
                    const isOverride = toggle?.source === 'override'
                    return (
                      <TableCell key={role} className="text-center">
                        {/* Override marker: a small amber dot under the switch
                            (subtle) instead of a full ring (visually loud). */}
                        <div className="flex flex-col items-center gap-1">
                          <Switch
                            checked={toggle?.enabled ?? false}
                            disabled={toggleMutation.isPending}
                            onCheckedChange={(enabled) =>
                              toggleMutation.mutate({ role, action, enabled })
                            }
                            aria-label={`${ROLE_LABELS[role]} ${PERMISSION_ACTION_LABELS[action]}`}
                          />
                          <span
                            className={cn(
                              'h-1 w-1 rounded-full bg-amber-400',
                              !isOverride && 'invisible'
                            )}
                            title="Custom override — differs from the role default"
                          />
                        </div>
                      </TableCell>
                    )
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <p className="text-xs text-muted-foreground flex items-center gap-1.5">
        <ShieldCheck className="h-3.5 w-3.5" />
        A small amber dot marks custom overrides — switches without a dot follow the built-in hierarchy defaults.
      </p>
      {toggleMutation.isPending && (
        <div className="fixed bottom-4 right-4 flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm shadow-md">
          <Loader2 className="h-4 w-4 animate-spin" /> Saving permission…
        </div>
      )}
    </div>
  )
}
