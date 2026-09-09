import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchPolicyFile } from '../../src/config/policy';
import { resetRuntimeConfig, runtimeConfig } from '../../src/config/runtime';

/**
 * The policy watcher, on the runtime a release actually runs.
 *
 * **`policy-watch.test.ts` covers the same ground under vitest, and that is the
 * problem it could not see.** `fs.watch` reports a rename differently on the two
 * runtimes: Node emits an event naming the *destination*, Bun emits one naming
 * only the *source*. A watcher that filtered the directory's events by the
 * policy file's own name therefore reloaded on Node and never on Bun — so every
 * plan change a deployment wrote reached the disk of a running instance and
 * never its memory, while the Node suite stayed green.
 *
 * Measured before the fix, ten renames each: Node 10/10, Bun 0/10.
 *
 * A deployment renames into place because that is what makes the read atomic, so
 * this exercises exactly that: write `<file>.tmp`, `chmod`, `rename`.
 */

const watchers: Array<{ close: () => void }> = [];
const dirs: string[] = [];

afterEach(() => {
	for (const one of watchers.splice(0)) one.close();
	resetRuntimeConfig();
	for (const one of dirs.splice(0)) rmSync(one, { recursive: true, force: true });
});

/** A directory of this test's own, removed with it. */
function ownDirectory(): string {
	const made = mkdtempSync(join(tmpdir(), 'hezo-policy-watch-bun-'));
	dirs.push(made);
	return made;
}

function policy(maxContainerMemoryGb: number): string {
	return JSON.stringify({ managedBy: 'Acme Cloud', pinned: { maxContainerMemoryGb } });
}

/** Write a fresh file and rename it over the target, the way a deployment must. */
function renameInto(path: string, body: string): void {
	writeFileSync(`${path}.tmp`, body, { mode: 0o600 });
	renameSync(`${path}.tmp`, path);
}

/** Poll rather than sleep: watch latency is the operating system's business. */
async function pinnedMemoryReaches(wanted: number, timeoutMs = 3000): Promise<number | undefined> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const seen = runtimeConfig().policy?.pinned.maxContainerMemoryGb;
		if (seen === wanted || Date.now() >= deadline) return seen;
		await new Promise((tick) => setTimeout(tick, 10));
	}
}

function watching(path: string) {
	const handle = watchPolicyFile(path);
	watchers.push(handle);
	return handle;
}

describe('the policy watcher under Bun', () => {
	it('takes a plan change written the way a deployment writes one', async () => {
		const path = join(ownDirectory(), 'policy.json');
		writeFileSync(path, policy(8));
		watching(path);

		renameInto(path, policy(16));

		expect(await pinnedMemoryReaches(16)).toBe(16);
	});

	// **Change after change, because a tenant's plan moves more than once.** The
	// rename replaces the inode every time, and a watcher that stopped seeing the
	// directory after the first would pin whatever the second change replaced.
	it('keeps taking them, change after change', async () => {
		const path = join(ownDirectory(), 'policy.json');
		writeFileSync(path, policy(8));
		watching(path);

		renameInto(path, policy(16));
		expect(await pinnedMemoryReaches(16)).toBe(16);

		renameInto(path, policy(32));
		expect(await pinnedMemoryReaches(32)).toBe(32);

		renameInto(path, policy(64));
		expect(await pinnedMemoryReaches(64)).toBe(64);
	});

	// Reloading on any event in the directory means a neighbour's write reloads
	// too. That must read the policy file and find it unchanged, never pick the
	// neighbour up as one.
	it('is unmoved by a write to something else in the same directory', async () => {
		const directory = ownDirectory();
		const path = join(directory, 'policy.json');
		writeFileSync(path, policy(8));
		watching(path);
		renameInto(path, policy(16));
		expect(await pinnedMemoryReaches(16)).toBe(16);

		writeFileSync(join(directory, 'deploy.env'), 'HEZO_SOMETHING=1\n');
		await new Promise((tick) => setTimeout(tick, 400));

		expect(runtimeConfig().policy?.pinned.maxContainerMemoryGb).toBe(16);
	});
});
