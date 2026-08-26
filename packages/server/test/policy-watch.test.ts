import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { watchPolicyFile } from '../src/config/policy';
import { resetRuntimeConfig, runtimeConfig } from '../src/config/runtime';
import type { PolicyConfig } from '../src/config/types';

const dir = mkdtempSync(join(tmpdir(), 'hezo-policy-watch-'));
let seq = 0;
const watchers: Array<{ close: () => void }> = [];

afterEach(() => {
	for (const w of watchers.splice(0)) w.close();
	resetRuntimeConfig();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function policy(maxContainerMemoryGb: number): string {
	return JSON.stringify({
		managedBy: 'Acme Cloud',
		pinned: { maxContainerMemoryGb },
	});
}

/** Write a fresh file and rename it over the target, the way a deployment must. */
function renameInto(path: string, body: string): void {
	const staging = `${path}.tmp`;
	writeFileSync(staging, body);
	renameSync(staging, path);
}

/**
 * Poll until the watcher has acted, or give up.
 *
 * A fixed sleep would either be a race or an arbitrary pad: `fs.watch` latency
 * is the operating system's business, and the reload is debounced besides.
 */
async function waitForPolicy(
	predicate: (policy: PolicyConfig | null) => boolean,
	timeoutMs = 3000,
): Promise<PolicyConfig | null> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const current = runtimeConfig().policy;
		if (predicate(current)) return current;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return runtimeConfig().policy;
}

function watch(path: string) {
	const handle = watchPolicyFile(path);
	watchers.push(handle);
	return handle;
}

describe('watchPolicyFile', () => {
	it('picks up a plan change without a restart', async () => {
		const path = join(dir, `p${seq++}.json`);
		writeFileSync(path, policy(8));
		watch(path);

		renameInto(path, policy(16));
		const next = await waitForPolicy((p) => p?.pinned.maxContainerMemoryGb === 16);
		expect(next?.pinned.maxContainerMemoryGb).toBe(16);
		expect(next?.managedBy).toBe('Acme Cloud');
	});

	// An atomic rename replaces the inode, which ends a watch on the old one. The
	// watcher re-arms after every event so a second change is still seen.
	it('survives the inode swap a rename causes, change after change', async () => {
		const path = join(dir, `p${seq++}.json`);
		writeFileSync(path, policy(8));
		watch(path);

		renameInto(path, policy(16));
		expect(
			(await waitForPolicy((p) => p?.pinned.maxContainerMemoryGb === 16))?.pinned
				.maxContainerMemoryGb,
		).toBe(16);

		renameInto(path, policy(32));
		expect(
			(await waitForPolicy((p) => p?.pinned.maxContainerMemoryGb === 32))?.pinned
				.maxContainerMemoryGb,
		).toBe(32);

		renameInto(path, policy(64));
		expect(
			(await waitForPolicy((p) => p?.pinned.maxContainerMemoryGb === 64))?.pinned
				.maxContainerMemoryGb,
		).toBe(64);
	});

	// Clearing on a bad read would silently unpin every limit the deployment bills
	// for, which is worse than serving a slightly stale one.
	it('keeps the last good policy when the file stops being valid', async () => {
		const path = join(dir, `p${seq++}.json`);
		writeFileSync(path, policy(8));
		watch(path);

		renameInto(path, policy(16));
		await waitForPolicy((p) => p?.pinned.maxContainerMemoryGb === 16);

		renameInto(path, '{ not json at all');
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(runtimeConfig().policy?.pinned.maxContainerMemoryGb).toBe(16);

		// A file that validates again is picked up, so a bad write is recoverable.
		renameInto(path, policy(24));
		expect(
			(await waitForPolicy((p) => p?.pinned.maxContainerMemoryGb === 24))?.pinned
				.maxContainerMemoryGb,
		).toBe(24);
	});

	it('watches nothing when no policy file is configured', () => {
		const before = runtimeConfig().policy;
		expect(() => watch(undefined as unknown as string).close()).not.toThrow();
		expect(runtimeConfig().policy).toBe(before);
	});

	// A deployment may write the file after the server is already up.
	it('does not throw when the file does not exist yet', () => {
		expect(() => watch(join(dir, 'never-written.json'))).not.toThrow();
	});
});
