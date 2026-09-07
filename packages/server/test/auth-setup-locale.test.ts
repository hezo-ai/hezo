import {
	buildSetupMessage,
	deriveAuthKeyPair,
	deriveUnlockKey,
	generateMnemonic,
	signAuthMessage,
} from '@hezo/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
	getInstanceLocale,
	instanceLocaleIsConfigured,
	setInstanceLocale,
} from '../src/lib/system-meta';
import { safeClose } from './helpers';
import { createUnsetTestApp } from './helpers/app';

// The setup request carries the language the gate was rendering in, which is
// how a self-hosted instance gets its locale now that there is no language
// step. Each case enrols its own fresh instance: setup happens once per app.

type UnsetApp = Awaited<ReturnType<typeof createUnsetTestApp>>;

describe('POST /api/auth/setup with a locale', () => {
	let ctx: UnsetApp | null = null;

	afterEach(async () => {
		if (ctx) await safeClose(ctx.db);
		ctx = null;
	});

	async function setup(extra: Record<string, unknown>): Promise<Response> {
		ctx = await createUnsetTestApp();
		const mnemonic = generateMnemonic();
		const keys = deriveAuthKeyPair(mnemonic);
		const unlockKey = deriveUnlockKey(mnemonic);
		return ctx.app.request('/api/auth/setup', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				public_key: keys.publicKeyHex,
				unlock_key: unlockKey,
				signature: signAuthMessage(
					keys.privateKey,
					buildSetupMessage(keys.publicKeyHex, unlockKey),
				),
				...extra,
			}),
		});
	}

	it('records the locale the gate was showing, and reports it configured', async () => {
		const res = await setup({
			locale: { language: 'de', date_format: 'dmy', number_format: 'comma-dot' },
		});
		expect(res.status).toBe(200);
		expect(await getInstanceLocale(ctx!.db)).toEqual({
			language: 'de',
			date_format: 'dmy',
			number_format: 'comma-dot',
		});
		const status = (await (await ctx!.app.request('/api/status')).json()) as {
			localeConfigured: boolean;
		};
		expect(status.localeConfigured).toBe(true);
	});

	it('leaves the instance unconfigured when no locale is sent', async () => {
		const res = await setup({});
		expect(res.status).toBe(200);
		expect(await instanceLocaleIsConfigured(ctx!.db)).toBe(false);
	});

	it('refuses an unsupported locale before enrolling anything', async () => {
		const res = await setup({ locale: { language: 'xx' } });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
			'language',
		);
		expect(ctx!.masterKeyManager.getState()).toBe('unset');
		expect(await instanceLocaleIsConfigured(ctx!.db)).toBe(false);
	});

	it('never overwrites a locale that is configured already', async () => {
		// A seeded instance has its language before anyone reaches the gate.
		ctx = await createUnsetTestApp();
		await setInstanceLocale(ctx.db, {
			language: 'fr',
			date_format: 'dmy',
			number_format: 'space-comma',
		});
		const seeded = ctx;
		const mnemonic = generateMnemonic();
		const keys = deriveAuthKeyPair(mnemonic);
		const unlockKey = deriveUnlockKey(mnemonic);
		const res = await seeded.app.request('/api/auth/setup', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				public_key: keys.publicKeyHex,
				unlock_key: unlockKey,
				signature: signAuthMessage(
					keys.privateKey,
					buildSetupMessage(keys.publicKeyHex, unlockKey),
				),
				locale: { language: 'de', date_format: 'dmy', number_format: 'comma-dot' },
			}),
		});
		expect(res.status).toBe(200);
		expect((await getInstanceLocale(seeded.db)).language).toBe('fr');
	});
});
