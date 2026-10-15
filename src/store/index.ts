'use client'

import { create } from 'zustand'
import type { User, Notification, PermissionAction, Role } from '@/types'
import { authApi, getStoredUser, saveUser, clearStoredUser } from '@/lib/client/api'
import { pathForView, viewFromPath, routerPush } from '@/lib/routes'

interface AuthState {
  user: User | null
  /** Effective permissions for the user's role (synced from the server). */
  permissions: string[]
  isLoading: boolean
  isInitialized: boolean
  /** True when the startup session check failed for TRANSIENT reasons
   *  (server unreachable / 5xx). Tokens are intentionally KEPT — the UI shows
   *  a retry card instead of discarding a perfectly valid session. */
  sessionError: boolean
  /** Permission check helper — single gate used by every view. */
  can: (action: PermissionAction) => boolean
  /** Any-of check for features that span two actions (e.g. Reviews). */
  canAny: (actions: PermissionAction[]) => boolean
  initialize: () => Promise<void>
  /** Re-run the session check after a transient failure (fallback UI retry). */
  retrySession: () => Promise<void>
  login: (email: string, password: string) => Promise<void>
  /** Self-signup: creates a least-privileged 'viewer' account (no group
   *  choice anywhere — server enforces it), then signs the user in. */
  register: (fullName: string, email: string, password: string) => Promise<void>
  logout: () => Promise<void>
  setUser: (user: User) => void
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  permissions: [],
  isLoading: false,
  isInitialized: false,
  sessionError: false,

  can: (action) => get().permissions.includes(action),

  canAny: (actions) => actions.some((action) => get().permissions.includes(action)),

  initialize: async () => {
    // The httpOnly session cookies are invisible to JS, so the local profile
    // is only a HINT that we may be signed in. The server /me call below is
    // the real check: it runs on cookie auth and, when the 15m access token
    // has expired, the request layer silently refreshes first.
    if (!getStoredUser()) {
      set({ user: null, permissions: [], isInitialized: true, sessionError: false })
      return
    }
    // HARD REFRESH RESILIENCE: a full page load re-validates the stored
    // session with /api/auth. Only a server-confirmed dead session may clear
    // it — a network blip or 5xx while the user refreshes must NEVER log
    // them out, so transient failures are retried with backoff first.
    const BACKOFF_MS = [400, 1200]
    for (let attempt = 0; ; attempt++) {
      try {
        const { user, permissions } = await authApi.me()
        set({ user, permissions, isInitialized: true, sessionError: false })
        return
      } catch (err) {
        const dead = err instanceof Error && err.message === 'Session expired'
        if (dead) {
          // request() already cleared the discarded session — genuinely signed
          // out (server rejected both access AND refresh tokens).
          set({ user: null, permissions: [], isInitialized: true, sessionError: false })
          return
        }
        if (attempt < BACKOFF_MS.length) {
          await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]))
          continue
        }
        // Give up GRACEFULLY: keep the tokens on disk, surface a retryable
        // state. The AuthGate fallback card offers Try again / Reload — the
        // session recovers as soon as the server answers.
        set({ user: null, permissions: [], isInitialized: true, sessionError: true })
        return
      }
    }
  },

  retrySession: async () => {
    // Re-run the bootstrap. isInitialized:false puts AuthGate back on the
    // spinner so the redirect guard cannot bounce to /login mid-retry.
    set({ sessionError: false, isInitialized: false })
    await get().initialize()
  },

  login: async (email, password) => {
    set({ isLoading: true })
    try {
      // Server sets the httpOnly session cookies; body carries profile only.
      const { user, permissions } = await authApi.login({ email, password })
      saveUser(user)
      // Cross-account hygiene: the previous session's notifications must never
      // bleed into the new one (owner report 2026-10-09).
      useNotificationsStore.getState().setItems([])
      set({ user, permissions, isLoading: false })
    } catch (err) {
      set({ isLoading: false })
      throw err
    }
  },

  register: async (fullName, email, password) => {
    set({ isLoading: true })
    try {
      // Server sets the httpOnly session cookies; body carries profile only.
      // The role is decided server-side (always 'viewer') — never sent here.
      const { user, permissions } = await authApi.register({ fullName, email, password })
      saveUser(user)
      useNotificationsStore.getState().setItems([])
      set({ user, permissions, isLoading: false })
    } catch (err) {
      set({ isLoading: false })
      throw err
    }
  },

  logout: async () => {
    try {
      // Server revokes the refresh token and clears both httpOnly cookies.
      await authApi.logout()
    } catch {
      // ignore — clearing the local profile below still ends the UI session
    }
    clearStoredUser()
    useNotificationsStore.getState().setItems([])
    set({ user: null, permissions: [] })
  },

  setUser: (user) => set({ user }),
}))

interface NotificationsState {
  items: Notification[]
  unreadCount: number
  setItems: (items: Notification[]) => void
  addNotification: (n: Notification) => void
  markAllRead: () => void
  markRead: (id: string) => void
  remove: (id: string) => void
}

export const useNotificationsStore = create<NotificationsState>((set) => ({
  items: [],
  unreadCount: 0,
  setItems: (items) =>
    set({ items, unreadCount: items.filter((n) => !n.isRead).length }),
  addNotification: (n) =>
    set((s) => ({
      items: [n, ...s.items].slice(0, 50),
      unreadCount: s.unreadCount + (n.isRead ? 0 : 1),
    })),
  markAllRead: () =>
    set((s) => ({
      items: s.items.map((n) => ({ ...n, isRead: true })),
      unreadCount: 0,
    })),
  markRead: (id) =>
    set((s) => ({
      items: s.items.map((n) => (n.notificationId === id ? { ...n, isRead: true } : n)),
      unreadCount: Math.max(0, s.unreadCount - 1),
    })),
  remove: (id) =>
    set((s) => {
      const target = s.items.find((n) => n.notificationId === id)
      return {
        items: s.items.filter((n) => n.notificationId !== id),
        unreadCount: target && !target.isRead ? Math.max(0, s.unreadCount - 1) : s.unreadCount,
      }
    }),
}))

export type ViewKey =
  | 'dashboard'
  | 'modules'
  | 'test-cases'
  | 'reviews'
  | 'bugs'
  | 'tasks'
  | 'reports'
  | 'activity-log'
  | 'notifications'
  | 'settings-users'
  | 'settings-permissions'
  | 'settings-profile'
  | 'test-case-detail'
  | 'review-detail'
  | 'module-review-detail'
  | 'module-detail'
  | 'integrations'
  | 'wiki'
  | 'wiki-doc'

interface ViewState {
  current: ViewKey
  params: Record<string, string>
  navigate: (view: ViewKey, params?: Record<string, string>) => void
}

// The view is URL-driven: the initial state comes from the address bar so a
// hard load / refresh / shared deep link lands on the right page, and
// navigate() pushes real URLs through the Next router (bridge registered by
// <RouteSync />). RouteSync keeps this store in sync on back/forward too.
const initialView = (): { current: ViewKey; params: Record<string, string> } => {
  if (typeof window === 'undefined') return { current: 'dashboard', params: {} }
  // Search string included so a hard load / refresh of a deep link like
  // /test-cases?moduleId=… boots straight into the filtered view.
  return viewFromPath(window.location.pathname, window.location.search) ?? { current: 'dashboard', params: {} }
}

export const useViewStore = create<ViewState>((set) => ({
  ...initialView(),
  navigate: (view, params = {}) => {
    routerPush(pathForView(view, params))
    // Optimistic sync so the UI updates immediately; RouteSync reconciles
    // with the real pathname once the router commits.
    set({ current: view, params })
  },
}))
