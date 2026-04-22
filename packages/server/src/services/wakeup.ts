import type { PGlite } from '@electric-sql/pglite';
import { type WakeupSource, WakeupStatus } from '@hezo/shared';

const COALESCING_WINDOW_MS = 2_000;

export async function createWakeup(
	db: PGlite,
	memberId: string,
	companyId: string,
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

	const issueId = typeof payload.issue_id === 'string' ? payload.issue_id : null;
	const coalescingCutoff = new Date(Date.now() - COALESCING_WINDOW_MS).toISOString();
	const coalesceResult = await db.query<{ id: string; payload: Record<string, unknown> }>(
		`SELECT id, payload FROM agent_wakeup_requests
		 WHERE member_id = $1 AND status = $3::wakeup_status
		   AND created_at > $2
		   AND (($4::text IS NULL AND payload->>'issue_id' IS NULL)
		     OR payload->>'issue_id' = $4::text)
		 ORDER BY created_at DESC LIMIT 1`,
		[memberId, coalescingCutoff, WakeupStatus.Queued, issueId],
	);

	if (coalesceResult.rows.length > 0) {
		const existingRow = coalesceResult.rows[0];
		const mergedPayload = mergePayloads(existingRow.payload, payload);

		await db.query(
			`UPDATE agent_wakeup_requests
			 SET coalesced_count = coalesced_count + 1,
			     payload = $1::jsonb
			 WHERE id = $2`,
			[JSON.stringify(mergedPayload), existingRow.id],
		);

		return existingRow.id;
	}

	const result = await db.query<{ id: string }>(
		`INSERT INTO agent_wakeup_requests (member_id, company_id, source, payload, idempotency_key)
		 VALUES ($1, $2, $3::wakeup_source, $4::jsonb, $5)
		 RETURNING id`,
		[memberId, companyId, source, JSON.stringify(payload), idempotencyKey ?? null],
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
