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

import type { AgentRuntime, AiProvider } from '@hezo/shared';
import type { ContainerEngine } from '../../src/services/sandbox/types';

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
	 * (`ai_provider_configs.runtime`), and Prime Agent is never any provider's
	 * default, so it is only reachable by naming it here. Resolving the runtime
	 * from the provider alone - which this suite used to do - can only ever
	 * exercise defaults, and is the same mistake that shipped a broken
	 * config-home mapping in #909.
	 *
	 * Must be a pairing the provider actually supports (`providerSupportsRuntime`);
	 * the suite fails in `beforeAll` rather than skipping on one that is not,
	 * because an unsupported pairing is a bug in the fixture and a skip would bury
	 * it. Only that suite fails - the backend's other conformance suites still run.
	 */
	runtime?: AgentRuntime;
	/** The API key. Never logged - it reaches the container as an env var only. */
	apiKey: string;
	/**
	 * Model to pin. Pick the provider's cheapest: the suite asks for one short
	 * completion and the answer is a single word, so nothing is gained by a
	 * larger model and the run is billed either way.
	 */
	model?: string;
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
