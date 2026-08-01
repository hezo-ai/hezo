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
	it: (name: string, fn: () => Promise<void> | void, timeoutMs?: number) => void;
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
	 * Whether this backend reports per-container memory statistics. Documented as
	 * optional: where a provider does not expose it, its own OOM handling applies
	 * instead of Hezo's graceful stop.
	 */
	reportsMemoryStats: boolean;
	/**
	 * Whether the engine honours a per-exec user natively. Docker does; a provider
	 * that execs as root and deprivileges with `runuser` also does, from the
	 * caller's point of view - this is false only where the identity cannot be
	 * chosen at all, in which case the elevation assertions are dropped.
	 */
	honoursExecUser: boolean;
	/** The non-root user execs run as when not elevated. */
	runUser: string;
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
