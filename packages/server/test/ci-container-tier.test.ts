/**
 * Guards the split between the backend shard matrix and the test-containers job.
 *
 * Both halves are silent when they drift. A suite that gates itself on the
 * agent-base image but is not named in test-containers' --pattern list runs
 * only where the image is absent, so it self-skips on every run and reports
 * green having tested nothing - the exact failure this job exists to prevent.
 * And a shard that stopped passing --skip-bun-native would run the Bun-native
 * tier without a Docker daemon.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { shouldRunBunNative } from '../../../scripts/test-selection';

const ROOT = resolve(import.meta.dirname, '../../..');
const TEST_DIR = resolve(ROOT, 'packages/server/test');
const ci = readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8');

/** The text of one top-level job block in ci.yml, by name. */
function job(name: string): string {
	const start = ci.indexOf(`\n  ${name}:\n`);
	expect(start, `ci.yml has no ${name} job`).toBeGreaterThan(-1);
	const rest = ci.slice(start + 1);
	const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
	return next === -1 ? rest : rest.slice(0, next + 1);
}

/**
 * Server vitest suites that gate the whole module on the agent-base image.
 *
 * The marker is a module-scope `await imageExists(...)` - column 0, so it runs
 * at import and decides whether the suite registers real tests. Calls inside a
 * test body (docker-client-request asserting imageExists's own return, the fake
 * docker's stub) are indented and correctly excluded.
 */
function imageGatedSuites(): string[] {
	return readdirSync(TEST_DIR)
		.filter((f) => f.endsWith('.test.ts'))
		.filter((f) => /^const .*await imageExists\(/m.test(readFileSync(resolve(TEST_DIR, f), 'utf8')))
		.sort();
}

describe('the container tier is actually run somewhere', () => {
	it('names every image-gated suite in test-containers --pattern list', () => {
		const gated = imageGatedSuites();
		// Fails loudly if the marker stops matching, rather than passing vacuously.
		expect(gated.length).toBeGreaterThan(0);
		const containers = job('test-containers');
		for (const file of gated) {
			const suite = file.replace(/\.test\.ts$/, '');
			expect(
				containers,
				`${file} gates on the agent-base image but test-containers never selects it`,
			).toContain(`--pattern ${suite}`);
		}
	});

	it('pulls the agent-base image in test-containers and nowhere in the shards', () => {
		expect(job('test-containers')).toContain('docker pull ghcr.io/hezo-ai/agent-base');
		expect(job('test-backend')).not.toContain('docker pull');
	});

	it('runs the Bun-native tier in test-containers, never in a backend shard', () => {
		expect(job('test-containers')).toContain('--bun-native');
		const backend = job('test-backend');
		expect(backend).toContain('--skip-bun-native');
		expect(backend).not.toContain('--bun-native ');
	});

	it('rolls test-containers into the required test-backend-complete check', () => {
		const rollup = job('test-backend-complete');
		expect(rollup).toContain('test-containers');
		expect(rollup).toContain('needs.test-containers.result');
	});

	it('feeds the container job’s coverage into the merge job', () => {
		expect(job('test-containers')).toContain('name: backend-coverage-containers');
		expect(job('coverage-merge')).toContain('test-containers');
	});
});

describe('shouldRunBunNative', () => {
	it('runs on a plain unsharded invocation', () => {
		expect(shouldRunBunNative({ patterns: [] })).toBe(true);
	});

	it('keeps the tier on shard 1 only, so a matrix neither drops nor duplicates it', () => {
		const shards = [1, 2, 3, 4, 5].map((shardIndex) =>
			shouldRunBunNative({ patterns: [], shardIndex }),
		);
		expect(shards).toEqual([true, false, false, false, false]);
	});

	it('honours a --pattern that targets the tier, and one that does not', () => {
		expect(shouldRunBunNative({ patterns: ['bun'] })).toBe(true);
		expect(shouldRunBunNative({ patterns: ['database-'] })).toBe(false);
		// test-postgres / test-s3 run their Bun file themselves; the tier must not
		// ride along with the vitest pattern they pass.
		expect(shouldRunBunNative({ patterns: ['asset-storage'] })).toBe(false);
	});

	it('runs the tier under --bun-native even when every pattern selects it out', () => {
		expect(
			shouldRunBunNative({
				patterns: ['egress-proxy-docker', 'ssh-agent-docker', 'mcp-connections-docker'],
				force: true,
			}),
		).toBe(true);
	});

	it('skips the tier under --skip-bun-native, including on shard 1', () => {
		expect(shouldRunBunNative({ patterns: [], shardIndex: 1, skip: true })).toBe(false);
		expect(shouldRunBunNative({ patterns: [], skip: true })).toBe(false);
	});
});
