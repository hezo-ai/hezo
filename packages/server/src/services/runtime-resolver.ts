import {
	type AgentRuntime,
	type AiProvider,
	AiProviderStatus,
	effectiveRuntime,
	PROVIDER_TO_RUNTIME,
	PROVIDERS_BY_RUNTIME,
} from '@hezo/shared';
import type { Db } from '../db/database';

export interface ResolvedRuntime {
	runtime: AgentRuntime;
	provider: AiProvider;
}

/**
 * Ceiling on the credential rows a runtime lookup will consider. Selecting the
 * credential for a pinned runtime needs several rows rather than one (the
 * highest-priority row for a provider may run on a different CLI), so there is
 * no `LIMIT 1` to lean on. Credentials are operator-entered and unique per
 * (provider, label), so this sits far above any real instance.
 */
export const RUNTIME_CANDIDATE_SCAN_LIMIT = 200;

/**
 * Pick the runtime + provider for an task run. Precedence:
 *   1. The task's explicit `runtime_type`, if set: pick the highest-priority
 *      active credential that RESOLVES to that runtime. Both halves matter —
 *      several providers can share a runtime (Anthropic and DeepSeek both run
 *      via Claude Code), and a single provider can be configured onto more than
 *      one (a Moonshot credential runs on Claude Code or Kimi Code), so the
 *      provider shortlist only narrows the query and the row's own runtime
 *      decides.
 *   2. Otherwise: pick the globally first active credential (default first,
 *      then oldest) and resolve its runtime.
 * Returns null when no suitable active provider exists.
 */
export async function resolveRuntimeForTask(
	db: Db,
	taskRuntimeType: AgentRuntime | null,
): Promise<ResolvedRuntime | null> {
	if (taskRuntimeType) {
		const candidates = PROVIDERS_BY_RUNTIME[taskRuntimeType];
		if (!candidates || candidates.length === 0) return null;
		const placeholders = candidates.map((_, i) => `$${i + 2}::ai_provider`).join(', ');
		// A provider on this shortlist may still resolve elsewhere — `kimi` is a
		// candidate for both `claude_code` and `kimi` — so scan the shortlist in
		// priority order and take the first row that actually lands on the pinned
		// runtime, rather than trusting the first row outright. `LIMIT 1` is
		// therefore wrong here; the bound below stands in for it. Credentials are
		// operator-entered and unique per (provider, label), so this ceiling is far
		// above any real instance and exists only so the scan cannot be unbounded.
		const result = await db.query<{ provider: AiProvider; runtime: AgentRuntime | null }>(
			`SELECT provider, runtime FROM ai_provider_configs
			 WHERE status = $1 AND provider IN (${placeholders})
			 ORDER BY is_default DESC, created_at ASC
			 LIMIT ${RUNTIME_CANDIDATE_SCAN_LIMIT}`,
			[AiProviderStatus.Verified, ...candidates],
		);
		const match = result.rows.find(
			(row) => effectiveRuntime(row.provider, row.runtime) === taskRuntimeType,
		);
		if (!match) return null;
		return { runtime: taskRuntimeType, provider: match.provider };
	}

	// Constrain to providers the running binary still supports: a stale row for
	// a since-removed provider (e.g. `x_ai`) must not shadow valid configs.
	const known = Object.keys(PROVIDER_TO_RUNTIME);
	const placeholders = known.map((_, i) => `$${i + 2}::ai_provider`).join(', ');
	const providers = await db.query<{ provider: AiProvider; runtime: AgentRuntime | null }>(
		`SELECT provider, runtime FROM ai_provider_configs
		 WHERE status = $1 AND provider IN (${placeholders})
		 ORDER BY is_default DESC, created_at ASC
		 LIMIT 1`,
		[AiProviderStatus.Verified, ...known],
	);
	const first = providers.rows[0];
	if (!first) return null;
	const runtime = effectiveRuntime(first.provider, first.runtime);
	if (!runtime) return null;
	return { runtime, provider: first.provider };
}
