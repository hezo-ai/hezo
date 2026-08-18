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
 * The runtime + provider a run will use, or why none could be chosen.
 *
 * A reason rather than a bare null because the failure worth reporting is not
 * "nothing is configured" - it is "the credential the operator designated is
 * unusable". A run that answers that by quietly picking a different credential
 * bills a provider nobody selected and says nothing.
 */
export type RuntimeResolution = ({ ok: true } & ResolvedRuntime) | { ok: false; reason: string };

/**
 * Ceiling on the credential rows a runtime lookup will consider. Selecting the
 * credential for a pinned runtime needs several rows rather than one (the
 * highest-priority row for a provider may run on a different CLI), so there is
 * no `LIMIT 1` to lean on. Credentials are operator-entered and unique per
 * (provider, label), so this sits far above any real instance.
 */
export const RUNTIME_CANDIDATE_SCAN_LIMIT = 200;

/**
 * Pick the runtime + provider for a task run. Precedence:
 *   1. The task's explicit `runtime_type`, if set: pick the highest-priority
 *      active credential that RESOLVES to that runtime. Both halves matter —
 *      several providers can share a runtime (Anthropic and DeepSeek both run
 *      via Claude Code), and a single provider can be configured onto more than
 *      one (a Moonshot credential runs on Claude Code or Kimi Code), so the
 *      provider shortlist only narrows the query and the row's own runtime
 *      decides.
 *   2. The instance default, when a credential carries `is_default`: that
 *      credential decides, and an unusable one fails the run rather than
 *      handing it to the next credential in line.
 *   3. Otherwise — no default designated at all: the oldest verified credential.
 */
export async function resolveRuntimeForTask(
	db: Db,
	taskRuntimeType: AgentRuntime | null,
): Promise<RuntimeResolution> {
	if (taskRuntimeType) {
		const candidates = PROVIDERS_BY_RUNTIME[taskRuntimeType];
		if (!candidates || candidates.length === 0) {
			return { ok: false, reason: unpinnableReason(taskRuntimeType) };
		}
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
			 -- id breaks a tie: two credentials added in the same millisecond share a
			 -- created_at, and without it which one is "oldest" is a coin flip that can
			 -- land differently on two runs over identical data.
			 ORDER BY is_default DESC, created_at ASC, id ASC
			 LIMIT ${RUNTIME_CANDIDATE_SCAN_LIMIT}`,
			[AiProviderStatus.Verified, ...candidates],
		);
		const match = result.rows.find(
			(row) => effectiveRuntime(row.provider, row.runtime) === taskRuntimeType,
		);
		if (!match) return { ok: false, reason: unpinnableReason(taskRuntimeType) };
		return { ok: true, runtime: taskRuntimeType, provider: match.provider };
	}

	// The instance default is a designation, not a preference: once the operator
	// has marked a credential, that credential decides. An unusable one fails the
	// run rather than passing it to the next credential in line — a substitution
	// nothing surfaces, which is how a moved default goes unnoticed for weeks with
	// the settings page showing the new credential as Default while every agent
	// still bills the old one.
	const designated = await db.query<{
		provider: AiProvider;
		runtime: AgentRuntime | null;
		status: string;
		label: string;
	}>(
		`SELECT provider, runtime, status, label FROM ai_provider_configs
		 WHERE is_default = true
		 LIMIT 1`,
	);
	const chosen = designated.rows[0];
	if (chosen) {
		if (chosen.status !== AiProviderStatus.Verified) {
			return {
				ok: false,
				reason: `The instance default AI provider ("${chosen.label}") is marked ${chosen.status}, so it cannot run agents. Re-verify it or make a different credential the default in Settings > AI Providers.`,
			};
		}
		// A default naming a provider this binary dropped (e.g. `x_ai`) is stale in
		// the same way, and equally must not be answered with someone else's credential.
		const runtime = effectiveRuntime(chosen.provider, chosen.runtime);
		if (!runtime) {
			return {
				ok: false,
				reason: `The instance default AI provider ("${chosen.label}") uses provider "${chosen.provider}", which this version of Hezo no longer supports. Make a different credential the default in Settings > AI Providers.`,
			};
		}
		return { ok: true, runtime, provider: chosen.provider };
	}

	// No default designated at all. Constrain to providers the running binary
	// still supports: a stale row for a since-removed provider must not shadow
	// valid configs.
	const known = Object.keys(PROVIDER_TO_RUNTIME);
	const placeholders = known.map((_, i) => `$${i + 2}::ai_provider`).join(', ');
	const providers = await db.query<{ provider: AiProvider; runtime: AgentRuntime | null }>(
		`SELECT provider, runtime FROM ai_provider_configs
		 WHERE status = $1 AND provider IN (${placeholders})
		 ORDER BY created_at ASC, id ASC
		 LIMIT 1`,
		[AiProviderStatus.Verified, ...known],
	);
	const first = providers.rows[0];
	if (!first) return { ok: false, reason: NO_CREDENTIAL_REASON };
	const runtime = effectiveRuntime(first.provider, first.runtime);
	if (!runtime) return { ok: false, reason: NO_CREDENTIAL_REASON };
	return { ok: true, runtime, provider: first.provider };
}

/** Nothing usable is configured anywhere — the only genuinely empty case. */
export const NO_CREDENTIAL_REASON =
	'No verified AI provider credential is configured. Add one in Settings > AI Providers.';

function unpinnableReason(runtime: AgentRuntime): string {
	return `This task is pinned to the "${runtime}" runtime, and no verified credential runs on it. Add one, or clear the task's runtime pin, to run on the instance default instead.`;
}
