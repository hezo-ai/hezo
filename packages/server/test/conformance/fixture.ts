/**
 * The contract a container backend is tested against, and the shape every
 * backend's entry point supplies.
 *
 * **Why this is generic rather than per-adapter.** `ContainerEngine` is one
 * interface with more than one implementation, and the only way "one seam, no
 * provider knowledge above it" stays true is if the same assertions run against
 * every implementation. A suite written per adapter tests what that adapter
 * happens to do; this one tests what the *interface promises*, so a second
 * provider is a fixture file rather than a second suite - and a divergence
 * shows up as a failing shared assertion instead of as an assertion nobody
 * thought to write.
 *
 * **These run against the real thing.** The unit suites (`sandbox-daytona-*`)
 * drive a fake API and pin the request shapes; they cannot tell you the provider
 * still behaves the way it did when those shapes were written. Every non-obvious
 * behaviour the Daytona adapter encodes was measured live and several
 * contradicted the documentation, so a suite that can be pointed at a live
 * account is the only thing that notices when one of them changes.
 *
 * Docker's fixture runs in CI (self-skipping when there is no daemon); a
 * paid-provider fixture is manual and opt-in - see `test/live/`.
 */

import { readFileSync } from 'node:fs';
import {
	type AgentRuntime,
	AI_PROVIDER_INFO,
	AiAuthMethod,
	AiProvider,
	ALL_AI_PROVIDERS,
	KIMI_DEFAULT_MODEL,
	providerRuntimeBinding,
	providerRuntimes,
} from '@hezo/shared';
import { RUNTIME_HOME_LAYOUTS } from '../../src/services/runtime-home';
import type { ContainerEngine } from '../../src/services/sandbox/types';
import { validateSubscriptionBlob } from '../../src/services/subscription-auth';

/**
 * The test API the shared suites register through.
 *
 * Injected rather than imported, because the two fixtures do not run on the same
 * runner and cannot. `DockerClient` reaches the daemon with Bun's
 * `fetch(..., { unix })`, an option Node ignores - so under vitest (which is
 * Node) every request goes to `http://localhost:80` and is refused. The Docker
 * fixture therefore lives in the Bun-native tier and imports `bun:test`, while
 * the Daytona fixture is ordinary HTTP and runs under vitest. One suite, two
 * runners, and the assertions cannot drift apart.
 */
export interface ConformanceHarness {
	describe: (name: string, fn: () => void) => void;
	it: ((name: string, fn: () => Promise<void> | void, timeoutMs?: number) => void) & {
		/**
		 * Both runners have it, and a suite that is entirely opt-in needs it: a
		 * missing model-provider key must register a *named* skip rather than
		 * registering nothing, or "not run" is indistinguishable from "passed".
		 */
		skip: (name: string, fn: () => Promise<void> | void) => void;
	};
	expect: (value: unknown) => any;
	beforeAll: (fn: () => Promise<void> | void, timeoutMs?: number) => void;
	afterAll: (fn: () => Promise<void> | void, timeoutMs?: number) => void;
}

/**
 * What one backend supplies so the shared suites can run against it.
 *
 * The two "supported" flags exist because a legitimate implementation may not be
 * able to answer everything, and the difference between *cannot* and *does not*
 * matters. `null` from `diskUsedBytes` is a documented answer ("unanswerable"),
 * so a backend that always answers null is conforming and the suite must not
 * fail it - but it also must not silently skip the assertion, so the fixture
 * declares the fact and the suite logs what it dropped.
 */
