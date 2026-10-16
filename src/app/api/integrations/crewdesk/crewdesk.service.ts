// Crew Desk service — orchestration between TCMS and the single-file client.
//
// Owns: the THREE modes (manual | test | live), duplicate guard, the
// SHARED-ACCOUNT comment flow (every comment is posted as the shared service
// account configured via CREWDESK_USER_ID — one account for all linkers, no
// personal tokens), the verification-ONLY email check that runs BEFORE any
// post (test/live only; manual mode makes no Crew Desk calls), the
// "lookup -> comment -> history row" flow, friendly failure mapping (every
// failure keeps the user's input in a failed history row so Retry works),
// and serialization. All Crew Desk HTTP goes through
// src/lib/server/crewdesk.client.ts — no other file may call Crew Desk.

import { ApiError, getPagination, paginate, type PaginatedResponse } from '@/lib/api'
import { can } from '@/lib/auth'
import { isDuplicateKeyError } from '@/lib/server/db-errors'
import {
  CrewDeskError,
  crewDeskAccount,
  crewDeskConfig,
  credentialExpiresAt,
  getTicket,
  postTicketComment,
  testAllowedTicketId,
} from '@/lib/server/crewdesk.client'
import { logger } from '@/lib/logger'
import { CREWDESK_BASE_URL_SET } from '@/lib/server/config'
import { assertEmailVerifiedBeforePosting, verifyCrewDeskEmail } from './crewdesk.identity'
import {
  countLinks,
  findLinkById,
  findLinkByModuleAndTicket,
  findLinkWithNamesById,
  findModuleBasic,
  insertLink,
  listLinks,
  updateLinkOutcome,
  type CrewDeskLinkRowWithNames,
  type CrewDeskLinkSqlRow,
} from './crewdesk.repository'
import { sanitizeNote } from './crewdesk.validation'

// ---------- Serialization ----------

export interface SerializedCrewDeskLink {
  linkId: string
  moduleId: string
  moduleName: string
  ticketId: string
  ticketTitle: string | null
  ticketStatus: string | null
  crewdeskCommentId: string | null
  status: 'posted' | 'failed' | 'manual'
  lastError: string | null
  linkedById: string
  linkedByName: string
  note: string | null
  createdAt: string
  updatedAt: string
}

