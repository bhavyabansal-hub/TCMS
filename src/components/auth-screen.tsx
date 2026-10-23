'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuthStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Bug, Loader2, ShieldCheck, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import { nextFromLocation } from '@/lib/routes'
import { PASSWORD_MIN_LENGTH, PASSWORD_RULE_TEXT, passwordProblem } from '@/lib/password-policy'
import { cn } from '@/lib/utils'

type AuthMode = 'signin' | 'register'

/** Client-side signup visibility — baked in AT BUILD TIME (NEXT_PUBLIC_*
 *  inlining). Mirrors the server-side TCMS_ALLOW_SIGNUP (the actual security
 *  law, enforced per-request in auth.service.ts — this flag is UX only).
 *  Both flags must be flipped together and the app REBUILT: changing the env
 *  alone does not alter an already-built client bundle (see .env.example). */
const SIGNUP_ENABLED = process.env.NEXT_PUBLIC_ALLOW_SIGNUP === 'true'

/**
 * /login — split auth screen: brand panel (left) + form card (right).
 * When signup is enabled it shows TWO explicit tabs — Sign in and Create
 * account — kept visually distinct with generous spacing. Self-signup
 * (owner decision 2026-10-09, tightened 2026-10-14) creates a
 * least-privilege 'viewer' account — there is NO group picker on the form
 * and the SERVER ignores any client-supplied role — and signs the user
 * straight in; only a permission-holder can promote the role afterwards
 * from the Users page. When the build-time flag is off (or unset), the
 * Create-account tab and its footer link are NOT rendered at all.
 */