export interface LiveAdapterFixture {
	/** Display name for the suite titles - the provider, not the test file. */
	name: string;
	/** A ready engine. Called once per suite. */
	engine: ContainerEngine;
	/**
	 * The image the fixture provisions from. Pinned by the caller because what
	 * "the agent image" means differs per backend (a local tag vs a digest the
	 * provider builds from).
	 */
	image: string;
	/** Memory cap, in bytes, for the provisioned container. */
	memoryBytes: number;
	/**
	 * Absolute path inside the container the file suite works under. Must be
	 * writable by root and not shared with anything the suite does not own.
	 */
	workRoot: string;
	/**
	 * Whether this backend reports per-container disk usage. Docker on a bind
	 * mount answers `null` by design (the measurement would be the host
	 * partition's, and a replacement container frees nothing), which is
	 * conforming - so the disk assertions are stated rather than assumed.
	 */
	reportsDiskUsage: boolean;
	/**
	 * Whether the engine honours a per-exec user natively. Docker does; a provider
	 * that execs as root and deprivileges with `runuser` also does, from the
	 * caller's point of view - this is false only where the identity cannot be
	 * chosen at all, in which case the elevation assertions are dropped.
	 */
	honoursExecUser: boolean;
	/** The non-root user execs run as when not elevated. */
	runUser: string;
	/**
	 * Real model-provider credentials, enabling {@link describeAgentCliConformance}
	 * - a genuine coding-CLI run inside a provisioned container, one per entry.
	 *
	 * Separate from the backend's own key because they answer different
	 * questions and cost differently: the engine and files suites prove the
	 * *sandbox* works, this proves an *agent* can run in it. Optional (or empty),
	 * so a backend can be conformance-tested with no model spend at all.
	 *
	 * **A list, because one credential can run on several CLIs.** Proving a second
	 * runtime is an extra entry here - not a second fixture and not a second suite
	 * - so the cost of covering a newly-added runtime is one line. Each entry
	 * bills its own completion, so add one per runtime worth proving, not per
	 * provider you happen to have a key for.
	 */
	modelProviders?: readonly LiveModelProvider[];
}

/** The model-provider half of a live fixture. */
export interface LiveModelProvider {
	/** Display name for the suite title - the provider, not the env var. */
	name: string;
	/**
	 * Which provider, so the suite reads its endpoint, model defaults and
	 * credential variable out of the production tables rather than restating
	 * them. Must be an api-key provider (a subscription/file-mount auth method
	 * has no key to hand a container).
	 */
	provider: AiProvider;
	/**
	 * Which CLI this credential runs on. Omit for the provider's default.
	 *
	 * A provider is not one runtime: a credential carries its own choice
	 * (`ai_provider_configs.runtime`), and an alternate CLI is by definition not
	 * the default, so it is only reachable by naming it here. Resolving the
	 * runtime from the provider alone - which this suite used to do - can only
	 * ever exercise defaults, and is the same mistake that shipped a broken
	 * config-home mapping in #909.
	 *
	 * Must be a pairing the provider actually supports (`providerSupportsRuntime`);
	 * the suite fails in `beforeAll` rather than skipping on one that is not,
	 * because an unsupported pairing is a bug in the fixture and a skip would bury
	 * it. Only that suite fails - the backend's other conformance suites still run.
	 */
	runtime?: AgentRuntime;
	/**
	 * How the credential authenticates. Defaults to an API key.
	 *
	 * A subscription is not a second-class case here: production hands one to a
	 * container on every run, either as an env var (Anthropic's long-lived
	 * `claude setup-token` token) or as a mounted credential file (Codex's
	 * `auth.json`, Gemini's `oauth_creds.json`). The suite uses the same
	 * production helpers for both, so what it proves about a subscription run is
	 * what a real one does.
	 */
	authMethod?: AiAuthMethod;
	/**
	 * The credential itself: an API key, or the subscription blob when
	 * `authMethod` is `Subscription`. Never logged - it reaches the container as
	 * an env var or a 0600 mounted file and nowhere else.
	 */
	credential: string;
	/**
	 * Model to pin. Pick the provider's cheapest: the suite asks for one short
	 * completion and the answer is a single word, so nothing is gained by a
	 * larger model and the run is billed either way.
	 */
	model?: string;
	/**
	 * Server URL for a locally-hosted runner (Ollama, LM Studio), whose endpoint
	 * is per-install and therefore cannot live in a compile-time table.
	 *
	 * It must be an address **the container** can reach, which is not the address
	 * your browser uses: `localhost` inside a container is the container. That
	 * rules these providers out on a managed backend entirely, and on local Docker
	 * means `http://host.docker.internal:<port>` or a LAN address.
	 */
	baseUrl?: string;
}

/**
 * Where each provider's credential comes from, and what to pin it to.
 *
 * Exhaustive by construction, so adding a provider is a compile error here rather
 * than a combination that silently never runs - which is the failure this table
 * exists to prevent. What it does *not* restate is which CLIs a provider can run
 * on: {@link liveModelProviders} reads that from `providerRuntimes`, so a runtime
 * added to a provider in production is covered here the moment it lands.
 *
 * The models are the ids this repo already relies on for that provider's Stop-hook
 * judge - real, current, and cheap enough that we already pay for them once per
 * agent turn. `HEZO_LIVE_MODEL_<PROVIDER>` overrides any of them; a provider with
 * no default listed simply lets the CLI choose, which is the honest answer where
 * the catalogue is the operator's (the local runners) or too broad to guess
 * (OpenRouter).
 */
