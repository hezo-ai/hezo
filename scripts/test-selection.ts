/**
 * Pure tier-selection logic for scripts/test.ts.
 *
 * Split out because the CI matrix depends on it and nothing else can check it:
 * scripts/test.ts parses argv and runs the suite at module scope, so importing
 * it from a test would run the suite. Guarded by ci-container-tier.test.ts.
 */

export interface BunNativeSelection {
	/** Every --pattern given, in order. Empty when none was passed. */
	patterns: string[];
	/** Index of --shard <i>/<n>, or undefined for an unsharded run. */
	shardIndex?: number;
	/** --bun-native: run the tier whatever the patterns and shard select. */
	force?: boolean;
	/** --skip-bun-native: never run the tier. */
	skip?: boolean;
}

/**
 * Whether one invocation runs the Bun-native tier (`bun test test/bun/`).
 *
 * The tier is not shardable by vitest, so the default keeps it on shard 1 of a
 * sharded run - never duplicated across the matrix, never dropped. CI overrides
 * that in both directions: the backend shards pass --skip-bun-native and the
 * test-containers job passes --bun-native, because the tier needs a Docker
 * daemon and the agent-base image that only that job pulls.
 */
export function shouldRunBunNative({
	patterns,
	shardIndex,
	force = false,
	skip = false,
}: BunNativeSelection): boolean {
	if (skip) return false;
	if (force) return true;
	// Bun-tier files all carry "bun" in their path, so a --pattern naming that
	// tier selects it and any other --pattern selects it out.
	const patternSelects = patterns.length === 0 || patterns.some((p) => p.includes('bun'));
	return patternSelects && (shardIndex === undefined || shardIndex === 1);
}
