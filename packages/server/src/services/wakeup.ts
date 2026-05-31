import type { PGlite } from '@electric-sql/pglite';
import { type WakeupSource, WakeupStatus } from '@hezo/shared';

export async function createWakeup(
	db: PGlite,
	memberId: string,
	teamId: string,
	source: WakeupSource,
	payload: Record<string, unknown> = {},
	idempotencyKey?: string,
): Promise<string> {
	if (idempotencyKey) {
		const existing = await db.query<{ id: string }>(
			`SELECT id FROM agent_wakeup_requests
			 WHERE idempotency_key = $1 AND status = $2::wakeup_status`,
			[idempotencyKey, WakeupStatus.Queued],
		);
		if (existing.rows.length > 0) {
			return existing.rows[0].id;
		}
	}

	// Collapse onto any pending (still-queued) wakeup for the same agent and
	// target task. A single pending run picks up everything that accumulated
	// since it was queued, so an agent never needs more than one queued wakeup
	// per task — regardless of how far apart the triggers arrive.
	const taskId = typeof payload.task_id === 'string' ? payload.task_id : null;
	const coalesceResult = await db.query<{ id: string; payload: Record<string, unknown> }>(
		`SELECT id, payload FROM agent_wakeup_requests
		 WHERE member_id = $1 AND status = $2::wakeup_status
		   AND (($3::text IS NULL AND payload->>'task_id' IS NULL)
		     OR payload->>'task_id' = $3::text)
		 ORDER BY created_at DESC LIMIT 1`,
		[memberId, WakeupStatus.Queued, taskId],
	);

	if (coalesceResult.rows.length > 0) {
		const existingRow = coalesceResult.rows[0];
		const mergedPayload = mergePayloads(existingRow.payload, payload);

		// Guard against the dispatcher claiming the row between the SELECT and
		// here. If it already moved out of `queued`, fall through to a fresh
		// insert so this trigger still produces a pending run.
		const merged = await db.query<{ id: string }>(
			`UPDATE agent_wakeup_requests
			 SET coalesced_count = coalesced_count + 1,
			     payload = $1::jsonb
			 WHERE id = $2 AND status = $3::wakeup_status
			 RETURNING id`,
			[JSON.stringify(mergedPayload), existingRow.id, WakeupStatus.Queued],
		);

		if (merged.rows.length > 0) {
			return existingRow.id;
		}
	}

	const result = await db.query<{ id: string }>(
		`INSERT INTO agent_wakeup_requests (member_id, team_id, source, payload, idempotency_key)
		 VALUES ($1, $2, $3::wakeup_source, $4::jsonb, $5)
		 RETURNING id`,
		[memberId, teamId, source, JSON.stringify(payload), idempotencyKey ?? null],
	);

	return result.rows[0].id;
}

function mergePayloads(
	existing: Record<string, unknown>,
	incoming: Record<string, unknown>,
): Record<string, unknown> {
	const merged = { ...existing };

	for (const [key, value] of Object.entries(incoming)) {
		if (Array.isArray(existing[key]) && Array.isArray(value)) {
			merged[key] = [...(existing[key] as unknown[]), ...value];
		} else if (value !== undefined) {
			merged[key] = value;
		}
	}

	return merged;
}
