/**
 * Request-body validation via zod, replacing the hand-rolled
 * `if (!body.x) return err(...)` clauses scattered across routes.
 *
 * Used inside a handler like the other guard helpers:
 *
 *   const parsed = await validateBody(c, schema);
 *   if (parsed instanceof Response) return parsed;
 *   // parsed is the typed, validated value
 *
 * The status defaults to 400 to match the existing inline-validation behavior
 * the migrated routes already return (so adopting this helper is
 * behavior-preserving); pass 422 explicitly for new routes that want it.
 */
import type { Context } from 'hono';
import type { ZodType } from 'zod';
import { err } from './response';

export async function validateBody<T>(
	c: Context,
	schema: ZodType<T>,
	status: 400 | 422 = 400,
): Promise<T | Response> {
	let raw: unknown;
	try {
		raw = await c.req.json();
	} catch {
		return err(c, 'INVALID_REQUEST', 'Request body must be valid JSON', status);
	}

	const result = schema.safeParse(raw);
	if (!result.success) {
		const issue = result.error.issues[0];
		const path = issue?.path.join('.');
		const message = issue
			? path
				? `${path}: ${issue.message}`
				: issue.message
			: 'Invalid request body';
		return err(c, 'INVALID_REQUEST', message, status);
	}

	return result.data;
}
