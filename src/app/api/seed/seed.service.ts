// Seed service — demo-data generator (behavior spec: legacy src/app/api/seed/route.ts).
//
// Orchestration only: idempotency check, then the exact legacy demo content
// (4 accounts, 3 root modules + 2 submodules each, 5 test cases, 3 bugs,
// 2 daily task reports) written through the seed repository.
//
// Idempotent: if any user already exists it does nothing, so triggering the
// endpoint repeatedly is harmless (legacy parity — response shape preserved).
//
// Transaction choice: the whole seed runs in ONE atomic transaction
// (via runSeedInTransaction from the repository — the service never touches
// the db client). Legacy inserted sequentially with auto-commit, so a
// mid-seed failure left partial demo data that then blocked re-seeding via
// the users>0 check. Atomicity is a strict improvement with no behavior
// change on the success path; every statement is still the same raw SQL.
//
// NOTE: legacy writes NO review requests/events, notifications or activity
// log rows for seed data — this port preserves that (no logActivity, no
// createNotification, no inserts into those tables).

import { hashPassword } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { REFERENCE_CACHE_PREFIX, invalidateCache } from '@/lib/server/cache'
import {
  countUsers,
  insertSeedBug,
  insertSeedModule,
  insertSeedTaskReport,
  insertSeedTestCase,
  insertSeedUser,
  runSeedInTransaction,
  type SeedTaskItem,
} from './seed.repository'

export type SeedResult =
  | { seeded: false; message: string }
  | {
      seeded: true
      users: string[]
      modules: number
      testCases: number
      bugs: number
      taskReports: number
    }