export function AuthScreen() {
  const { login, register, isLoading } = useAuthStore()
  const router = useRouter()
  const [mode, setMode] = useState<AuthMode>('signin')

  // Shared field state (both forms have email + password).
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fullName, setFullName] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  function resetForms() {
    setEmail('')
    setPassword('')
    setFullName('')
    setConfirmPassword('')
  }

  function switchMode(next: AuthMode) {
    if (next === mode) return
    // Fail-closed UI guard: with the flag off, no rendered control can reach
    // the register mode — this also covers a stale/hot-reloaded bundle.
    if (next === 'register' && !SIGNUP_ENABLED) return
    resetForms()
    setMode(next)
  }

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault()
    try {
      await login(email, password)
      toast.success('Welcome back!')
      // Real routes: after a successful login, enter the app — back to ?next=
      // when the session guard bounced the user here, so a hard refresh on a
      // deep link resumes exactly where they were.
      router.replace(nextFromLocation())
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong')
    }
  }

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault()
    const problem = passwordProblem(password)
    if (problem) {
      toast.error(problem)
      return
    }
    if (password !== confirmPassword) {
      toast.error('Passwords do not match')
      return
    }
    try {
      // No role is sent: self-signup is ALWAYS the least-privileged group
      // (server enforces it too — a crafted request cannot elevate itself).
      await register(fullName.trim(), email.trim(), password)
      toast.success(`Welcome, ${fullName.trim().split(' ')[0]}! Your account is ready.`)
      router.replace(nextFromLocation())
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong')
    }
  }

  return (
    <div className="min-h-screen flex flex-col lg:flex-row">
      {/* ---------- Left brand panel ---------- */}
      <div className="lg:w-1/2 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white p-8 lg:p-16 flex flex-col justify-between">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-emerald-500 flex items-center justify-center">
            <Bug className="h-5 w-5 text-white" />
          </div>
          <span className="text-2xl font-bold tracking-tight">TCMS</span>
        </div>
        <div className="my-12 lg:my-0">
          <h1 className="text-4xl lg:text-5xl font-bold leading-tight">
            Test Case Management,<br />simplified for QA teams.
          </h1>
          <p className="mt-6 text-slate-300 text-lg max-w-md">
            Write test cases, run peer reviews, track bugs, log daily work, and get real-time
            notifications — all in one place.
          </p>
          <ul className="mt-8 space-y-3 text-slate-300">
            <li className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-emerald-400 shrink-0" />
              Role-based access for admins, leads, and engineers
            </li>
            <li className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-emerald-400 shrink-0" />
              Immutable version history for every test case
            </li>
            <li className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-emerald-400 shrink-0" />
              Live notifications via WebSocket
            </li>
          </ul>
        </div>
        <div className="text-sm text-slate-400">© {new Date().getFullYear()} TCMS — built for QA teams</div>
      </div>

      {/* ---------- Right form panel ---------- */}
      <div className="lg:w-1/2 flex items-center justify-center p-6 lg:p-16 bg-background">
        <div className="w-full max-w-md">
          {/* Mode switcher — two equal tabs, clear active state. Hidden
              entirely when signup is disabled (build-time flag). */}
          {SIGNUP_ENABLED && (
            <div
              role="tablist"
              aria-label="Authentication options"
              className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-muted mb-6"
            >
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'signin'}
                onClick={() => switchMode('signin')}
                className={cn(
                  'h-10 rounded-md text-sm font-medium transition-colors',
                  mode === 'signin'
                    ? 'bg-background shadow-sm text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                Sign in
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'register'}
                onClick={() => switchMode('register')}
                className={cn(
                  'h-10 rounded-md text-sm font-medium transition-colors inline-flex items-center justify-center gap-2',
                  mode === 'register'
                    ? 'bg-background shadow-sm text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <UserPlus className="h-4 w-4" />
                Create account
              </button>
            </div>
          )}

          {mode === 'signin' ? (
            <Card className="shadow-sm">
              <CardHeader className="pb-6">
                <CardTitle className="text-xl">Welcome back</CardTitle>
                <CardDescription>Sign in to your TCMS account to continue</CardDescription>
              </CardHeader>
              <form onSubmit={handleSignIn}>
                <CardContent className="space-y-5">
                  <div className="space-y-2">
                    <Label htmlFor="email">Email</Label>
                    <Input
                      id="email"
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@company.com"
                      autoComplete="email"
                      className="h-10"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="password">Password</Label>
                    <Input
                      id="password"
                      type="password"
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••"
                      autoComplete="current-password"
                      className="h-10"
                    />
                  </div>
                </CardContent>
                <CardContent className="pt-2 pb-6">
                  <Button type="submit" className="w-full h-10" disabled={isLoading}>
                    {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Sign in
                  </Button>
                  {SIGNUP_ENABLED && (
                    <p className="mt-4 text-xs text-center text-muted-foreground">
                      New to TCMS?{' '}
                      <button
                        type="button"
                        className="font-medium text-primary underline-offset-4 hover:underline"
                        onClick={() => switchMode('register')}
                      >
                        Create an account
                      </button>
                    </p>
                  )}
                </CardContent>
              </form>
            </Card>
          ) : (
            <Card className="shadow-sm">
              <CardHeader className="pb-4">
                <CardTitle className="text-xl">Create your account</CardTitle>
                <CardDescription>
                  New accounts start with Viewer access — an admin can change your group later from the Users page.
                </CardDescription>
              </CardHeader>
              <form onSubmit={handleRegister}>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="fullName">Full name</Label>
                    <Input
                      id="fullName"
                      type="text"
                      required
                      minLength={2}
                      maxLength={80}
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      placeholder="Jane Doe"
                      autoComplete="name"
                      className="h-10"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="reg-email">Email</Label>
                    <Input
                      id="reg-email"
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@company.com"
                      autoComplete="email"
                      className="h-10"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="reg-password">Password</Label>
                    <Input
                      id="reg-password"
                      type="password"
                      required
                      minLength={PASSWORD_MIN_LENGTH}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder={PASSWORD_RULE_TEXT}
                      autoComplete="new-password"
                      className="h-10"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="confirm-password">Confirm password</Label>
                    <Input
                      id="confirm-password"
                      type="password"
                      required
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="Repeat your password"
                      autoComplete="new-password"
                      className="h-10"
                    />
                  </div>
                </CardContent>
                <CardContent className="pt-2 pb-6">
                  <Button type="submit" className="w-full h-10" disabled={isLoading}>
                    {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Create account
                  </Button>
                  <p className="mt-4 text-xs text-center text-muted-foreground">
                    Already have an account?{' '}
                    <button
                      type="button"
                      className="font-medium text-primary underline-offset-4 hover:underline"
                      onClick={() => switchMode('signin')}
                    >
                      Sign in
                    </button>
                  </p>
                </CardContent>
              </form>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
