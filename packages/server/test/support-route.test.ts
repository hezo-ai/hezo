/**
 * The support channel a deployer hands an instance: what the policy file may
 * carry, and who is allowed to read it back.
 *
 * The identity in the block lets its holder write to the support team as the
 * account that owns the instance, so the route is the interesting half. It
 * must answer the owner's session, and answer everyone else - another user, an
 * agent run, any caller on an instance with no issuer - exactly as it answers
 * when nothing is configured.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readPolicyFile } from '../src/config/policy';
import {
	resetRuntimeConfig,
	runtimeConfig,
	setPolicy,
	setRuntimeConfig,
} from '../src/config/runtime';
import { policySchema } from '../src/config/schema';
import type { ChatwootSupportConfig, PolicyConfig, SsoConfig } from '../src/config/types';
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

const CHATWOOT: ChatwootSupportConfig = {
	baseUrl: 'https://chat.example',
	websiteToken: 'website-token',
	sdkIntegrity: `sha384-${'A'.repeat(64)}`,
	identifier: '5b0c8f5e-0000-4000-8000-000000000002',
	identifierHash: 'f'.repeat(64),
	name: 'alice',
	email: 'alice@example.com',
};

function policy(chatwoot?: ChatwootSupportConfig): PolicyConfig {
	return { managedBy: 'Acme Cloud', pinned: {}, ...(chatwoot ? { support: { chatwoot } } : {}) };
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

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	ownerToken = ctx.token;
	tmp = mkdtempSync(join(tmpdir(), 'hezo-support-'));

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
	// Process-wide runtime config: a case that leaves an issuer or a policy set
	// would change the answer for every case after it.
	resetRuntimeConfig();
});

afterAll(async () => {
	rmSync(tmp, { recursive: true, force: true });
	await safeClose(db);
});

function getSupport(token: string) {
	return app.request('/api/support', { headers: authHeader(token) });
}

describe('the policy schema', () => {
	function parse(chatwoot: Record<string, unknown>) {
		return policySchema.safeParse({ managedBy: 'Acme', pinned: {}, support: { chatwoot } });
	}

	it('accepts a complete block, and one integrity hash or several', () => {
		expect(parse({ ...CHATWOOT }).success).toBe(true);
		// Several hashes are how a deployer rolls a new script with no moment
		// where either the old or the new one is refused.
		const rollout = `sha384-${'A'.repeat(64)} sha512-${'b'.repeat(86)}==`;
		expect(parse({ ...CHATWOOT, sdkIntegrity: rollout }).success).toBe(true);
		expect(parse({ ...CHATWOOT, name: undefined }).success).toBe(true);
		expect(parse({ ...CHATWOOT, email: undefined }).success).toBe(true);
	});

	it.each<[string, Record<string, unknown>]>([
		['an http origin', { baseUrl: 'http://chat.example' }],
		['an integrity value with no algorithm', { sdkIntegrity: 'A'.repeat(64) }],
		['an integrity algorithm browsers do not accept', { sdkIntegrity: `md5-${'A'.repeat(24)}` }],
		['an uppercase identity hash', { identifierHash: 'F'.repeat(64) }],
		['a short identity hash', { identifierHash: 'f'.repeat(63) }],
		['an empty website token', { websiteToken: '  ' }],
		['an empty identifier', { identifier: '' }],
		['an unknown key', { baseDomain: 'example.com' }],
		['neither a name nor an email', { name: undefined, email: undefined }],
	])('rejects %s', (_label, change) => {
		expect(parse({ ...CHATWOOT, ...change }).success).toBe(false);
	});

	it('rejects an unknown support channel rather than ignoring it', () => {
		expect(
			policySchema.safeParse({ managedBy: 'Acme', pinned: {}, support: { other: {} } }).success,
		).toBe(false);
	});
});

describe('GET /api/support', () => {
	it('answers the owner with the block', async () => {
		withSso(SSO);
		setPolicy(policy(CHATWOOT));

		const res = await getSupport(ownerToken);
		expect(res.status).toBe(200);
		expect((await res.json()).data).toEqual({
			chatwoot: {
				base_url: CHATWOOT.baseUrl,
				website_token: CHATWOOT.websiteToken,
				sdk_integrity: CHATWOOT.sdkIntegrity,
				identifier: CHATWOOT.identifier,
				identifier_hash: CHATWOOT.identifierHash,
				name: CHATWOOT.name,
				email: CHATWOOT.email,
			},
		});
	});

	it('sends an absent name or email as null', async () => {
		withSso(SSO);
		setPolicy(policy({ ...CHATWOOT, name: undefined }));

		const body = await (await getSupport(ownerToken)).json();
		expect(body.data.chatwoot.name).toBeNull();
		expect(body.data.chatwoot.email).toBe(CHATWOOT.email);
	});

	it('answers 404 when no channel is configured', async () => {
		withSso(SSO);
		setPolicy(policy());
		expect((await getSupport(ownerToken)).status).toBe(404);

		resetRuntimeConfig();
		withSso(SSO);
		expect((await getSupport(ownerToken)).status).toBe(404);
	});

	it('answers 404 to a user who is not the owner', async () => {
		withSso(SSO);
		setPolicy(policy(CHATWOOT));
		expect((await getSupport(otherUserToken)).status).toBe(404);
	});

	it('answers 404 to an agent run', async () => {
		withSso(SSO);
		setPolicy(policy(CHATWOOT));
		expect((await getSupport(agentToken)).status).toBe(404);
	});

	it('answers 404 on an instance with no issuer, even to the superuser', async () => {
		// Without an issuer there is no issuer-side account for the identity to
		// belong to, so nobody signed in here is its owner.
		setPolicy(policy(CHATWOOT));
		expect((await getSupport(ownerToken)).status).toBe(404);
	});

	it('refuses an anonymous caller', async () => {
		withSso(SSO);
		setPolicy(policy(CHATWOOT));
		expect((await app.request('/api/support')).status).toBe(401);
	});

	it('follows a policy file rewritten while the instance runs', async () => {
		// The block rides the same file a deployer rewrites for a plan change, so
		// a channel added or removed there must show without a restart.
		withSso(SSO);
		const path = join(tmp, 'policy.json');

		writeFileSync(path, JSON.stringify(policy(CHATWOOT)));
		setPolicy(readPolicyFile(path) ?? null);
		expect((await getSupport(ownerToken)).status).toBe(200);

		writeFileSync(path, JSON.stringify(policy()));
		setPolicy(readPolicyFile(path) ?? null);
		expect((await getSupport(ownerToken)).status).toBe(404);
	});
});

/**
 * The screens before a session — the vault gate, the language step, the sign-in
 * form — are where somebody shut out of their own instance waits, so the chat
 * has to load there. What they may know is where the chat is, never who the
 * owner is: this instance answers to anyone who has its address.
 */
