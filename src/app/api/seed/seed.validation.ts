// Validation layer for the seed resource.
//
// HONEST MINIMAL FILE: the seed endpoint takes NO client input — no request
// body, no query parameters. The legacy /api/seed route never read either
// (see legacy route.ts), and the only caller, seedApi in
// src/lib/client/api.ts, POSTs without a body. There is nothing to constrain,
// so no zod schema would be truthful here.
//
// This no-op guard exists so the controller keeps the mandatory
// Controller -> Validation -> Service flow without inventing fake schemas.
// If the endpoint ever gains client-controlled input (e.g. a ?force= flag),
// it must get a real zod schema + dedicated validator in this file.

/**
 * No-op validator for the seed action: zero client-controlled input.
 * Returns nothing to validate — call it in the controller before the service
 * so the layer contract stays intact.
 */
export function validateSeedRequest(): void {
  // Intentionally empty: the seed action has no input to validate.
}
