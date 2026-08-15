import { AiProvider } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import type { SandboxFiles } from '../src/services/sandbox/files';
import type { ContainerEngine } from '../src/services/sandbox/types';
import { safeClose } from './helpers';
import { authHeader, createStubDocker, createTestApp } from './helpers/app';

/**
 * The guided sign-in routes, driven against a **scripted container** rather than
 * a real CLI.
 *
 * The container stands in for one: it answers the capability probe, then serves
 * a log the flow polls and an auth file it eventually harvests. That is exactly
 * the surface the service uses (the exec triad plus `SandboxFiles`), so the test
 * exercises the real lifecycle - probe, challenge, harvest, store, teardown -
 * without a vendor account. The parsers themselves are covered against recorded
 * CLI output in `subscription-login-drivers.test.ts`.
 */

let app: Hono<Env>;
let db: Db;
let token: string;
let otherToken: string;

/** What the fake CLI has "printed" so far. */
let log = '';
/** Contents of the auth file, or null while the CLI has not written one. */
let authFile: string | null = null;
/** Container ids created and not yet removed - the teardown assertion. */
let liveContainers: Set<string>;
/** Set when the probe should report a CLI that no longer offers its flag. */
let probeAnswers = true;

const CHALLENGE = [
	'1. Open this link in your browser and sign in to your account',
	'   https://auth.openai.com/codex/device',
	'',
	'2. Enter this one-time code (expires in 15 minutes)',
	'   R314-OEASM',
].join('\n');

const CODEX_AUTH_JSON = JSON.stringify({ tokens: { refresh_token: 'rt-from-container' } });

function scriptedFiles(): SandboxFiles {
	return {
		exists: async (rel: string) => (rel.endsWith('auth.json') ? authFile !== null : rel === 'out'),
		read: async (rel: string) => {
			if (rel.endsWith('auth.json')) {
				if (authFile === null) throw new Error('no auth file yet');
				return authFile;
			}
			return log;
		},
		readBytes: async () => new Uint8Array(),
		size: async () => 0,
		remove: async () => undefined,
		findByName: async () => [],
		write: async () => undefined,
		mkdir: async () => undefined,
	} as unknown as SandboxFiles;
}

function scriptedDocker(): ContainerEngine {
	const scripts = new Map<string, string>();
	let n = 0;
	return createStubDocker({
		imageExists: async () => true,
		createContainer: async (name: string) => {
			const Id = `login-${name}`;
			liveContainers.add(Id);
			return { Id, Warnings: [] };
		},
		startContainer: async () => undefined,
		removeContainer: async (id: string) => {
			liveContainers.delete(id);
		},
		execCreate: async (_id: string, config: { Cmd: string[] }) => {
			const execId = `exec-${++n}`;
			scripts.set(execId, config.Cmd.join(' '));
			return execId;
		},
		execStart: async (execId: string) => {
			const script = scripts.get(execId) ?? '';
			// The capability probe: answer as `codex login --help` would.
			if (script.includes('--help')) {
				return { stdout: probeAnswers ? 'Options:\n --device-auth\n' : 'Options:\n', stderr: '' };
			}
			return { stdout: 'started', stderr: '' };
		},
		execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 1 }),
		files: () => scriptedFiles(),
	});
}

