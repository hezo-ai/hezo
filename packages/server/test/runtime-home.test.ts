import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AiAuthMethod, AiProvider } from '@hezo/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeDockerClient, registerFakeContainerRoot } from '../src/services/fake-docker';
import {
	buildSubscriptionMount,
	ensureRuntimeHomeDir,
	getHostSubscriptionBase,
	getHostSubscriptionRoot,
	SUBSCRIPTION_DIR_MODE,
	subscriptionFiles,
} from '../src/services/runtime-home';
import type { ContainerEngine } from '../src/services/sandbox/types';
import { getWorkspacePath } from '../src/services/workspace';

/**
 * Regression coverage for the EACCES-on-settings.json bug: the per-run subscription /
 * runtime-home dirs are created with an intended-world-traversable 0o711 mode, but
 * `mkdirSync`'s `mode` is masked by the process umask. On a hardened host (umask
 * 0o027/0o077) that silently strips the other-execute bit, so the non-root container
 * run-user can't traverse `subscription/<provider>/` to its per-run leaf and the agent
 * CLI dies with `EACCES` opening `<leaf>/settings.json`. These tests run the real dir
 * builders under a strict umask and assert the traversal bit survives.
 */

/**
 * The subscription files live *inside the container* now, so the tests drive the
 * same seam production does. The fake resolves a container root to a host path,
 * so the mode assertions below still read real directories - which is the point:
 * the mode contract has to survive the move, not just the write.
 */
const CONTAINER = 'container-runtime-home';

function fakeEngine(base: string): ContainerEngine {
	const engine = createFakeDockerClient();
	registerFakeContainerRoot(CONTAINER, getWorkspacePath(base, TEAM, PROJECT));
	return engine;
}

function buildSubscriptionMountWithEngine(
	base: string,
	runId: string,
	provider: AiProvider,
	credential: { value: string; authMethod: AiAuthMethod },
) {
	return buildSubscriptionMount(
		base,
		TEAM,
		PROJECT,
		runId,
		provider,
		{ ...credential, baseUrl: null },
		fakeEngine(base),
		CONTAINER,
	);
}

const TEAM = 'team-1';
const PROJECT = 'project-1';
const RUN = 'run-abc';
const mode = (p: string): number => statSync(p).mode & 0o777;

/** Run `fn` with the process umask forced to `value`, restoring it afterwards. */
async function withUmask<T>(value: number, fn: () => T | Promise<T>): Promise<T> {
	const prev = process.umask(value);
	try {
		return await fn();
	} finally {
		process.umask(prev);
	}
}

describe('subscriptionFiles directory modes', () => {
	let base: string;
	afterEach(() => {
		if (base) rmSync(base, { recursive: true, force: true });
	});

	it('forces 0o711 on every component from the subscription root down, past a strict umask', async () => {
		base = mkdtempSync(join(tmpdir(), 'hezo-rt-'));
		const sub = getHostSubscriptionBase(base, TEAM, PROJECT);

		await withUmask(0o077, async () => {
			// A bare mkdir would lose the traversal bit under this umask - assert the
			// premise so this test fails loudly if Node's masking behaviour ever changes.
			const control = join(base, 'control');
			mkdirSync(control, { recursive: true, mode: 0o711 });
			expect(mode(control) & 0o001).toBe(0);

			await subscriptionFiles(fakeEngine(base), CONTAINER).mkdir(join('codex', RUN), {
				mode: SUBSCRIPTION_DIR_MODE,
			});
		});

		expect(mode(sub)).toBe(0o711);
		expect(mode(join(sub, 'codex'))).toBe(0o711);
		expect(mode(join(sub, 'codex', RUN))).toBe(0o711);
	});

	it('leaves components above the subscription root untouched', async () => {
		// The SandboxFiles root is the boundary: widening `.hezo` would re-mode a
		// directory this seam does not own.
		base = mkdtempSync(join(tmpdir(), 'hezo-rt-'));
		const hezo = dirname(getHostSubscriptionBase(base, TEAM, PROJECT));

		await withUmask(0o077, () =>
			subscriptionFiles(fakeEngine(base), CONTAINER).mkdir(join('gemini', RUN), {
				mode: SUBSCRIPTION_DIR_MODE,
			}),
		);

		expect(mode(hezo) & 0o001).toBe(0);
	});
});

describe('ensureRuntimeHomeDir under a strict umask', () => {
	let base: string;
	afterEach(() => {
		if (base) rmSync(base, { recursive: true, force: true });
	});

	it('keeps the intermediate dirs traversable by the non-root run-user', async () => {
		base = mkdtempSync(join(tmpdir(), 'hezo-rt-'));
		const mount = await withUmask(0o077, () =>
			ensureRuntimeHomeDir(
				AiProvider.DeepSeek,
				base,
				TEAM,
				PROJECT,
				RUN,
				null,
				fakeEngine(base),
				CONTAINER,
			),
		);
		expect(mount).not.toBeNull();

		const leaf = getHostSubscriptionRoot(AiProvider.DeepSeek, base, TEAM, PROJECT, RUN);
		expect(leaf).not.toBeNull();
		const providerDir = dirname(leaf as string); // .../subscription/claude-code-deepseek
		const subscriptionDir = dirname(providerDir); // .../subscription

		// Other-execute must be set on every dir the run-user has to walk through.
		expect(mode(subscriptionDir) & 0o001).toBe(0o001);
		expect(mode(providerDir) & 0o001).toBe(0o001);
		expect(mode(leaf as string) & 0o001).toBe(0o001);
	});
});

describe('buildSubscriptionMount under a strict umask', () => {
	let base: string;
	afterEach(() => {
		if (base) rmSync(base, { recursive: true, force: true });
	});

	it('makes the auth-file dir traversable while keeping the credential file 0o600', async () => {
		base = mkdtempSync(join(tmpdir(), 'hezo-rt-'));
		const mount = await withUmask(0o077, () =>
			buildSubscriptionMountWithEngine(base, RUN, AiProvider.OpenAI, {
				value: JSON.stringify({ tokens: { refresh_token: 'rt' } }),
				authMethod: AiAuthMethod.Subscription,
			}),
		);
		expect(mount).not.toBeNull();
		const { hostAuthFile } = mount as { hostAuthFile: string };

		// The credential stays owner-only; only the *directories* are widened to o+x.
		expect(mode(hostAuthFile)).toBe(0o600);
		expect(mode(dirname(hostAuthFile)) & 0o001).toBe(0o001);

		// .../subscription/codex/<run> → .../subscription is two levels up from the leaf.
		const leaf = getHostSubscriptionRoot(AiProvider.OpenAI, base, TEAM, PROJECT, RUN);
		const subscriptionDir = dirname(dirname(leaf as string));
		expect(mode(subscriptionDir) & 0o001).toBe(0o001);
	});
});
