'use client'

/**
 * Root-level error boundary — the LAST line of defence.
 *
 * Without this file, any uncaught render/hydration error in production shows
 * Next.js's bare "Application error: a client-side exception has occurred"
 * page with no way to recover except a manual URL refresh. This boundary
 * renders a minimal, dependency-free fallback (it replaces the entire <html>,
 * so it cannot rely on the app layout or providers) with a one-click Reload.
 */

import { useEffect } from 'react'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // Surface the error in the console so support/debugging still works.
    console.error('[global-error]', error)
  }, [error])

  return (
    <html lang="en">
      <body
        style={{
          fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          background: '#f8fafc',
          color: '#0f172a',
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
        }}
      >
        <div
          style={{
            maxWidth: 480,
            width: '100%',
            background: '#ffffff',
            border: '1px solid #e2e8f0',
            borderRadius: 12,
            padding: '32px',
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: 40, lineHeight: 1 }}>⚠️</div>
          <h1 style={{ fontSize: 20, margin: '16px 0 8px', fontWeight: 600 }}>
            Something went wrong
          </h1>
          <p style={{ color: '#475569', fontSize: 14, margin: '0 0 24px' }}>
            An unexpected error occurred while loading the application. It is
            usually fixed by reloading the page — your data is safe.
          </p>
          <div
            style={{
              display: 'flex',
              gap: 12,
              justifyContent: 'center',
              flexWrap: 'wrap',
            }}
          >
            <button
              onClick={() => reset()}
              style={{
                background: '#2563eb',
                color: '#ffffff',
                border: 'none',
                borderRadius: 8,
                padding: '10px 20px',
                fontSize: 14,
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              Try again
            </button>
            <button
              onClick={() => window.location.reload()}
              style={{
                background: '#ffffff',
                color: '#0f172a',
                border: '1px solid #cbd5e1',
                borderRadius: 8,
                padding: '10px 20px',
                fontSize: 14,
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              Reload page
            </button>
          </div>
          {error?.digest ? (
            <p
              style={{
                color: '#94a3b8',
                fontSize: 12,
                margin: '20px 0 0',
                fontFamily: 'monospace',
              }}
            >
              Error ID: {error.digest}
            </p>
          ) : null}
        </div>
      </body>
    </html>
  )
}
