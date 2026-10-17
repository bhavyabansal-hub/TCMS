'use client'

import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Loader2,
  Trash2,
  UserPlus,
} from 'lucide-react'

import { usersApi } from '@/lib/client/api'
import { invalidateAfterMutation } from '@/lib/client/invalidate'
import { useAuthStore } from '@/store'
import type { Role, User } from '@/types'
import { DEFAULT_INVITE_ROLE, ROLE_OPTIONS, canAssignRoles } from '@/lib/roles'
import { formatDate, roleColor } from '@/lib/format'
import { handleApiError } from '@/lib/errors'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { PermissionDenied } from '@/components/shared/permission-denied'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { PaginationFooter } from '@/components/shared/pagination'
import { initials } from '@/lib/format'

export function SettingsUsersView() {
  const { user, can } = useAuthStore()
  // Only a VP may set or change roles (server rule in users.service; R2-3).
  const mayAssignRoles = !!user && canAssignRoles(user.role)
  const qc = useQueryClient()

  const [page, setPage] = useState(1)
  const pageSize = 50
  const [roleFilter, setRoleFilter] = useState<string>('all')
  const [activeFilter, setActiveFilter] = useState<string>('all')

  // Invite dialog state
  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteName, setInviteName] = useState('')
  const [invitePassword, setInvitePassword] = useState('')
  const [inviteRole, setInviteRole] = useState<Role>(DEFAULT_INVITE_ROLE)

  // Delete dialog state
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [deleteName, setDeleteName] = useState<string>('')

  const params = useMemo(() => {
    const p: Record<string, string> = {
      page: String(page),
      pageSize: String(pageSize),
    }
    if (roleFilter !== 'all') p.role = roleFilter
    if (activeFilter !== 'all') p.isActive = activeFilter
    return p
  }, [page, pageSize, roleFilter, activeFilter])

  const usersQuery = useQuery({
    queryKey: ['users', 'list', params],
    queryFn: () => usersApi.list(params),
    // Don't fire the request before the permission gate has decided — the
    // API would 403 it anyway (fetch-before-check cleanup, audit 2026-10-09).
    enabled: !!user && can('manage_users'),
  })

  const createMutation = useMutation({
    mutationFn: (vars: {
      email: string
      fullName: string
      password: string
      role: Role
    }) => usersApi.create(vars),
    onSuccess: () => {
      toast.success('User invited')
      invalidateAfterMutation(qc, 'users')
      setInviteOpen(false)
      setInviteEmail('')
      setInviteName('')
      setInvitePassword('')
      setInviteRole('qa_engineer')
    },
    onError: (err: unknown) => {
      handleApiError(err, 'Failed to invite user')
    },
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<User> }) =>
      usersApi.update(id, patch),
    onSuccess: () => {
      toast.success('User updated')
      invalidateAfterMutation(qc, 'users')
    },
    onError: (err: unknown) => {
      handleApiError(err, 'Failed to update user')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => usersApi.delete(id),
    onSuccess: () => {
      toast.success('User deactivated')
      setDeleteId(null)
      setDeleteName('')
      invalidateAfterMutation(qc, 'users')
    },
    onError: (err: unknown) => {
      handleApiError(err, 'Failed to delete user')
    },
  })

  if (user && !can('manage_users')) {
    return <PermissionDenied title="Admins only" description="You need administrator privileges to manage users." />
  }

  const users = usersQuery.data?.data ?? []
  const total = usersQuery.data?.total ?? 0
  const totalPages = usersQuery.data?.totalPages ?? 1

  function handleInviteSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (invitePassword.length < 8) {
      toast.error('Password must be at least 6 characters')
      return
    }
    createMutation.mutate({
      email: inviteEmail,
      fullName: inviteName,
      password: invitePassword,
      role: mayAssignRoles ? inviteRole : DEFAULT_INVITE_ROLE,
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">User Management</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Invite teammates, change roles, and deactivate accounts.
          </p>
        </div>
        <Button onClick={() => setInviteOpen(true)}>
          <UserPlus className="h-4 w-4" /> Invite user
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-3 flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Users</CardTitle>
          <div className="flex flex-wrap gap-2 items-end">
            <div className="space-y-1.5">
              <Label className="text-xs">Role</Label>
              <Select
                value={roleFilter}
                onValueChange={(v) => {
                  setRoleFilter(v)
                  setPage(1)
                }}
              >
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All roles</SelectItem>
                  {ROLE_OPTIONS.map((r) => (
                    <SelectItem key={r.value} value={r.value}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Status</Label>
              <Select
                value={activeFilter}
                onValueChange={(v) => {
                  setActiveFilter(v)
                  setPage(1)
                }}
              >
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="true">Active</SelectItem>
                  <SelectItem value="false">Inactive</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {usersQuery.isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : usersQuery.isError ? (
            <Alert variant="destructive" className="m-4">
              <AlertDescription>Failed to load users.</AlertDescription>
            </Alert>
          ) : users.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              No users match the current filters.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-48">User</TableHead>
                  <TableHead className="min-w-40">Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Member since</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((u) => {
                  const isSelf = u.userId === user?.userId
                  return (
                    <TableRow key={u.userId}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <Avatar className="h-8 w-8">
                            {u.avatarUrl && <AvatarImage src={u.avatarUrl} alt={u.fullName} />}
                            <AvatarFallback className="text-xs bg-slate-100 text-slate-700 dark:bg-slate-400/15 dark:text-slate-300">
                              {initials(u.fullName)}
                            </AvatarFallback>
                          </Avatar>
                          <div className="min-w-0">
                            <div className="font-medium truncate">
                              {u.fullName}
                              {isSelf && (
                                <span className="ml-2 text-xs text-muted-foreground">(you)</span>
                              )}
                            </div>
                            <div className="text-xs text-muted-foreground truncate">
                              {u.email}
                            </div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Select
                          value={u.role}
                          disabled={isSelf || !mayAssignRoles || updateMutation.isPending}
                          onValueChange={(v) =>
                            updateMutation.mutate({ id: u.userId, patch: { role: v as Role } })
                          }
                        >
                          <SelectTrigger className="w-36 h-8">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {ROLE_OPTIONS.map((r) => (
                              <SelectItem key={r.value} value={r.value}>
                                <Badge
                                  variant="outline"
                                  className={`mr-1 ${roleColor(r.value)}`}
                                >
                                  {r.label}
                                </Badge>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={u.isActive}
                            disabled={isSelf || updateMutation.isPending}
                            onCheckedChange={(checked) =>
                              updateMutation.mutate({
                                id: u.userId,
                                patch: { isActive: checked },
                              })
                            }
                          />
                          <span className={`text-xs ${u.isActive ? 'text-emerald-700' : 'text-muted-foreground'}`}>
                            {u.isActive ? 'Active' : 'Inactive'}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatDate(u.createdAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        <AlertDialog
                          open={deleteId === u.userId}
                          onOpenChange={(o) => {
                            if (!o) {
                              setDeleteId(null)
                              setDeleteName('')
                            }
                          }}
                        >
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground hover:text-rose-600"
                              disabled={isSelf}
                              aria-label="Delete user"
                              onClick={() => {
                                setDeleteId(u.userId)
                                setDeleteName(u.fullName)
                              }}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Delete user?</AlertDialogTitle>
                              <AlertDialogDescription>
                                This will deactivate{' '}
                                <span className="font-medium">{deleteName}</span> and revoke
                                their access. Their historical data (test cases, bugs, reports)
                                will be preserved.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction
                                className="bg-rose-600 hover:bg-rose-700 text-white"
                                disabled={deleteMutation.isPending}
                                onClick={(e) => {
                                  e.preventDefault()
                                  if (deleteId) deleteMutation.mutate(deleteId)
                                }}
                              >
                                {deleteMutation.isPending ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <Trash2 className="h-4 w-4" />
                                )}
                                Delete
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <PaginationFooter
        page={page}
        totalPages={totalPages}
        total={total}
        singular="user"
        plural="users"
        isFetching={usersQuery.isFetching}
        onPageChange={setPage}
      />

      {/* Invite dialog */}
      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite a new user</DialogTitle>
            <DialogDescription>
              Create a new account. They will be able to sign in immediately with the password you set.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleInviteSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                type="email"
                required
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="you@company.com"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-name">Full name</Label>
              <Input
                id="invite-name"
                required
                value={inviteName}
                onChange={(e) => setInviteName(e.target.value)}
                placeholder="Jane Doe"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-password">Temporary password</Label>
              <Input
                id="invite-password"
                type="password"
                required
                minLength={6}
                value={invitePassword}
                onChange={(e) => setInvitePassword(e.target.value)}
                placeholder="Min. 6 characters"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-role">Role</Label>
              <Select
                value={mayAssignRoles ? inviteRole : DEFAULT_INVITE_ROLE}
                onValueChange={(v) => setInviteRole(v as Role)}
                disabled={!mayAssignRoles}
              >
                <SelectTrigger id="invite-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLE_OPTIONS.map((r) => (
                    <SelectItem key={r.value} value={r.value}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setInviteOpen(false)}
                disabled={createMutation.isPending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <UserPlus className="h-4 w-4" />
                )}
                Invite user
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