function serializeLink(row: CrewDeskLinkRowWithNames): SerializedCrewDeskLink {
  return {
    linkId: row.link_id,
    moduleId: row.module_id,
    moduleName: row.module_name,
    ticketId: row.ticket_id,
    ticketTitle: row.ticket_title,
    ticketStatus: row.ticket_status,
    crewdeskCommentId: row.crewdesk_comment_id,
    status: row.status as 'posted' | 'failed' | 'manual',
    lastError: row.last_error,
    linkedById: row.linked_by_id,
    linkedByName: row.linked_by_name,
    note: row.note,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

// ---------- The comment builder (ONE source for posted AND manual text) ----------

export interface LinkCommentInput {
  moduleName: string
  /** Bare absolute module URL (no markdown) — Crew Desk renders it clickable. */
  moduleUrl: string
  linkedByName: string
  linkedByEmail: string
  /** Already-sanitized note (plain text, <=300 chars) or null. */
  note: string | null
}

/**
 * The single source of the comment text:
 *   line 1: module link
 *   line 2: "Linked by <name and email from the TCMS login>"
 *   line 3: the optional note the user typed
 * Used by the automatic post AND by manual mode's "Copy comment".
 */
export function buildLinkComment(input: LinkCommentInput): string {
  const lines = [
    `TCMS: test cases for module "${input.moduleName}" — ${input.moduleUrl}`,
    `Linked by ${input.linkedByName} (${input.linkedByEmail})`,
  ]
  if (input.note) lines.push(input.note)
  return lines.join('\n')
}

// ---------- Queries ----------

/** STRICT integration gate: every Crew Desk endpoint (reads included) is for
 *  roles holding manage_integrations. The sidebar hides the Integrations tab
 *  without it and the API enforces it independently — no UI-bypass path. */
function ensureCanManageLinks(role: string): void {
  if (!can(role, 'manage_integrations')) {
    throw ApiError.forbidden('Only roles with the manage-integrations permission can use Crew Desk integrations')
  }
}

/** GET /api/integrations/crewdesk — link history, newest first. */
export async function listCrewDeskLinks(
  me: { userId: string; role: string },
  q: Record<string, string>
): Promise<PaginatedResponse<SerializedCrewDeskLink>> {
  ensureCanManageLinks(me.role)
  const { page, pageSize, offset } = getPagination(q, 50)
  const [total, rows] = await Promise.all([countLinks(), listLinks(pageSize, offset)])
  return paginate(rows.map(serializeLink), total, page, pageSize)
}

/** GET ?path=config — safe integration summary for UI banners (no secrets). */
export function crewDeskInfo(me: { role: string }) {
  ensureCanManageLinks(me.role)
  const cfg = crewDeskConfig()
  // The shared service account whose credentials post every comment (display only).
  const account = crewDeskAccount()
  return {
    mode: cfg.mode,
    baseUrlSet: CREWDESK_BASE_URL_SET,
    authMode: cfg.authMode,
    authConfigured: cfg.authMode !== 'none',
    timeoutMs: cfg.timeoutMs,
    testTicketId: testAllowedTicketId(),
    accountEmail: account?.email ?? null,
    // Fixed-token mode: surface expiry (ISO, non-secret) so the UI can warn
    // before an hourly dev token dies mid-test. Login mode: null (auto-refresh).
    credentialExpiresAt: credentialExpiresAt(),
  }
}

/** GET ?path=email-check — the badge: "verified in Crew Desk" / "not found". */
export async function checkMyCrewDeskEmail(me: { userId: string; email: string; role: string }) {
  ensureCanManageLinks(me.role)
  // Manual mode makes NO Crew Desk calls — answer from the stored check only.
  const allowNetwork = crewDeskConfig().mode !== 'manual'
  let result
  try {
    result = await verifyCrewDeskEmail(me, { allowNetwork })
  } catch (err) {
    // Crew Desk unreachable / misconfigured: the BADGE degrades to a 502 with
    // the friendly message (never a bare 500, never a session-killing 401).
    if (err instanceof CrewDeskError) {
      const status = err.code === 'timeout' ? 504 : 502
      throw new ApiError(status, err.message)
    }
    throw err
  }
  return {
    status: result.status,
    crewdeskUserId: result.crewdeskUserId,
    checkedAt: result.checkedAt,
    mode: crewDeskConfig().mode,
  }
}

/** POST ?path=lookup — fetch the ticket so the UI can show title + status BEFORE submitting. */
export async function lookupCrewDeskTicket(
  me: { userId: string; role: string },
  ticketId: string
): Promise<{ ticketId: string; title: string; status: string; mode: 'manual' | 'test' | 'live'; canLinkInCurrentMode: boolean }> {
  ensureCanManageLinks(me.role)
  if (crewDeskConfig().mode === 'manual') {
    throw ApiError.badRequest('Manual mode makes no Crew Desk calls — generate the comment instead.')
  }
  let ticket
  try {
    ticket = await getTicket(ticketId)
  } catch (err) {
    // Map the client error taxonomy onto HTTP: "Ticket not found" stays a 404;
    // upstream auth/availability problems are 502/504 — deliberately NOT 401,
    // so expired Crew Desk credentials can never be mistaken for a dead TCMS
    // session (the browser client would otherwise kill the user's session).
    if (err instanceof CrewDeskError) {
      const status = err.code === 'not_found' ? 404 : err.code === 'timeout' ? 504 : 502
      throw new ApiError(status, err.message)
    }
    throw err
  }
  const cfg = crewDeskConfig()
  return {
    ticketId: ticket.id,
    title: ticket.title,
    status: ticket.status,
    mode: cfg.mode,
    canLinkInCurrentMode: cfg.mode === 'live' || ticket.id === testAllowedTicketId(),
  }
}

/**
 * GET ?path=comment&linkId=... — rebuild the comment text of ANY history row
 * from its stored fields (module link + "Linked by" + note). Powers the
 * "Copy comment" button: manual rows get the exact text they would post, and
 * posted rows can be copied again for future use.
 */
export async function buildCommentForLink(
  me: { userId: string; role: string },
  linkId: string,
  publicOrigin: string
): Promise<{ comment: string; moduleUrl: string }> {
  ensureCanManageLinks(me.role)
  const link = await findLinkWithNamesById(linkId)
  if (!link) throw ApiError.notFound('Link not found')
  const moduleUrl = `${publicOrigin}/modules/${link.module_id}`
  const comment = buildLinkComment({
    moduleName: link.module_name,
    moduleUrl,
    linkedByName: link.linked_by_name,
    linkedByEmail: link.linked_by_email ?? '',
    note: sanitizeNote(link.note),
  })
  return { comment, moduleUrl }
}

// ---------- Commands ----------

/**
 * POST /api/integrations/crewdesk — create a module<->ticket link.
 *
 * test/live modes: role gate -> module exists -> duplicate guard ->
 * verification-only EMAIL CHECK (stop before posting when not found) ->
 * getTicket (fresh status) -> post comment (form-data, shared service
 * account, current status) -> history row.
 *
 * manual mode: role gate -> module exists -> NO Crew Desk call at all — the
 * generated comment (same builder) is stored as a 'manual' history row and
 * returned so the UI can offer "Copy comment" / "Copy module link".
 *
 * The linker's identity rides in the comment as an automatic "Linked by"
 * line plus their optional sanitized note (plain text, <=300 chars). ANY
 * failure in test/live after the duplicate guard still writes a FAILED
 * history row carrying the user's input, so Retry can pick it up.
 */
export async function createCrewDeskLink(
  me: SessionUserLike,
  input: { moduleId: string; ticketId: string; note: string | null },
  publicOrigin: string
): Promise<SerializedCrewDeskLink> {
  ensureCanManageLinks(me.role)
  const moduleRow = await findModuleBasic(input.moduleId)
  if (!moduleRow) throw ApiError.notFound('Module not found')

  const mode = crewDeskConfig().mode
  const moduleUrl = `${publicOrigin}/modules/${input.moduleId}`
  const commentText = buildLinkComment({
    moduleName: moduleRow.name,
    moduleUrl,
    linkedByName: me.fullName,
    linkedByEmail: me.email,
    note: input.note,
  })

  // ----- MANUAL MODE: zero Crew Desk traffic -----
  if (mode === 'manual') {
    const row = await insertLink({
      moduleId: input.moduleId,
      ticketId: input.ticketId,
      linkedById: me.userId,
      status: 'manual',
      ticketTitle: null,
      ticketStatus: null,
      crewdeskCommentId: null,
      lastError: null,
      note: input.note,
    })
    logger.info('Crew Desk manual copy generated', { linkId: row.link_id })
    const named = await findLinkWithNamesById(row.link_id)
    return serializeLink(named ?? { ...row, module_name: moduleRow.name, linked_by_name: me.fullName, linked_by_email: me.email })
  }

  // ----- TEST / LIVE MODES -----
  const dup = await findLinkByModuleAndTicket(input.moduleId, input.ticketId)
  if (dup && dup.status !== 'manual') {
    // A manual copy never blocks the real link (nothing was posted to Crew Desk).
    throw ApiError.conflict(
      `This module is already linked to ticket ${dup.ticket_id}. Open the Integrations page to view or retry it.`
    )
  }

  // Every failure below is recorded as a failed link (never a bare 500) so
  // the UI keeps what the user typed and offers Retry.
  let outcome: LinkOutcome
  try {
    outcome = await computeLinkOutcome(input, me, moduleRow.name, publicOrigin)
  } catch (err) {
    outcome = failedOutcome(err)
  }
  let row: CrewDeskLinkSqlRow
  try {
    row = await insertLink({
      moduleId: input.moduleId,
      ticketId: input.ticketId,
      linkedById: me.userId,
      status: outcome.status,
      ticketTitle: outcome.ticketTitle,
      ticketStatus: outcome.ticketStatus,
      crewdeskCommentId: outcome.crewdeskCommentId,
      lastError: outcome.lastError,
      note: input.note,
    })
  } catch (err) {
    // The (module_id, ticket_id) UNIQUE index is the LAST-LINE duplicate
    // guard: two teammates clicking "Link" at the same moment both pass the
    // pre-check, but only one INSERT can win. Surface that as the same
    // friendly 409 the pre-check produces instead of an opaque 500.
    // MySQL duplicate key (1062): turns the duplicate-link race into a 409.
    if (isDuplicateKeyError(err)) {
      throw ApiError.conflict(
        `This module is already linked to ticket ${input.ticketId}. Open the Integrations page to view or retry it.`
      )
    }
    throw err
  }
  if (outcome.status === 'posted') {
    logger.info('Crew Desk link created', { linkId: row.link_id, ticketId: input.ticketId, commentId: outcome.crewdeskCommentId })
  } else {
    logger.warn('Crew Desk link attempt failed', { linkId: row.link_id, ticketId: input.ticketId })
  }
  const named = await findLinkWithNamesById(row.link_id)
  return serializeLink(named ?? { ...row, module_name: moduleRow.name, linked_by_name: me.fullName, linked_by_email: me.email })
}

/**
 * GET ?path=preview-comment&moduleId=...&note=... — the EXACT comment text a
 * link WOULD post, built from the module + the caller's identity + the note.
 * No Crew Desk call, no database row: this powers the "Copy comment" /
 * "Copy module link" buttons in the form BEFORE linking, so the user can
 * always fall back to pasting the link into Crew Desk manually.
 */
export async function previewCrewDeskComment(
  me: SessionUserLike,
  moduleId: string,
  note: string | null,
  publicOrigin: string
): Promise<{ comment: string; moduleUrl: string }> {
  ensureCanManageLinks(me.role)
  const moduleRow = await findModuleBasic(moduleId)
  if (!moduleRow) throw ApiError.notFound('Module not found')
  const moduleUrl = `${publicOrigin}/modules/${moduleId}`
  const comment = buildLinkComment({
    moduleName: moduleRow.name,
    moduleUrl,
    linkedByName: me.fullName,
    linkedByEmail: me.email,
    note: sanitizeNote(note),
  })
  return { comment, moduleUrl }
}

/**
 * POST ?path=retry&linkId=... — re-run a failed link (fresh ticket status,
 * stored note, email check re-run). Any role holding manage_integrations can
 * retry any link — integration management is a team-level ability, not
 * per-row ownership.
 */
export async function retryCrewDeskLink(
  me: SessionUserLike,
  linkId: string,
  publicOrigin: string
): Promise<SerializedCrewDeskLink> {
  ensureCanManageLinks(me.role)
  const link = await findLinkById(linkId)
  if (!link) throw ApiError.notFound('Link not found')
  if (link.status === 'posted') throw ApiError.conflict('This link is already posted — nothing to retry.')
  if (link.status === 'manual') throw ApiError.conflict('Manual copies make no Crew Desk calls — generate a new copy instead.')

  const moduleRow = await findModuleBasic(link.module_id)
  if (!moduleRow) throw ApiError.notFound('The module of this link no longer exists.')

  let outcome: LinkOutcome
  try {
    outcome = await computeLinkOutcome(
      { moduleId: link.module_id, ticketId: link.ticket_id, note: link.note },
      me,
      moduleRow.name,
      publicOrigin
    )
  } catch (err) {
    outcome = failedOutcome(err)
  }
  await updateLinkOutcome(linkId, outcome)
  const named = await findLinkWithNamesById(linkId)
  return serializeLink(named ?? { ...link, ...outcome, module_name: moduleRow.name, linked_by_name: me.fullName, linked_by_email: me.email })
}

// ---------- Internal flow shared by create + retry ----------

interface SessionUserLike {
  userId: string
  email: string
  role: string
  fullName: string
}

interface LinkOutcome {
  status: 'posted' | 'failed'
  ticketTitle: string | null
  ticketStatus: string | null
  crewdeskCommentId: string | null
  lastError: string | null
}

function failedOutcome(err: unknown): LinkOutcome {
  const reason = err instanceof CrewDeskError ? err.message : 'Unexpected error while contacting Crew Desk.'
  if (!(err instanceof CrewDeskError)) logger.warn('Crew Desk unexpected error', { err: String(err) })
  return { status: 'failed', ticketTitle: null, ticketStatus: null, crewdeskCommentId: null, lastError: reason }
}

/**
 * The test/live posting pipeline:
 *   1. verification-only EMAIL CHECK — stops BEFORE posting with the exact
 *      product message when the linker's email is not in Crew Desk;
 *   2. fresh getTicket — never trusts a stale snapshot (the comment echoes
 *      the ticket's CURRENT status);
 *   3. post as the SHARED service account (CREWDESK_USER_ID).
 * Throws CrewDeskError on any failure (callers convert to failed rows).
 */
async function computeLinkOutcome(
  input: { moduleId: string; ticketId: string; note: string | null },
  me: SessionUserLike,
  moduleName: string,
  publicOrigin: string
): Promise<LinkOutcome> {
  // 1. Email check FIRST — nothing is sent when it does not pass.
  await assertEmailVerifiedBeforePosting(me)

  // 2. Fresh ticket data — the comment echoes the CURRENT status.
  const ticket = await getTicket(input.ticketId)

  // 3. Same builder as manual mode's Copy button — one text everywhere.
  const content = buildLinkComment({
    moduleName,
    moduleUrl: `${publicOrigin}/modules/${input.moduleId}`,
    linkedByName: me.fullName,
    linkedByEmail: me.email,
    note: sanitizeNote(input.note),
  })

  const posted = await postTicketComment({
    ticketId: input.ticketId,
    content,
    // The comments endpoint validates `status` against SLUGS — sending the
    // display name ("In Progress") or the id ("4") is rejected with
    // "Invalid status" (verified against the dev backend 2026-10-09).
    ticketStatus: ticket.statusSlug ?? ticket.status,
  })
  return { status: 'posted', ticketTitle: ticket.title, ticketStatus: ticket.status, crewdeskCommentId: posted.commentId, lastError: null }
}
