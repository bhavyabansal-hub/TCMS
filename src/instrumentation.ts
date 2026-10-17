// Next.js instrumentation hook — runs ONCE per server process at boot.
// The NEXT_RUNTIME check is replaced at build time, so the Edge bundle drops
// the import and never sees Node-only code. Everything Node-only lives in
// src/instrumentation-node.ts (startup + DB guards, logger, error capture,
// graceful shutdown, backup monitor).
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { registerNode } = await import('./instrumentation-node')
    await registerNode()
  }
}