const LIVE_PROVIDER_ENV: Record<AiProvider, { slug: string; model?: string }> = {
	[AiProvider.Anthropic]: { slug: 'ANTHROPIC', model: 'claude-sonnet-5' },
	// A codex-family id, not a general chat one: the CLI warns "model metadata
	// not found" for anything else and falls back to guessed metadata.
	[AiProvider.OpenAI]: { slug: 'OPENAI', model: 'gpt-5.3-codex' },
	[AiProvider.Google]: { slug: 'GOOGLE', model: 'gemini-3.6-flash' },
	[AiProvider.DeepSeek]: { slug: 'DEEPSEEK', model: 'deepseek-v4-flash' },
	// Slugs, not `provider.toUpperCase()`: the enum values are `z_ai` / `x_ai`, and
	// nobody types `HEZO_Z_AI_API_KEY`. One stem per provider, so the key variable
	// and the model override below cannot drift apart.
	[AiProvider.ZAi]: { slug: 'ZAI', model: 'GLM-4.7' },
	// OpenRouter routes by capability, and its own default resolves to endpoints
	// that may not serve tool use at all - which fails as a 404 naming neither the
	// model nor the cause. Pin one known to carry tools.
	[AiProvider.OpenRouter]: { slug: 'OPENROUTER', model: 'anthropic/claude-haiku-4.5' },
	[AiProvider.Kimi]: { slug: 'KIMI', model: KIMI_DEFAULT_MODEL },
	[AiProvider.XAi]: { slug: 'XAI', model: 'grok-4.5' },
	// The local runners take a server URL in place of a key - see `baseUrl`.
	[AiProvider.Ollama]: { slug: 'OLLAMA' },
	[AiProvider.LmStudio]: { slug: 'LMSTUDIO' },
};

/**
 * The env var carrying a provider's credential: its key, or a local runner's
 * server URL. Exported so a caller (and the tests) name it the same way the
 * builder reads it, rather than re-deriving the spelling.
 */
export function liveProviderEnvVar(provider: AiProvider): string {
	const { slug } = LIVE_PROVIDER_ENV[provider];
	return AI_PROVIDER_INFO[provider].local ? `HEZO_${slug}_BASE_URL` : `HEZO_${slug}_API_KEY`;
}

/**
 * Where a provider's subscription blob is read from - a **file path**, not the
 * blob itself.
 *
 * A path rather than an inline value because two of the three are multi-line
 * JSON (`auth.json`, `oauth_creds.json`), and because it keeps a live credential
 * out of the process list and the shell history that `HEZO_…=… bun run` would
 * put it in. Anthropic's is a bare token, but it reads from a file too: one rule
 * for all three beats a per-provider exception.
 */
export function liveProviderSubscriptionEnvVar(provider: AiProvider): string {
	return `HEZO_${LIVE_PROVIDER_ENV[provider].slug}_SUBSCRIPTION_FILE`;
}

/**
 * Subscription credentials rotate on some providers, and the harness cannot
 * write the rotation back.
 *
 * Production does: `acquireCredentialLock` serialises runs on the credential row
 * and the runner persists the refreshed token afterwards. This suite has no such
 * write-back, so on a `rotates` runtime a live run consumes a single-use refresh
 * token and leaves the operator's stored copy stale. That is a real cost to the
 * person supplying the credential, so it is surfaced loudly at run time rather
 * than discovered later - see `warnIfCredentialRotates` in `agent-cli.ts`.
 */
export const SUBSCRIPTION_ROTATION_WARNING =
	'this provider rotates its subscription refresh token on use, and the conformance ' +
	'suite does not write the rotation back - the credential you supplied will be stale ' +
	'afterwards and must be re-issued before it is used elsewhere';

/**
 * Every (provider, runtime, auth-method) combination the environment has a
 * credential for.
 *
 * **The matrix is derived, never listed.** Providers come from `ALL_AI_PROVIDERS`
 * and their CLIs from `providerRuntimes`, so the coverage a fixture gets is
 * whatever production currently supports - a provider gaining an alternate CLI is
 * covered with no edit here, and cannot be quietly missed. What gates each entry
 * is only whether its credential is present, so supplying one key runs that
 * provider on every CLI it can drive and nothing else.
 *
 * **Subscriptions are in the matrix too**, on the pairings that accept one:
 * `credentialEnvByAuthMethod[Subscription]` for the env-delivered kind
 * (Anthropic) and a runtime `authFileRelative` for the mounted kind (Codex,
 * Gemini). A provider can therefore contribute both an api-key entry and a
 * subscription entry for the same runtime - they exercise genuinely different
 * delivery paths, which is the point.
 *
 * Each entry bills a completion and provisions a container, so a full-matrix run
 * is not free - which is why this is opt-in per credential rather than
 * all-or-nothing.
 */
