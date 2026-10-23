'use client'

import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { KeyRound, Loader2, Save, ShieldCheck } from 'lucide-react'

import { authApi } from '@/lib/client/api'
import { useAuthStore } from '@/store'
import type { User } from '@/types'
import { formatDate, roleColor, initials } from '@/lib/format'
import { handleApiError } from '@/lib/errors'
import { PASSWORD_MIN_LENGTH, PASSWORD_RULE_TEXT, passwordProblem } from '@/lib/password-policy'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

export function SettingsProfileView() {
  const { user } = useAuthStore()

  if (!user) return null

  return (
    <div className="space-y-4 max-w-3xl mx-auto">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Profile &amp; Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Update your personal info, notification preferences, and password.
        </p>
      </div>

      {/* Account info card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Account</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
            <Avatar className="h-14 w-14">
              {user.avatarUrl && <AvatarImage src={user.avatarUrl} alt={user.fullName} />}
              <AvatarFallback className="bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
                {initials(user.fullName)}
              </AvatarFallback>
            </Avatar>
            <div className="space-y-1">
              <div className="font-medium">{user.fullName}</div>
              <div className="text-sm text-muted-foreground">{user.email}</div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="outline" className={`capitalize ${roleColor(user.role)}`}>
                  {user.role.replace('_', ' ')}
                </Badge>
                <span>Member since {formatDate(user.createdAt)}</span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Profile + password forms, keyed by user.userId so local state reinitializes
          from the latest server data whenever the user object changes externally. */}
      <ProfileForm key={`profile-${user.userId}`} user={user} />
      <PasswordForm key={`password-${user.userId}`} />
    </div>
  )
}

function ProfileForm({ user }: { user: User }) {
  const { setUser } = useAuthStore()

  const [fullName, setFullName] = useState(user.fullName)
  const [avatarUrl, setAvatarUrl] = useState(user.avatarUrl ?? '')
  const [telegramChatId, setTelegramChatId] = useState(user.telegramChatId ?? '')
  const [notifyEmail, setNotifyEmail] = useState(user.notifyEmail)
  const [notifyTelegram, setNotifyTelegram] = useState(user.notifyTelegram)
  const [notifyInapp, setNotifyInapp] = useState(user.notifyInapp)

  const updateMutation = useMutation({
    mutationFn: (patch: Partial<User>) => authApi.updateMe(patch),
    onSuccess: (updated) => {
      setUser(updated)
      toast.success('Profile updated')
    },
    onError: (err: unknown) => {
      handleApiError(err, 'Failed to update profile')
    },
  })

  function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault()
    updateMutation.mutate({
      fullName,
      avatarUrl: avatarUrl.trim() === '' ? null : avatarUrl.trim(),
      telegramChatId: telegramChatId.trim() === '' ? null : telegramChatId.trim(),
      notifyEmail,
      notifyTelegram,
      notifyInapp,
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Personal information</CardTitle>
        <CardDescription>Visible to other members of your team.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSaveProfile} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="fullName">Full name</Label>
            <Input
              id="fullName"
              required
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Your name"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" value={user.email} disabled />
            <p className="text-xs text-muted-foreground">
              Email cannot be changed. Contact an admin if it needs updating.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="avatar">Avatar URL</Label>
            <Input
              id="avatar"
              type="url"
              value={avatarUrl}
              onChange={(e) => setAvatarUrl(e.target.value)}
              placeholder="https://…/avatar.png"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="telegram">Telegram chat ID</Label>
            <Input
              id="telegram"
              value={telegramChatId}
              onChange={(e) => setTelegramChatId(e.target.value)}
              placeholder="e.g. 123456789"
            />
            <p className="text-xs text-muted-foreground">
              Used for Telegram notifications if enabled below.
            </p>
          </div>

          <div className="pt-2 border-t">
            <div className="text-sm font-medium mb-3">Notification preferences</div>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="notifyEmail" className="cursor-pointer">Email notifications</Label>
                  <p className="text-xs text-muted-foreground">Receive updates by email</p>
                </div>
                <Switch
                  id="notifyEmail"
                  checked={notifyEmail}
                  onCheckedChange={setNotifyEmail}
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="notifyTelegram" className="cursor-pointer">Telegram notifications</Label>
                  <p className="text-xs text-muted-foreground">Push via Telegram bot</p>
                </div>
                <Switch
                  id="notifyTelegram"
                  checked={notifyTelegram}
                  onCheckedChange={setNotifyTelegram}
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="notifyInapp" className="cursor-pointer">In-app notifications</Label>
                  <p className="text-xs text-muted-foreground">Bell icon + this page</p>
                </div>
                <Switch
                  id="notifyInapp"
                  checked={notifyInapp}
                  onCheckedChange={setNotifyInapp}
                />
              </div>
            </div>
          </div>

          <div className="flex justify-end pt-2">
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              Save changes
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function PasswordForm() {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  const logout = useAuthStore((s) => s.logout)

  const passwordMutation = useMutation({
    mutationFn: (vars: { currentPassword: string; newPassword: string }) =>
      authApi.changePassword(vars),
    onSuccess: async () => {
      toast.success('Password changed — please sign in with your new password')
      // The server revoked every refresh token for this user (log out
      // everywhere), so end the local session instead of drifting into a
      // zombie state until the next access-token expiry.
      await logout()
    },
    onError: (err: unknown) => {
      handleApiError(err, 'Failed to change password')
    },
  })

  function handleChangePassword(e: React.FormEvent) {
    e.preventDefault()
    const problem = passwordProblem(newPassword)
    if (problem) {
      toast.error(problem)
      return
    }
    if (newPassword !== confirmPassword) {
      toast.error('New passwords do not match')
      return
    }
    passwordMutation.mutate({ currentPassword, newPassword })
  }

  const mismatch = newPassword.length > 0 && confirmPassword.length > 0 && newPassword !== confirmPassword

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <KeyRound className="h-4 w-4" /> Change password
        </CardTitle>
        <CardDescription>{PASSWORD_RULE_TEXT}.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleChangePassword} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="current">Current password</Label>
            <Input
              id="current"
              type="password"
              required
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="new">New password</Label>
              <Input
                id="new"
                type="password"
                required
                minLength={PASSWORD_MIN_LENGTH}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder={`Min. ${PASSWORD_MIN_LENGTH} characters`}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm">Confirm new password</Label>
              <Input
                id="confirm"
                type="password"
                required
                minLength={PASSWORD_MIN_LENGTH}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Repeat new password"
              />
            </div>
          </div>
          {mismatch && (
            <Alert variant="destructive">
              <AlertDescription>New passwords do not match.</AlertDescription>
            </Alert>
          )}
          <div className="flex justify-end pt-2">
            <Button type="submit" disabled={passwordMutation.isPending}>
              {passwordMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ShieldCheck className="h-4 w-4" />
              )}
              Change password
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
