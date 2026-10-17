/**
 * The product analytics a deployer hands an instance: what the policy file may
 * carry, and who is allowed to read it back.
 *
 * The block names the account that owns the instance, so the route must answer
 * the owner's session and answer everyone else - another user, an agent run, any
 * caller on an instance with no issuer - exactly as it answers when nothing is
 * configured. Nothing of it may reach the public status a signed-out visitor
 * reads.
 */

import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { watchPolicyFile } from '../src/config/policy';
import {
	resetRuntimeConfig,
	runtimeConfig,
	setPolicy,
	setRuntimeConfig,
} from '../src/config/runtime';
import { policySchema } from '../src/config/schema';
import type { PolicyConfig, SsoConfig, UmamiAnalyticsConfig } from '../src/config/types';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import { safeClose } from './helpers';
import { authHeader, createTestApp, instanceCeoId, mintAgentToken } from './helpers/app';

const SSO: SsoConfig = {
	issuerUrl: 'https://control.example',
	logoutUrl: 'https://control.example/logout',
	issuerPublicKey: `k1:${'a'.repeat(64)}`,
	ownerSubject: '9f1cb2d4-0000-4000-8000-000000000001',
	audience: 'alice.control.example',
};

const UMAMI: UmamiAnalyticsConfig = {
	host: 'https://control.example/hz',
	websiteId: '2d1f3c4b-5a69-4f7e-8d9c-0b1a2c3d4e5f',
	distinctId: '7c4e1a2b-0000-4000-8000-00000000a11c',
	scriptIntegrity: `sha384-${'A'.repeat(64)}`,
	recorderIntegrity: `sha384-${'B'.repeat(64)}`,
	replay: { sampleRate: 0.5, showText: false },
};

function policy(umami?: UmamiAnalyticsConfig): PolicyConfig {
	return { managedBy: 'Acme Cloud', pinned: {}, ...(umami ? { analytics: { umami } } : {}) };
}

function withSso(sso: SsoConfig | null): void {
	setRuntimeConfig({ ...runtimeConfig(), sso });
}

let app: Hono<Env>;
let db: Db;
let ownerToken: string;
let otherUserToken: string;
let agentToken: string;
let tmp: string;
const watchers: Array<{ close: () => void }> = [];

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	ownerToken = ctx.token;
	tmp = mkdtempSync(join(tmpdir(), 'hezo-analytics-'));

	const other = await db.query<{ id: string }>(
		"INSERT INTO users (display_name, is_superuser) VALUES ('Another user', false) RETURNING id",
	);
	otherUserToken = await signAdminJwt(ctx.masterKeyManager, other.rows[0].id);

	const ceoId = await instanceCeoId(db);
	const ceo = await db.query<{ team_id: string }>('SELECT team_id FROM members WHERE id = $1', [
		ceoId,
	]);
	agentToken = (await mintAgentToken(db, ctx.masterKeyManager, ceoId, ceo.rows[0].team_id)).token;
});

afterEach(() => {
	for (const watcher of watchers.splice(0)) watcher.close();
	// Process-wide runtime config: a case that leaves an issuer or a policy set
	// would change the answer for every case after it.
	resetRuntimeConfig();
});

afterAll(async () => {
	rmSync(tmp, { recursive: true, force: true });
	await safeClose(db);
});

function getAnalytics(token: string) {
	return app.request('/api/analytics', { headers: authHeader(token) });
}

describe('the policy schema', () => {
	function parse(umami: Record<string, unknown>) {
		return policySchema.safeParse({ managedBy: 'Acme', pinned: {}, analytics: { umami } });
	}

	it('accepts a complete block, with or without recording', () => {
		expect(parse({ ...UMAMI }).success).toBe(true);
		expect(parse({ ...UMAMI, replay: undefined }).success).toBe(true);
		expect(parse({ ...UMAMI, replay: { sampleRate: 0, showText: false } }).success).toBe(true);
		expect(parse({ ...UMAMI, replay: { sampleRate: 1, showText: true } }).success).toBe(true);
		expect(parse({ ...UMAMI, distinctId: 'x'.repeat(50) }).success).toBe(true);
	});

	it.each([
		'scriptIntegrity',
		'recorderIntegrity',
	])('accepts one integrity hash or several for %s', (field) => {
		// Several hashes are how an Umami upgrade lists the old and the new
		// script at once, so neither is refused while the files change over.
		const rollout = `sha384-${'A'.repeat(64)} sha512-${'b'.repeat(86)}==`;
		expect(parse({ ...UMAMI, [field]: rollout }).success).toBe(true);
		expect(parse({ ...UMAMI, [field]: `sha256-${'c'.repeat(43)}=` }).success).toBe(true);
	});

	it.each<[string, string, string | undefined]>([
		['scriptIntegrity', 'a missing value', undefined],
		['scriptIntegrity', 'a value with no algorithm', 'A'.repeat(64)],
		['scriptIntegrity', 'an algorithm browsers do not accept', `md5-${'A'.repeat(24)}`],
		[
			'scriptIntegrity',
			'a list joined by commas',
			`sha384-${'A'.repeat(64)},sha384-${'B'.repeat(64)}`,
		],
		['scriptIntegrity', 'an empty value', '  '],
		['recorderIntegrity', 'a missing value', undefined],
		['recorderIntegrity', 'a value with no algorithm', 'A'.repeat(64)],
		['recorderIntegrity', 'an algorithm browsers do not accept', `sha1-${'A'.repeat(28)}`],
		['recorderIntegrity', 'an empty value', ''],
	])('rejects for %s %s', (field, _label, value) => {
		const result = parse({ ...UMAMI, [field]: value });
		expect(result.success).toBe(false);
		expect(JSON.stringify(result.error?.issues)).toContain(field);
	});

	it('keeps the parsed block whole', () => {
		const parsed = policySchema.parse({
			managedBy: 'Acme',
			pinned: {},
			analytics: { umami: UMAMI },
		});
		expect(parsed.analytics).toEqual({ umami: UMAMI });
	});

	it.each<[string, Record<string, unknown>]>([
		['an http host', { host: 'http://control.example/hz' }],
		['a host with a trailing slash', { host: 'https://control.example/hz/' }],
		['a host with a query', { host: 'https://control.example/hz?x=1' }],
		['a host with a fragment', { host: 'https://control.example/hz#x' }],
		['a website id that is not a UUID', { websiteId: 'website-1' }],
		['an empty distinct id', { distinctId: '  ' }],
		['a distinct id over 50 characters', { distinctId: 'x'.repeat(51) }],
		['a sample rate above 1', { replay: { sampleRate: 1.5, showText: false } }],
		['a negative sample rate', { replay: { sampleRate: -0.1, showText: false } }],
		['a sample rate that is not a number', { replay: { sampleRate: '1', showText: false } }],
		['a replay block with no showText', { replay: { sampleRate: 1 } }],
		['a showText that is not a boolean', { replay: { sampleRate: 1, showText: 'yes' } }],
		['an unknown key in the replay block', { replay: { sampleRate: 1, showText: false, x: 1 } }],
		['an unknown key', { domains: 'example.com' }],
		['a missing website id', { websiteId: undefined }],
	])('rejects %s', (_label, change) => {
		expect(parse({ ...UMAMI, ...change }).success).toBe(false);
	});

	it('rejects an unknown analytics tool rather than ignoring it', () => {
		expect(
			policySchema.safeParse({ managedBy: 'Acme', pinned: {}, analytics: { other: {} } }).success,
		).toBe(false);
	});
});

