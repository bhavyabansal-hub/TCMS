// Row-id validation shared by every validator (security test 2026-10-17).
//
// Keys are INT UNSIGNED AUTO_INCREMENT numbers that travel as digit strings ("42").
// A loose z.string() let "1' OR '1'='1" through: MySQL compares it as the number 1
// in a WHERE clause and then fails the INSERT (1265 -> 500). Every id field now
// accepts only a positive integer digit string.

import { z } from 'zod'

export const ROW_ID_PATTERN = /^[1-9][0-9]{0,9}$/

/** A required row id ("42"). */
export function idField(message = 'Invalid id') {
  return z.string().trim().regex(ROW_ID_PATTERN, message)
}

/** An optional row id: missing, null or '' (= none) — otherwise a valid id. */
export function optionalIdField(message = 'Invalid id') {
  return z.union([idField(message), z.literal('')]).optional().nullable()
}