/** Seeds demo data. Safe to call repeatedly: no-ops when users exist. */
export async function seedDemoData(): Promise<SeedResult> {
  // Idempotency (legacy): only seed if no users exist.
  const userCount = await countUsers()
  if (userCount > 0) {
    return { seeded: false, message: 'Database already has users; skipping seed.' }
  }

  const result: SeedResult = await runSeedInTransaction(async (tx): Promise<SeedResult> => {
    // 7 demo accounts covering the full 6-role hierarchy (VP -> Viewer);
    // admin@tcms.com remains the top admin (now the VP role).
    const admin = await insertSeedUser(
      { email: 'admin@tcms.com', fullName: 'Alice Admin', passwordHash: hashPassword('Admin@123'), role: 'vp' },
      tx
    )
    const lead = await insertSeedUser(
      { email: 'teamlead@tcms.com', fullName: 'Leo Lead', passwordHash: hashPassword('Lead@123'), role: 'manager' },
      tx
    )
    const product = await insertSeedUser(
      { email: 'product@tcms.com', fullName: 'Paula Product', passwordHash: hashPassword('Product@123'), role: 'product' },
      tx
    )
    const developer = await insertSeedUser(
      { email: 'developer@tcms.com', fullName: 'Devon Developer', passwordHash: hashPassword('Dev@12345'), role: 'developer' },
      tx
    )
    const qa1 = await insertSeedUser(
      { email: 'qa1@tcms.com', fullName: 'Quinn Tester', passwordHash: hashPassword('QA@12345'), role: 'qa_engineer' },
      tx
    )
    const qa2 = await insertSeedUser(
      { email: 'qa2@tcms.com', fullName: 'Quincy Quality', passwordHash: hashPassword('QA@12345'), role: 'qa_engineer' },
      tx
    )
    const viewer = await insertSeedUser(
      { email: 'viewer@tcms.com', fullName: 'Vera Viewer', passwordHash: hashPassword('View@12345'), role: 'viewer' },
      tx
    )
    // 3 root modules + 2 submodules each. Legacy materialised paths, kept
    // exactly: root path = '' (depth 0), submodule path = the PARENT'S
    // generated id (depth 1) — which is why each root insert RETURNs its
    // generated module_id before the submodules are created.
    const rootModules = ['Authentication', 'Payment', 'Shipping']
    const moduleIds: string[] = []
    for (const name of rootModules) {
      const rootId = await insertSeedModule(
        {
          name,
          description: `${name} module`,
          parentId: null,
          path: '',
          depth: 0,
          ownerId: lead.userId,
          createdById: admin.userId,
          updatedById: admin.userId,
        },
        tx
      )
      moduleIds.push(rootId)
      const sub1Id = await insertSeedModule(
        {
          name: `${name} - Login`,
          description: `Login flow for ${name}`,
          parentId: rootId,
          path: rootId,
          depth: 1,
          ownerId: lead.userId,
          createdById: admin.userId,
          updatedById: admin.userId,
        },
        tx
      )
      const sub2Id = await insertSeedModule(
        {
          name: `${name} - Validation`,
          description: `Input validation for ${name}`,
          parentId: rootId,
          path: rootId,
          depth: 1,
          ownerId: lead.userId,
          createdById: admin.userId,
          updatedById: admin.userId,
        },
        tx
      )
      moduleIds.push(sub1Id, sub2Id)
    }

    // 5 sample test cases across modules in various statuses — titles,
    // priorities, statuses and tags preserved verbatim from the legacy seed.
    // moduleIds follows the legacy array order:
    // [0] Auth root, [1] Auth-Login, [2] Auth-Validation,
    // [3] Payment root, [4] Payment-Login, [5] Payment-Validation,
    // [6] Shipping root, [7] Shipping-Login, [8] Shipping-Validation.
    const tcData: {
      moduleId: string
      title: string
      description: string
      preconditions: string
      expectedResult: string
      priority: string
      status: string
      authorId: string
      tags: string[]
    }[] = [
      {
        moduleId: moduleIds[1], // Authentication - Login
        title: 'User can log in with valid credentials',
        description: 'Verify that a registered user can log in using a valid email and password.',
        preconditions: 'User account exists and is active.',
        expectedResult: 'User lands on the dashboard with session active.',
        priority: 'P0',
        status: 'approved',
        authorId: qa1.userId,
        tags: ['smoke', 'auth'],
      },
      {
        moduleId: moduleIds[4], // Payment - Login
        title: 'Payment with expired card is rejected',
        description: 'Verify that expired credit cards are rejected at checkout.',
        preconditions: 'User has items in cart.',
        expectedResult: 'Payment is rejected with "card expired" error message.',
        priority: 'P1',
        status: 'in_review',
        authorId: qa2.userId,
        tags: ['payment', 'regression'],
      },
      {
        moduleId: moduleIds[7], // Shipping - Login
        title: 'Shipping address validation for international orders',
        description: 'Verify that international addresses require a postal code.',
        preconditions: 'User is on shipping step of checkout.',
        expectedResult: 'Form cannot be submitted without postal code for India.',
        priority: 'P2',
        status: 'draft',
        authorId: qa1.userId,
        tags: ['shipping', 'validation'],
      },
      {
        moduleId: moduleIds[2], // Authentication - Validation
        title: 'Email format validation on registration',
        description: 'Verify that invalid email formats are rejected at signup.',
        preconditions: 'None.',
        expectedResult: 'Submit button stays disabled; error shown.',
        priority: 'P2',
        status: 'needs_revision',
        authorId: qa2.userId,
        tags: ['auth', 'validation'],
      },
      {
        moduleId: moduleIds[5], // Payment - Validation
        title: 'Refund processing for partial returns',
        description: 'Verify that partial refunds are calculated correctly.',
        preconditions: 'Order has at least 2 line items.',
        expectedResult: 'Refund amount matches the returned item value.',
        priority: 'P1',
        status: 'active',
        authorId: qa1.userId,
        tags: ['payment', 'refund'],
      },
    ]
    for (const t of tcData) {
      await insertSeedTestCase(
        {
          ...t,
          version: 1,
          lastEditedById: t.authorId,
          assigneeId: lead.userId,
        },
        tx
      )
    }

    // 3 sample bugs — severities/statuses and the resolved->resolved_at rule
    // preserved exactly from the legacy seed.
    const bugData: {
      title: string
      description: string
      severity: string
      status: string
      environment: string
      stepsToReproduce: string
      expectedBehaviour: string
      actualBehaviour: string
      reportedById: string
      assignedToId: string
      moduleId: string
    }[] = [
      {
        title: 'Login button unresponsive on Safari 17',
        description: 'Clicking "Sign In" on Safari 17.0 does nothing. Works on Chrome.',
        severity: 'high',
        status: 'open',
        environment: 'staging',
        stepsToReproduce: 'Open /login on Safari 17, fill valid creds, click Sign In.',
        expectedBehaviour: 'User is logged in.',
        actualBehaviour: 'Nothing happens; no network request fired.',
        reportedById: qa1.userId,
        assignedToId: lead.userId,
        moduleId: moduleIds[1],
      },
      {
        title: 'Payment failure shows wrong error code',
        description: 'When card is declined, the UI shows "ERR_NETWORK" instead of "card_declined".',
        severity: 'medium',
        status: 'in_progress',
        environment: 'production',
        stepsToReproduce: 'Use test card 4000000000000002.',
        expectedBehaviour: 'Show "card_declined" error.',
        actualBehaviour: 'Shows "ERR_NETWORK".',
        reportedById: qa2.userId,
        assignedToId: lead.userId,
        moduleId: moduleIds[4],
      },
      {
        title: 'Shipping cost not recalculated on address change',
        description: 'Changing the shipping address does not update the shipping cost line item.',
        severity: 'critical',
        status: 'resolved',
        environment: 'staging',
        stepsToReproduce: 'Add item, go to shipping, change country.',
        expectedBehaviour: 'Shipping cost recalculates.',
        actualBehaviour: 'Old shipping cost persists.',
        reportedById: qa1.userId,
        assignedToId: lead.userId,
        moduleId: moduleIds[7],
      },
    ]
    for (const b of bugData) {
      await insertSeedBug(
        { ...b, resolvedAt: b.status === 'resolved' ? new Date() : null },
        tx
      )
    }

    // 2 sample task reports — dates relative to now (today / today-24h),
    // per-task module links and totals preserved exactly.
    const today = new Date()
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000)
    const taskReports: {
      reportedById: string
      reportDate: Date
      tasks: SeedTaskItem[]
      notes: string
      totalMinutes: number
    }[] = [
      {
        reportedById: qa1.userId,
        reportDate: today,
        tasks: [
          { description: 'Wrote test cases for login flow', timeSpentMinutes: 120, moduleId: moduleIds[1], testCaseId: null, bugId: null, status: 'done' },
          { description: 'Investigated Safari login bug', timeSpentMinutes: 60, moduleId: null, testCaseId: null, bugId: null, status: 'in_progress' },
        ],
        notes: 'Need to coordinate with frontend on Safari fix.',
        totalMinutes: 180,
      },
      {
        reportedById: qa2.userId,
        reportDate: yesterday,
        tasks: [
          { description: 'Reviewed payment test cases', timeSpentMinutes: 90, moduleId: moduleIds[4], testCaseId: null, bugId: null, status: 'done' },
          { description: 'Updated refund test case', timeSpentMinutes: 45, moduleId: moduleIds[5], testCaseId: null, bugId: null, status: 'done' },
        ],
        notes: '',
        totalMinutes: 135,
      },
    ]
    for (const r of taskReports) {
      await insertSeedTaskReport(r, tx)
    }

    logger.info('Demo data seeded', {
      users: 4,
      modules: moduleIds.length,
      testCases: tcData.length,
      bugs: bugData.length,
      taskReports: taskReports.length,
    })

    // Success payload: every seeded account email.
    return {
      seeded: true,
      users: [admin.email, lead.email, product.email, developer.email, qa1.email, qa2.email, viewer.email],
      modules: moduleIds.length,
      testCases: tcData.length,
      bugs: bugData.length,
      taskReports: 2,
    }
  })
  // Seed writes bypass logActivity: drop the cached reference data and stats
  // after the commit so the new rows show at once.
  invalidateCache(REFERENCE_CACHE_PREFIX)
  invalidateCache('stats:')
  return result
}
