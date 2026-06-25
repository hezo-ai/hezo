import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AiAuthMethod, AiProvider } from '@hezo/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
	buildSubscriptionMount,
	ensureRuntimeHomeDir,
	getHostSubscriptionRoot,
	mkdirTraversable,
} from '../src/services/runtime-home';

/**
 * Regression coverage for the EACCES-on-settings.json bug: the per-run subscription /
 * runtime-home dirs are created with an intended-world-traversable 0o711 mode, but
 * `mkdirSync`'s `mode` is masked by the process umask. On a hardened host (umask
 * 0o027/0o077) that silently strips the other-execute bit, so the non-root container
 * run-user can't traverse `subscription/<provider>/` to its per-run leaf and the agent
 * CLI dies with `EACCES` opening `<leaf>/settings.json`. These tests run the real dir
 * builders under a strict umask and assert the traversal bit survives.
 */

const TEAM = 'team-1';
const PROJECT = 'project-1';
const RUN = 'run-abc';
const mode = (p: string): number => statSync(p).mode & 0o777;

/** Run `fn` with the process umask forced to `value`, restoring it afterwards. */
function withUmask<T>(value: number, fn: () => T): T {
	const prev = process.umask(value);
	try {
		return fn();
	} finally {
		process.umask(prev);
	}
}

describe('mkdirTraversable', () => {
	let base: string;
	afterEach(() => {
		if (base) rmSync(base, { recursive: true, force: true });
	});

	it('forces 0o711 on every component from the subscription root down, past a strict umask', () => {
		base = mkdtempSync(join(tmpdir(), 'hezo-rt-'));
		const sub = join(base, 'workspace', '.hezo', 'subscription');
		const leaf = join(sub, 'codex', RUN);

		withUmask(0o077, () => {
			// A bare mkdir would lose the traversal bit under this umask — assert the
			// premise so this test fails loudly if Node's masking behaviour ever changes.
			const control = join(base, 'control');
			mkdirSync(control, { recursive: true, mode: 0o711 });
			expect(mode(control) & 0o001).toBe(0);

			mkdirTraversable(leaf);
		});

		expect(mode(sub)).toBe(0o711);
		expect(mode(join(sub, 'codex'))).toBe(0o711);
		expect(mode(leaf)).toBe(0o711);
	});

	it('leaves components above the subscription root untouched', () => {
		base = mkdtempSync(join(tmpdir(), 'hezo-rt-'));
		const hezo = join(base, 'workspace', '.hezo');
		const leaf = join(hezo, 'subscription', 'gemini', RUN);

		withUmask(0o077, () => mkdirTraversable(leaf));

		// `.hezo` is above the marker — the walk stops at `subscription`, so `.hezo`
		// keeps the umask-derived mode (here 0o700) rather than being widened.
		expect(mode(hezo) & 0o001).toBe(0);
	});
});

describe('ensureRuntimeHomeDir under a strict umask', () => {
	let base: string;
	afterEach(() => {
		if (base) rmSync(base, { recursive: true, force: true });
	});

	it('keeps the intermediate dirs traversable by the non-root run-user', () => {
		base = mkdtempSync(join(tmpdir(), 'hezo-rt-'));
		const mount = withUmask(0o077, () =>
			ensureRuntimeHomeDir(AiProvider.DeepSeek, base, TEAM, PROJECT, RUN, null),
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

	it('makes the auth-file dir traversable while keeping the credential file 0o600', () => {
		base = mkdtempSync(join(tmpdir(), 'hezo-rt-'));
		const mount = withUmask(0o077, () =>
			buildSubscriptionMount(base, TEAM, PROJECT, RUN, AiProvider.OpenAI, {
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
