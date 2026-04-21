import type { PGlite } from '@electric-sql/pglite';
import {
	type AgentRuntime,
	type AiProvider,
	AiProviderStatus,
	PROVIDER_TO_RUNTIME,
} from '@hezo/shared';

/**
 * Pick the runtime for an issue run. Precedence:
 *   1. The issue's explicit `runtime_type`, if set.
 *   2. The single active AI provider, if only one is configured.
 *   3. The oldest active AI provider (first one added), as a stable default.
 * Returns null when no active providers exist.
 */
export async function resolveRuntimeForIssue(
	db: PGlite,
	issueRuntimeType: AgentRuntime | null,
): Promise<AgentRuntime | null> {
	if (issueRuntimeType) return issueRuntimeType;

	const providers = await db.query<{ provider: AiProvider }>(
		`SELECT provider FROM ai_provider_configs
		 WHERE status = $1
		 ORDER BY is_default DESC, created_at ASC`,
		[AiProviderStatus.Active],
	);
	const first = providers.rows[0];
	if (!first) return null;
	return PROVIDER_TO_RUNTIME[first.provider] ?? null;
}