describe('GET /api/analytics', () => {
	it('answers the owner with the block in snake_case', async () => {
		withSso(SSO);
		setPolicy(policy(UMAMI));

		const res = await getAnalytics(ownerToken);
		expect(res.status).toBe(200);
		expect((await res.json()).data).toEqual({
			umami: {
				host: UMAMI.host,
				website_id: UMAMI.websiteId,
				distinct_id: UMAMI.distinctId,
				script_integrity: UMAMI.scriptIntegrity,
				recorder_integrity: UMAMI.recorderIntegrity,
				replay: { sample_rate: 0.5, show_text: false },
			},
		});
	});

	it('sends an account that is never recorded as a null replay', async () => {
		withSso(SSO);
		setPolicy(policy({ ...UMAMI, replay: undefined }));

		const body = await (await getAnalytics(ownerToken)).json();
		expect(body.data.umami.replay).toBeNull();
		expect(body.data.umami.distinct_id).toBe(UMAMI.distinctId);
	});

	it('answers 404 when no analytics are configured', async () => {
		withSso(SSO);
		setPolicy(policy());
		expect((await getAnalytics(ownerToken)).status).toBe(404);

		resetRuntimeConfig();
		withSso(SSO);
		expect((await getAnalytics(ownerToken)).status).toBe(404);
	});

	it('answers 404 to a user who is not the owner', async () => {
		withSso(SSO);
		setPolicy(policy(UMAMI));
		expect((await getAnalytics(otherUserToken)).status).toBe(404);
	});

	it('refuses an agent run', async () => {
		withSso(SSO);
		setPolicy(policy(UMAMI));
		expect((await getAnalytics(agentToken)).status).toBe(401);
	});

	it('answers 404 on an instance with no issuer, even to the superuser', async () => {
		// A self-hosted instance has no issuer-side account for the block to name.
		setPolicy(policy(UMAMI));
		expect((await getAnalytics(ownerToken)).status).toBe(404);
	});

	it('refuses an anonymous caller', async () => {
		withSso(SSO);
		setPolicy(policy(UMAMI));
		expect((await app.request('/api/analytics')).status).toBe(401);
	});

	it('never reaches the public status', async () => {
		withSso(SSO);
		setPolicy(policy(UMAMI));

		const res = await app.request('/api/status');
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).not.toContain(UMAMI.distinctId);
		expect(body).not.toContain(UMAMI.websiteId);
		expect(JSON.parse(body)).not.toHaveProperty('analytics');
	});

	it('follows a policy file the deployer rewrites while the instance runs', async () => {
		// The block rides the file the heartbeat rewrites, so recording turned on
		// or off for one account has to reach the running instance with no restart.
		withSso(SSO);
		const path = join(tmp, 'policy.json');
		writeFileSync(path, JSON.stringify(policy()));
		setPolicy(policy());
		watchers.push(watchPolicyFile(path));

		const renameInto = (body: PolicyConfig) => {
			writeFileSync(`${path}.tmp`, JSON.stringify(body));
			renameSync(`${path}.tmp`, path);
		};
		const replayOf = async () => {
			const res = await getAnalytics(ownerToken);
			return res.status === 200 ? (await res.json()).data.umami.replay : res.status;
		};

		expect(await replayOf()).toBe(404);

		renameInto(policy(UMAMI));
		await expect.poll(replayOf, { timeout: 3000 }).toEqual({ sample_rate: 0.5, show_text: false });

		renameInto(policy({ ...UMAMI, replay: { sampleRate: 1, showText: true } }));
		await expect.poll(replayOf, { timeout: 3000 }).toEqual({ sample_rate: 1, show_text: true });

		renameInto(policy());
		await expect.poll(replayOf, { timeout: 3000 }).toBe(404);
	});
});
