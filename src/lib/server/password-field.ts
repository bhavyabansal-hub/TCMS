// Password validation shared by every validator that SETS a password
// (register, PUT /api/auth?path=password, POST /api/users). The rule itself lives
// in src/lib/password-policy.ts, which the forms use too. Sign-in is not checked
// here: an existing password that predates the rule must keep working.

import { z } from 'zod'
import { passwordProblem } from '@/lib/password-policy'

/** A new password that satisfies the shared rule. */
export function newPasswordField() {
  return z.string().superRefine((value, ctx) => {
    const problem = passwordProblem(value)
    if (problem) ctx.addIssue({ code: 'custom', message: problem })
  })
}
