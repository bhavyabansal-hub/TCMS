// Node.js-only boot work, loaded by src/instrumentation.ts ONLY when
// NEXT_RUNTIME === 'nodejs'. Keeping every Node API (process.exit, signals,
// fs via the logger, the DB guards) in this file means the Edge compile of
// instrumentation.ts never sees them (no "Node.js API in Edge Runtime" warnings).
//
// 1. PROCESS-LEVEL ERROR CAPTURE: unhandled promise rejections and uncaught
//    exceptions flow into the SAME structured logger the request layer uses
//    (console + rotating files + the optional Telegram logs bot), so an ops
//    person sees one consistent "[tcms] <time> LEVEL message" stream. It
//    deliberately does NOT swallow errors: after logging, the default Node
//    behaviour (crash) is preserved for uncaughtException-class failures.
// 2. GRACEFUL SHUTDOWN: on SIGTERM/SIGINT the Prisma connection pool is
//    closed before exit, so the database never accumulates orphaned
//    connections after a redeploy or container stop (a closed pool is also
//    what lets MySQL reclaim the slots immediately instead of waiting
//    for TCP keepalive).
export async function registerNode() {
  // PRODUCTION STARTUP GUARD — the FIRST thing that runs, before any other
  // module (logger, db, config) can touch a secret. When
  // TCMS_DEPLOY_ENV=production and any required secret is missing, too weak,
  // or a known placeholder: prints named-variable reasons (never values) and
  // process.exit(1) — before the server accepts a single request. Otherwise
  // it prints the one-line state ("production guard ACTIVE" / "OFF (sandbox
  // mode)") that the go-live smoke test greps for. Full contract:
  // src/lib/server/startup-guard.ts + .env.example.
  const { assertAppStartup } = await import('./lib/server/startup-guard')
  assertAppStartup()

  // PRODUCTION DB SETTINGS GUARD — the SECOND boot gate (task
  // db-settings-guard-1): after the secrets are proven real, prove the MySQL
  // server itself is safe. With TCMS_DEPLOY_ENV=production this reads the
  // SESSION @@sql_mode / @@time_zone / @@character_set_server /
  // @@transaction_isolation on the app's own connection plus the schema's
  // default charset (information_schema.SCHEMATA), retries an unreachable
  // database 5× 3 s apart, and exits 1 (before any port opens) when
  // sql_mode lacks STRICT_TRANS_TABLES/ONLY_FULL_GROUP_BY, the time zone is
  // not UTC, or server/schema charset is not utf8mb4.
  // transaction_isolation is printed, never fails (concurrency task owns it).
  // Sandbox: one OFF line, nothing else. Full contract:
  // src/lib/server/db-settings-guard.ts + docs/deploy/PRODUCTION-CHECKLIST.md §2.
  const { runDbSettingsGuard } = await import('./lib/server/db-settings-guard')
  await runDbSettingsGuard()

  const { logger } = await import('./lib/logger')

  // Narrow the typing so the bundler's parser (which sees a DOM-only lib for
  // this file) does not complain about Node's process event overloads.
  const nodeProcess = process as unknown as {
    on: (event: string, listener: (arg: unknown) => void) => void
  }
  nodeProcess.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', reason)
  })
  nodeProcess.on('uncaughtException', (err) => {
    // Log then rethrow: the process is in an undefined state after an
    // uncaught exception, so we log and let Node exit.
    logger.error('Uncaught exception — process will exit', err)
    throw err
  })

  // Graceful exit: close the singleton DB pool, then leave. The 3s cap keeps
  // a hung disconnect from delaying a container stop.
  async function gracefulShutdown(signal: string) {
    try {
      logger.info(`${signal} received — closing the database pool before exit`)
      const { db } = await import('./lib/db')
      await Promise.race([db.$disconnect(), new Promise((r) => setTimeout(r, 3_000))])
    } catch {
      /* the pool may already be gone — nothing to do */
    }
    process.exit(0)
  }
  nodeProcess.on('SIGTERM', () => void gracefulShutdown('SIGTERM'))
  nodeProcess.on('SIGINT', () => void gracefulShutdown('SIGINT'))

  // INDEPENDENT BACKUP STALENESS CHECK (second safety net, TASK B): the
  // scheduler's --check-stale lives only in the scheduler process, so a dead
  // scheduler would silence the stale-backup alert. This runs in the Next
  // server process instead: once after boot, then daily at UTC midnight,
  // raising the same backup_failed alert when the newest VALID backup is
  // older than 26 h. Fire-and-forget — never throws into boot or requests;
  // OFF by itself when no backup dir exists. Full contract:
  // src/lib/server/backup-health.ts + docs/17.
  const { startBackupHealthMonitor } = await import('./lib/server/backup-health')
  startBackupHealthMonitor()

  logger.info('Instrumentation registered: process-level error capture + graceful shutdown active')
}
