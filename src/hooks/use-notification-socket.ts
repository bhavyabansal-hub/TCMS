'use client'

import { useEffect, useRef } from 'react'
import { io, Socket } from 'socket.io-client'
import { useAuthStore, useNotificationsStore } from '@/store'
import { notificationsApi } from '@/lib/client/api'
import type { Notification } from '@/types'

// Where the notification socket lives.
//   Production default: same-origin ('' -> window.location) + socket.io path
//   '/socket.io/' — a reverse proxy (nginx / Apache / IIS) routes that prefix
//   to the mini-service on :3003 (see docs/deploy/reverse-proxy-websocket.md).
//   Sandbox gateway: the platform gateway proxies by ?XTransformPort= query
//   param instead, so the sandbox .env sets NEXT_PUBLIC_WS_URL=/?XTransformPort=3003
//   and NEXT_PUBLIC_WS_PATH=/.
// NEXT_PUBLIC_* values are BAKED AT BUILD TIME — editing .env requires a rebuild.
const WS_URL = process.env.NEXT_PUBLIC_WS_URL || ''
const WS_PATH = process.env.NEXT_PUBLIC_WS_PATH || '/socket.io/'

// Reconnect policy (reconnect audit 2026-10-14, owner-approved):
//   ONE reconnect driver per failure class. Transport-level drops ("transport
//   close", "ping timeout", ...) are retried by socket.io's manager (1s→10s
//   backoff, Infinity attempts) — the hook adds nothing. SERVER-initiated
//   disconnects ("io server disconnect", e.g. a rejected/expired ticket or a
//   service shutdown) disable the manager's auto-reconnect BY DESIGN, so the
//   hook schedules its own reconnect with bounded backoff (max 30s). A
//   CLIENT-initiated disconnect ("io client disconnect" — effect cleanup on
//   logout/account switch) must never resurrect the socket.
// Ticket lifecycle: the socket.io `auth` CALLBACK runs at the start of EVERY
//   connection attempt and mints a FRESH 60-second ws-ticket. The minted
//   ticket is memoized for THAT attempt ONLY and consumed exactly once:
//     - the memo slot is stamped with the attempt that fetched it, and a
//       callback from a superseded attempt is DROPPED (stale-guard),
//     - the 'connect' handler reads the slot and CLEARS it in the same tick,
//     - so a ticket can never be presented twice and never outlives its own
//       attempt — the next attempt always mints a new one.
export function useNotificationSocket() {
  const user = useAuthStore((s) => s.user)
  const addNotification = useNotificationsStore((s) => s.addNotification)
  const setItems = useNotificationsStore((s) => s.setItems)
  const socketRef = useRef<Socket | null>(null)
  const reconnectTimer = useRef<NodeJS.Timeout | null>(null)
  const manualAttempts = useRef(0)
  const stopped = useRef(false)

  useEffect(() => {
    if (!user) return

    // Refs PERSIST across effect re-runs (account switch re-runs this effect
    // in the same component instance) — reset the per-session state up front.
    stopped.current = false
    manualAttempts.current = 0

    // Canonical list pull. Besides live WS push this is the ONLY delivery
    // channel — there are NO polling timers in this app (`docs/architecture/realtime-and-notifications.md` §1). It runs:
    //   1. once on mount,
    //   2. on every socket RE-connect (catch-up for downtime),
    //   3. whenever the tab becomes visible again.
    async function refetchList() {
      try {
        const res = await notificationsApi.list({ pageSize: '50' })
        setItems(res.data)
      } catch {
        /* offline — keep whatever the store already holds */
      }
    }

    function onVisibilityChange() {
      if (document.visibilityState === 'visible') void refetchList()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    let everConnected = false

    // ---- per-attempt ticket minting (single-use memo) ----
    let attemptCounter = 0
    // Memo slot: a ticket is stored ONLY together with the attempt number that
    // fetched it. Anything still in the slot belongs to a finished attempt and
    // is discarded — it can never be presented on a later attempt.
    let ticketSlot: { attempt: number; ticket: string } | null = null

    async function mintTicket(): Promise<string | null> {
      try {
        const { ticket } = await notificationsApi.wsTicket()
        return ticket
      } catch (err) {
        // The request helper turns a 401 into: cookie refresh -> on definitive
        // rejection it clears the profile, routes to /login and throws
        // 'Session expired'. Transient failures (offline / 5xx) throw with
        // status 503. Only a DEFINITIVE session death stops the machinery —
        // the app's normal logout flow owns the UI from there.
        const status = (err as { status?: number } | null)?.status
        const hard =
          status === 401 || (err instanceof Error && err.message === 'Session expired')
        if (hard) stopped.current = true
        return null // transient: the next attempt retries the mint
      }
    }

    function connect() {
      const socket = io(WS_URL || undefined, {
        path: WS_PATH,
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 10000,
        // Called at the start of EVERY connection attempt -> a fresh ticket
        // every time (socket.io invokes this before sending each CONNECT).
        auth: (cb) => {
          const attempt = ++attemptCounter
          void mintTicket().then((ticket) => {
            if (stopped.current) {
              // Session dead or effect torn down: stop retrying quietly and
              // drop the machinery (no further attempts, manual or managed).
              cb({})
              socket.io.reconnection(false)
              socket.disconnect()
              return
            }
            // STALE-GUARD: this callback was fetched for `attempt`; if a newer
            // attempt has started, this ticket is DROPPED — never stored,
            // never presented. Guarantees one ticket per attempt, single use.
            if (attempt !== attemptCounter) return
            if (!ticket) {
              // Transient mint failure: attempt proceeds unauthenticated
              // (the service never joins us to any room); next attempt retries.
              cb({})
              return
            }
            ticketSlot = { attempt, ticket } // memoized for THIS attempt only
            cb({ ticket })
          })
        },
      })
      socketRef.current = socket

      socket.on('connect', () => {
        manualAttempts.current = 0
        if (everConnected) {
          // Re-connect after downtime: pull the canonical list so anything
          // missed while the socket was gone shows up now.
          void refetchList()
        }
        everConnected = true
        // CONSUME the memoized ticket: read + clear in the same tick (single
        // use). The slot can only hold a ticket from the CURRENT attempt
        // (stale-guard above + clear-on-consume), so a fresh ticket is
        // presented on every connection and an expired one never is.
        const slot = ticketSlot
        ticketSlot = null
        if (slot && slot.attempt === attemptCounter) {
          socket.emit('auth', { userId: user!.userId, token: slot.ticket })
        }
      })

      socket.on('notification', (payload: Omit<Notification, 'userId'>) => {
        // Payload arrives from the WS service without userId; reconstruct the
        // full record locally so it matches the canonical Notification shape.
        const full: Notification = {
          ...payload,
          userId: user!.userId,
          isRead: false,
        } as Notification
        addNotification(full)
      })

      socket.on('auth-error', () => {
        // The service rejects a bad/expired ticket with 'auth-error' AND an
        // immediate server-side disconnect. Emitting a retry here would land
        // in the void (or sit in the client's packet buffer and present a
        // STALE ticket after reconnect) — so we deliberately do nothing: the
        // 'disconnect' handling below reconnects, and the auth callback mints
        // a fresh ticket for the next attempt.
      })

      socket.on('disconnect', (reason) => {
        if (stopped.current) return
        if (reason === 'io client disconnect') {
          // OUR OWN teardown (cleanup on logout / account switch). Never
          // resurrect the socket — this is the zombie-socket guard.
          return
        }
        if (reason === 'io server disconnect') {
          // Server-initiated (rejected ticket or service shutdown): socket.io
          // does NOT auto-reconnect after this. Schedule our own connect with
          // bounded backoff — max 30s per owner spec. The next attempt mints
          // a fresh ticket via the auth callback, so even a ticket rejected
          // as expired self-heals.
          if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
          const delay = Math.min(30000, 1000 * 2 ** manualAttempts.current)
          manualAttempts.current += 1
          reconnectTimer.current = setTimeout(() => {
            socket.connect()
          }, delay)
          return
        }
        // Transport-level drop ('transport close', 'ping timeout', ...):
        // the manager is ALREADY retrying (1s→10s backoff, Infinity attempts).
        // Adding our own timer here would double-drive reconnects — do nothing.
      })

      socket.on('connect_error', () => {
        // silent — the manager's retry loop owns recovery; each new attempt
        // mints a fresh ticket via the auth callback.
      })
    }

    // Initial fetch of existing notifications
    void refetchList()

    connect()

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      // Tear down BEFORE disconnecting: stopped.current makes any in-flight
      // auth callback drop the machinery, and the disconnect handler sees
      // reason 'io client disconnect' and schedules nothing — no zombie
      // socket can outlive this effect (logout / account switch).
      stopped.current = true
      socketRef.current?.disconnect()
      socketRef.current = null
    }
  }, [user?.userId])
}
