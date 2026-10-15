// Crew Desk link repository — the ONLY place Crew Desk link SQL lives.
// Raw SQL through Prisma tagged templates (parameterized, pooler-safe).

import { db } from '@/lib/db'
import { newId } from '@/lib/server/id'

export interface CrewDeskLinkSqlRow {
  link_id: string
  module_id: string
  ticket_id: string
  ticket_title: string | null
  ticket_status: string | null
  crewdesk_comment_id: string | null
  status: string
  last_error: string | null
  linked_by_id: string
  note: string | null
  created_at: Date
  updated_at: Date
}

export interface CrewDeskLinkRowWithNames extends CrewDeskLinkSqlRow {
  module_name: string
  linked_by_name: string
  linked_by_email: string
}

export async function findLinkByModuleAndTicket(
  moduleId: string,
  ticketId: string
): Promise<CrewDeskLinkSqlRow | null> {
  const rows = await db.$queryRaw<CrewDeskLinkSqlRow[]>`
    SELECT link_id, module_id, ticket_id, ticket_title, ticket_status,
           crewdesk_comment_id, status, last_error, linked_by_id, note, created_at, updated_at
    FROM crew_desk_links
    WHERE module_id = ${moduleId} AND ticket_id = ${ticketId}
    LIMIT 1`
  return rows[0] ?? null
}

export async function findLinkById(linkId: string): Promise<CrewDeskLinkSqlRow | null> {
  const rows = await db.$queryRaw<CrewDeskLinkSqlRow[]>`
    SELECT link_id, module_id, ticket_id, ticket_title, ticket_status,
           crewdesk_comment_id, status, last_error, linked_by_id, note, created_at, updated_at
    FROM crew_desk_links
    WHERE link_id = ${linkId}
    LIMIT 1`
  return rows[0] ?? null
}

export async function insertLink(input: {
  moduleId: string
  ticketId: string
  linkedById: string
  status: 'posted' | 'failed' | 'manual'
  ticketTitle?: string | null
  ticketStatus?: string | null
  crewdeskCommentId?: string | null
  lastError?: string | null
  note?: string | null
}): Promise<CrewDeskLinkSqlRow> {
  // MySQL has no RETURNING: generate the PK app-side, insert, then read back.
  const linkId = newId()
  await db.$executeRaw`
    INSERT INTO crew_desk_links
      (link_id, module_id, ticket_id, linked_by_id, status, ticket_title, ticket_status, crewdesk_comment_id, last_error, note, created_at, updated_at)
    VALUES (${linkId}, ${input.moduleId}, ${input.ticketId}, ${input.linkedById}, ${input.status},
            ${input.ticketTitle ?? null}, ${input.ticketStatus ?? null},
            ${input.crewdeskCommentId ?? null}, ${input.lastError ?? null}, ${input.note ?? null}, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`
  const created = await findLinkById(linkId)
  if (!created) throw new Error('Inserted Crew Desk link could not be read back')
  return created
}

export async function updateLinkOutcome(
  linkId: string,
  outcome: {
    status: 'posted' | 'failed'
    ticketTitle?: string | null
    ticketStatus?: string | null
    crewdeskCommentId?: string | null
    lastError?: string | null
  }
): Promise<CrewDeskLinkSqlRow> {
  // MySQL: UPDATE has no RETURNING — write, then read the row back.
  await db.$executeRaw`
    UPDATE crew_desk_links
    SET status = ${outcome.status},
        ticket_title = ${outcome.ticketTitle ?? null},
        ticket_status = ${outcome.ticketStatus ?? null},
        crewdesk_comment_id = ${outcome.crewdeskCommentId ?? null},
        last_error = ${outcome.lastError ?? null},
        updated_at = UTC_TIMESTAMP(3)
    WHERE link_id = ${linkId}`
  const updated = await findLinkById(linkId)
  if (!updated) throw new Error('Updated Crew Desk link could not be read back')
  return updated
}