export function liveModelProviders(): LiveModelProvider[] {
	const out: LiveModelProvider[] = [];
	for (const provider of ALL_AI_PROVIDERS) {
		const spec = LIVE_PROVIDER_ENV[provider];
		const info = AI_PROVIDER_INFO[provider];
		const model = process.env[`HEZO_LIVE_MODEL_${spec.slug}`]?.trim() || spec.model;
		const base = { name: info.name, provider, ...(model ? { model } : {}) };

		const key = process.env[liveProviderEnvVar(provider)]?.trim();
		if (key) {
			for (const runtime of providerRuntimes(provider)) {
				out.push({
					...base,
					runtime,
					authMethod: AiAuthMethod.ApiKey,
					// A local runner authenticates only if the operator turned auth on, so
					// what its env var carries is the URL; the credential is the documented
					// sentinel, exactly as the create route stores it.
					credential: info.local ? info.local.authTokenSentinel : key,
					...(info.local ? { baseUrl: key } : {}),
				});
			}
		}

		if (!info.supportsSubscription) continue;
		const blobPath = process.env[liveProviderSubscriptionEnvVar(provider)]?.trim();
		if (!blobPath) continue;
		// Read eagerly so a missing or unreadable file fails here, naming the
		// variable - not deep inside a provisioned container ten minutes later.
		let blob: string;
		try {
			blob = readFileSync(blobPath, 'utf8').trim();
		} catch (e) {
			throw new Error(
				`${liveProviderSubscriptionEnvVar(provider)} points at ${blobPath}, which could not ` +
					`be read: ${(e as Error).message}`,
			);
		}
		// The same check the add-provider route runs, so a blob of the wrong shape is
		// rejected with production's own message rather than surfacing as an opaque
		// CLI auth failure inside the sandbox.
		const validation = validateSubscriptionBlob(provider, blob);
		if (!validation.ok) {
			throw new Error(
				`${liveProviderSubscriptionEnvVar(provider)} (${blobPath}) is not a valid ` +
					`${info.name} subscription credential: ${validation.error}`,
			);
		}
		for (const runtime of subscriptionRuntimes(provider)) {
			out.push({ ...base, runtime, authMethod: AiAuthMethod.Subscription, credential: blob });
		}
	}
	return out;
}

/**
 * The CLIs a provider can run a *subscription* on.
 *
 * Narrower than `providerRuntimes`, and derived rather than listed: a pairing
 * qualifies when it names a credential variable for `Subscription` (the
 * env-delivered kind) or when its runtime mounts a credential file. An
 * alternate CLI declaring neither contributes nothing here, and one that gains
 * subscription support later is picked up with no edit.
 */
function subscriptionRuntimes(provider: AiProvider): AgentRuntime[] {
	return providerRuntimes(provider).filter((runtime) => {
		const binding = providerRuntimeBinding(provider, runtime);
		if (binding?.credentialEnvByAuthMethod[AiAuthMethod.Subscription]) return true;
		return Boolean(RUNTIME_HOME_LAYOUTS[runtime]?.authFileRelative);
	});
}
/** A label every container this suite creates carries, so a sweep can find them. */
export const CONFORMANCE_LABEL = 'hezo.conformance';

/**
 * Remove every container this suite has ever created, whether or not the run
 * that made it finished cleanly.
 *
 * Not tidiness: on a paid provider a leaked sandbox bills until somebody notices
 * it in a dashboard, and a suite that crashes mid-run is exactly when one leaks.
 * Keyed on the label rather than on ids the run remembers, so a container from a
 * *previous* crashed run is swept too.
 */
export async function sweepConformanceContainers(engine: ContainerEngine): Promise<number> {
	const found = await engine.listContainersByLabel(CONFORMANCE_LABEL);
	let removed = 0;
	for (const c of found) {
		try {
			await engine.removeContainer(c.Id, true);
			removed += 1;
		} catch {
			// Best-effort per container: one that will not delete must not stop the
			// rest from being swept, or a single stuck sandbox keeps billing for all
			// of them.
		}
	}
	return removed;
}

/** Unique-enough suffix for a container name, without `Math.random`. */
export function conformanceRunId(): string {
	return `${Date.now().toString(36)}-${process.pid.toString(36)}`;
}