describe('the public status payload', () => {
	async function status(): Promise<Record<string, unknown>> {
		const res = await app.request('/api/status');
		expect(res.status).toBe(200);
		return (await res.json()) as Record<string, unknown>;
	}

	it('says where the chat is, to a caller with no session at all', async () => {
		withSso(SSO);
		setPolicy(policy(CHATWOOT));

		expect((await status()).support).toEqual({
			base_url: CHATWOOT.baseUrl,
			website_token: CHATWOOT.websiteToken,
			sdk_integrity: CHATWOOT.sdkIntegrity,
		});
	});

	it('never says who the owner is, nor signs anything for them', async () => {
		withSso(SSO);
		setPolicy(policy(CHATWOOT));

		// Whoever holds these writes to the support team as the owner, and reads
		// what the team wrote back. They belong to the owner's own session.
		const body = JSON.stringify(await status());
		expect(body).not.toContain(CHATWOOT.identifier);
		expect(body).not.toContain(CHATWOOT.identifierHash);
		expect(body).not.toContain(CHATWOOT.email);
	});

	it('leaves the field out where no chat is configured', async () => {
		withSso(SSO);
		setPolicy(policy());
		expect(await status()).not.toHaveProperty('support');

		setPolicy(null);
		expect(await status()).not.toHaveProperty('support');
	});

	// The chat is the deployer's, and an instance with no issuer has no deployer
	// on the other side of it — the same reason the sign-in hint keys on one.
	it('leaves the field out on an instance with no issuer', async () => {
		withSso(null);
		setPolicy(policy(CHATWOOT));
		expect(await status()).not.toHaveProperty('support');
	});

	// The block rides a file the deployer rewrites, and the status is what every
	// pre-auth screen reads, so a chat added there must show without a restart.
	it('follows a policy file rewritten while the instance runs', async () => {
		withSso(SSO);
		const path = join(tmp, 'status-policy.json');

		writeFileSync(path, JSON.stringify(policy()));
		setPolicy(readPolicyFile(path) ?? null);
		expect(await status()).not.toHaveProperty('support');

		writeFileSync(path, JSON.stringify(policy(CHATWOOT)));
		setPolicy(readPolicyFile(path) ?? null);
		expect(await status()).toHaveProperty('support');
	});
});