/** Single row with the JOINed names — used right after insert/update. */
export async function findLinkWithNamesById(linkId: string): Promise<CrewDeskLinkRowWithNames | null> {
  const rows = await db.$queryRaw<CrewDeskLinkRowWithNames[]>`
    SELECT l.link_id, l.module_id, l.ticket_id, l.ticket_title, l.ticket_status,
           l.crewdesk_comment_id, l.status, l.last_error, l.linked_by_id, l.note,
           l.created_at, l.updated_at,
           m.name AS module_name,
           u.full_name AS linked_by_name,
           u.email AS linked_by_email
    FROM crew_desk_links l
    JOIN modules m ON m.module_id = l.module_id
    JOIN users u ON u.user_id = l.linked_by_id
    WHERE l.link_id = ${linkId}
    LIMIT 1`
  return rows[0] ?? null
}

export async function listLinks(limit: number, offset: number): Promise<CrewDeskLinkRowWithNames[]> {
  return db.$queryRaw<CrewDeskLinkRowWithNames[]>`
    SELECT l.link_id, l.module_id, l.ticket_id, l.ticket_title, l.ticket_status,
           l.crewdesk_comment_id, l.status, l.last_error, l.linked_by_id, l.note,
           l.created_at, l.updated_at,
           m.name AS module_name,
           u.full_name AS linked_by_name,
           u.email AS linked_by_email
    FROM crew_desk_links l
    JOIN modules m ON m.module_id = l.module_id
    JOIN users u ON u.user_id = l.linked_by_id
    ORDER BY l.created_at DESC
    LIMIT ${limit} OFFSET ${offset}`
}

export async function countLinks(): Promise<number> {
  // Mirrors listLinks' scope exactly (JOIN modules + users) so the pagination
  // total can never disagree with the visible rows — e.g. a link whose module
  // was removed must not be counted if it cannot be listed.
  const rows = await db.$queryRaw<{ total: number | bigint }[]>`
    SELECT count(*) AS total
    FROM crew_desk_links l
    JOIN modules m ON m.module_id = l.module_id
    JOIN users u ON u.user_id = l.linked_by_id`
  return Number(rows[0]?.total ?? 0)
}

// ---------- Module lookup (module existence + name for the comment) ----------

export interface CrewDeskModuleRow {
  module_id: string
  name: string
}

export async function findModuleBasic(moduleId: string): Promise<CrewDeskModuleRow | null> {
  const rows = await db.$queryRaw<CrewDeskModuleRow[]>`
    SELECT module_id, name FROM modules WHERE module_id = ${moduleId} LIMIT 1`
  return rows[0] ?? null
}

// ---------- Crew Desk email verification on the TCMS user ----------
// The verification-only check stores at most TWO things on the TCMS user:
// the matched Crew Desk user id and the time of the check. The Crew Desk
// user LIST is never persisted anywhere.

export interface CrewDeskCheckRow {
  crewdesk_user_id: string | null
  crewdesk_checked_at: Date | null
}

export async function getUserCrewDeskCheck(userId: string): Promise<CrewDeskCheckRow | null> {
  const rows = await db.$queryRaw<CrewDeskCheckRow[]>`
    SELECT crewdesk_user_id, crewdesk_checked_at
    FROM users WHERE user_id = ${userId} LIMIT 1`
  return rows[0] ?? null
}

export async function saveUserCrewDeskCheck(userId: string, crewdeskUserId: string): Promise<Date> {
  // MySQL: UPDATE has no RETURNING — write, then read the timestamp back.
  await db.$executeRaw`
    UPDATE users
    SET crewdesk_user_id = ${crewdeskUserId}, crewdesk_checked_at = UTC_TIMESTAMP(3), updated_at = UTC_TIMESTAMP(3)
    WHERE user_id = ${userId}`
  const rows = await db.$queryRaw<{ crewdesk_checked_at: Date }[]>`
    SELECT crewdesk_checked_at FROM users WHERE user_id = ${userId} LIMIT 1`
  if (!rows[0]) throw new Error('Updated user could not be read back')
  return rows[0].crewdesk_checked_at
}
