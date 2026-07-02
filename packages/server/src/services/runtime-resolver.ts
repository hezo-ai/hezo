import type { PGlite } from '@electric-sql/pglite';
import {
	type AgentRuntime,
	type AiProvider,
	AiProviderStatus,
	PROVIDER_TO_RUNTIME,
	PROVIDERS_BY_RUNTIME,
} from '@hezo/shared';

export interface ResolvedRuntime {
	runtime: AgentRuntime;
	provider: AiProvider;
}

/**
 * Pick the runtime + provider for an task run. Precedence:
 *   1. The task's explicit `runtime_type`, if set: pick the highest-priority
 *      active provider whose adapter targets that runtime (multiple providers
 *      can share a runtime, e.g. Anthropic and DeepSeek both run via Claude
 *      Code).
 *   2. Otherwise: pick the globally first active provider (default first,
 *      then oldest) and derive its runtime from the adapter map.
 * Returns null when no suitable active provider exists.
 */
export async function resolveRuntimeForTask(
	db: PGlite,
	taskRuntimeType: AgentRuntime | null,
): Promise<ResolvedRuntime | null> {
	if (taskRuntimeType) {
		const candidates = PROVIDERS_BY_RUNTIME[taskRuntimeType];
		if (!candidates || candidates.length === 0) return null;
		const placeholders = candidates.map((_, i) => `$${i + 2}::ai_provider`).join(', ');
		const result = await db.query<{ provider: AiProvider }>(
			`SELECT provider FROM ai_provider_configs
			 WHERE status = $1 AND provider IN (${placeholders})
			 ORDER BY is_default DESC, created_at ASC
			 LIMIT 1`,
			[AiProviderStatus.Active, ...candidates],
		);
		const row = result.rows[0];
		if (!row) return null;
		return { runtime: taskRuntimeType, provider: row.provider };
	}

	// Constrain to providers the running binary still supports: a stale row for
	// a since-removed provider (e.g. `x_ai`) must not shadow valid configs.
	const known = Object.keys(PROVIDER_TO_RUNTIME);
	const placeholders = known.map((_, i) => `$${i + 2}::ai_provider`).join(', ');
	const providers = await db.query<{ provider: AiProvider }>(
		`SELECT provider FROM ai_provider_configs
		 WHERE status = $1 AND provider IN (${placeholders})
		 ORDER BY is_default DESC, created_at ASC
		 LIMIT 1`,
		[AiProviderStatus.Active, ...known],
	);
	const first = providers.rows[0];
	if (!first) return null;
	const runtime = PROVIDER_TO_RUNTIME[first.provider];
	if (!runtime) return null;
	return { runtime, provider: first.provider };
}