async function post(path: string, body: unknown, t = token) {
	return app.request(path, {
		method: 'POST',
		headers: { ...authHeader(t), 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
}

/** Poll until the flow leaves `starting`, or give up. */
async function pollUntil(flowId: string, want: string, t = token) {
	for (let i = 0; i < 40; i++) {
		const res = await app.request(`/api/ai-providers/subscription-login/${flowId}`, {
			headers: authHeader(t),
		});
		const body = await res.json();
		if (body.data?.status === want) return { res, body: body.data };
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`flow never reached ${want}`);
}

beforeAll(async () => {
	const ctx = await createTestApp({ docker: scriptedDocker() });
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	const other = await db.query<{ id: string }>(
		"INSERT INTO users (display_name, is_superuser) VALUES ('Other Admin', true) RETURNING id",
	);
	otherToken = await signAdminJwt(ctx.masterKeyManager, other.rows[0].id);
});

beforeEach(async () => {
	log = '';
	authFile = null;
	probeAnswers = true;
	liveContainers = new Set();
	await db.query('DELETE FROM ai_provider_configs');
});

afterAll(async () => {
	await safeClose(db);
});

describe('starting a sign-in', () => {
	it('refuses a provider whose CLI has no driver, before creating a container', async () => {
		const res = await post('/api/ai-providers/subscription-login/start', {
			provider: AiProvider.Google,
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('LOGIN_UNSUPPORTED');
		// The cheap answer matters: the dialog asks on every open.
		expect(liveContainers.size).toBe(0);
	});

	it('refuses a provider with no subscription auth at all', async () => {
		const res = await post('/api/ai-providers/subscription-login/start', {
			provider: AiProvider.DeepSeek,
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('NO_SUBSCRIPTION');
	});

	it('releases the container when the installed CLI no longer offers its flag', async () => {
		probeAnswers = false;
		const res = await post('/api/ai-providers/subscription-login/start', {
			provider: AiProvider.OpenAI,
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('LOGIN_UNSUPPORTED');
		expect(liveContainers.size).toBe(0);
	});

	it('rejects a caller who is not admin-equivalent', async () => {
		const res = await app.request('/api/ai-providers/subscription-login/start', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ provider: AiProvider.OpenAI }),
		});
		expect(res.status).toBe(401);
	});
});

describe('a sign-in that completes', () => {
	it('surfaces the challenge, stores the credential, and never returns it', async () => {
		const start = await post('/api/ai-providers/subscription-login/start', {
			provider: AiProvider.OpenAI,
			label: 'My ChatGPT',
		});
		expect(start.status).toBe(201);
		const { flow_id } = (await start.json()).data;
		expect(liveContainers.size).toBe(1);

		// The CLI prints its challenge.
		log = CHALLENGE;
		const { body: challenge } = await pollUntil(flow_id, 'awaiting_user');
		expect(challenge.url).toBe('https://auth.openai.com/codex/device');
		expect(challenge.user_code).toBe('R314-OEASM');
		// Codex polls OpenAI itself, so Hezo asks the operator for nothing.
		expect(challenge.completion).toBe('none');

		// The operator finishes elsewhere and the CLI writes its auth file.
		authFile = CODEX_AUTH_JSON;
		const { body: done } = await pollUntil(flow_id, 'succeeded');
		expect(done.config_id).toBeTruthy();

		// The whole point: the credential is stored server-side and the browser
		// never sees it.
		expect(JSON.stringify(done)).not.toContain('rt-from-container');

		const stored = await db.query<{ auth_method: string; label: string; runtime: string | null }>(
			'SELECT auth_method, label, runtime FROM ai_provider_configs WHERE id = $1',
			[done.config_id],
		);
		expect(stored.rows[0].auth_method).toBe('subscription');
		expect(stored.rows[0].label).toBe('My ChatGPT');

		// The container is released the moment the credential is harvested.
		expect(liveContainers.size).toBe(0);
	});

	it('stores exactly one config even when polls overlap', async () => {
		const start = await post('/api/ai-providers/subscription-login/start', {
			provider: AiProvider.OpenAI,
		});
		const { flow_id } = (await start.json()).data;
		log = CHALLENGE;
		await pollUntil(flow_id, 'awaiting_user');
		authFile = CODEX_AUTH_JSON;
		await pollUntil(flow_id, 'succeeded');

		// Three concurrent polls after success - the shape a client produces when
		// it asks again before the previous answer lands.
		const again = await Promise.all(
			[0, 1, 2].map(() =>
				app.request(`/api/ai-providers/subscription-login/${flow_id}`, {
					headers: authHeader(token),
				}),
			),
		);
		for (const res of again) expect(res.status).toBe(200);

		const count = await db.query<{ n: string }>('SELECT COUNT(*) AS n FROM ai_provider_configs');
		expect(Number(count.rows[0].n)).toBe(1);
	});
});

describe('flow ownership', () => {
	it('hides a flow from a different admin', async () => {
		const start = await post('/api/ai-providers/subscription-login/start', {
			provider: AiProvider.OpenAI,
		});
		const { flow_id } = (await start.json()).data;

		const res = await app.request(`/api/ai-providers/subscription-login/${flow_id}`, {
			headers: authHeader(otherToken),
		});
		expect(res.status).toBe(404);
	});

	it('will not let a different admin cancel it', async () => {
		const start = await post('/api/ai-providers/subscription-login/start', {
			provider: AiProvider.OpenAI,
		});
		const { flow_id } = (await start.json()).data;

		const res = await app.request(`/api/ai-providers/subscription-login/${flow_id}`, {
			method: 'DELETE',
			headers: authHeader(otherToken),
		});
		expect(res.status).toBe(404);
		expect(liveContainers.size).toBe(1);
	});
});

describe('cancelling', () => {
	it('releases the container', async () => {
		const start = await post('/api/ai-providers/subscription-login/start', {
			provider: AiProvider.OpenAI,
		});
		const { flow_id } = (await start.json()).data;
		expect(liveContainers.size).toBe(1);

		const res = await app.request(`/api/ai-providers/subscription-login/${flow_id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		expect(liveContainers.size).toBe(0);
	});
});

describe('submitting a code', () => {
	it('refuses a code for a flow that never asked for one', async () => {
		const start = await post('/api/ai-providers/subscription-login/start', {
			provider: AiProvider.OpenAI,
		});
		const { flow_id } = (await start.json()).data;
		log = CHALLENGE;
		await pollUntil(flow_id, 'awaiting_user');

		// Codex polls the vendor itself; stray input would land in front of
		// whatever it does read.
		const res = await post(`/api/ai-providers/subscription-login/${flow_id}/code`, {
			code: 'ABC123',
		});
		expect(res.status).toBe(404);
	});

	it('rejects an empty code', async () => {
		const res = await post('/api/ai-providers/subscription-login/nonexistent/code', { code: '  ' });
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_CODE');
	});
});
