import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import { probeUnverifiedConnectors } from '../src/services/connectors/method-discovery';
import { safeClose } from './helpers';
import { createTestApp } from './helpers/app';
import { startTestMcpHttpServer, type TestMcpServer } from './helpers/test-mcp-http-server';

/**
 * The sweep is the only thing that re-examines a hosted connector carrying no
 * credential. The token sweep it shares a tick with reads `oauth_connections`,
 * so a row with no connection is structurally invisible to it, and before this
 * existed such a row was handed to every agent run forever on an assumption
 * nothing ever checked.
 */

let ctx: Awaited<ReturnType<typeof createTestApp>>;
let db: Db;
let deps: Parameters<typeof probeUnverifiedConnectors>[0];
let good: TestMcpServer;
let refuses: TestMcpServer;

const OPTS = { limit: 10, staleAfterMs: 6 * 60 * 60_000, concurrency: 3 };

async function seed(
	name: string,
	url: string,
	extraColumns = '',
	extraValues = '',
): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO mcp_connections (name, kind, config, install_status${extraColumns})
		 VALUES ($1, 'saas', $2::jsonb, 'installed'${extraValues})
		 RETURNING id`,
		[name, JSON.stringify({ url })],
	);
	return r.rows[0].id;
}

async function evidence(
	id: string,
): Promise<{ probed_at: string | null; probe_error: string | null }> {
	const r = await db.query<{ probed_at: string | null; probe_error: string | null }>(
		`SELECT probed_at::text AS probed_at, probe_error::text AS probe_error
		 FROM mcp_connections WHERE id = $1`,
		[id],
	);
	return r.rows[0];
}

beforeAll(async () => {
	ctx = await createTestApp();
	db = ctx.db;
	deps = { db, masterKeyManager: ctx.masterKeyManager };
	good = await startTestMcpHttpServer();
	refuses = await startTestMcpHttpServer({ failWithStatus: 401 });
});

afterAll(async () => {
	await good.close();
	await refuses.close();
	await safeClose(db);
});

describe('probeUnverifiedConnectors', () => {
	it('proves a public server and records the refusal of one that wants auth', async () => {
		const publicId = await seed('sweep-public', `http://127.0.0.1:${good.port}/mcp`);
		const wantsAuthId = await seed('sweep-wants-auth', `http://127.0.0.1:${refuses.port}/mcp`);

		const { probed } = await probeUnverifiedConnectors(deps, OPTS);
		expect(probed).toBe(2);

		const proven = await evidence(publicId);
		expect(proven.probed_at).not.toBeNull();
		expect(proven.probe_error).toBeNull();

		const refused = await evidence(wantsAuthId);
		expect(refused.probed_at).not.toBeNull();
		expect(refused.probe_error).toBe('auth_required');

		// And that is exactly what the run gate reads.
		const { loadConnectorsForRun } = await import('../src/services/connectors/connections');
		const names = (await loadConnectorsForRun(db)).map((r) => r.name);
		expect(names).toContain('sweep-public');
		expect(names).not.toContain('sweep-wants-auth');
	});

	it('records an unreachable server without claiming its credential is wrong', async () => {
		// A closed port: nothing answered, which says nothing about auth.
		const dead = await startTestMcpHttpServer();
		const port = dead.port;
		await dead.close();
		const id = await seed('sweep-dead', `http://127.0.0.1:${port}/mcp`);

		await probeUnverifiedConnectors(deps, OPTS);
		const row = await evidence(id);
		expect(row.probed_at).not.toBeNull();
		expect(row.probe_error).toBe('unreachable');
	});

	it('leaves fresh evidence alone and re-proves the stalest first', async () => {
		await db.query(`DELETE FROM mcp_connections`);
		const fresh = await seed(
			'sweep-fresh',
			`http://127.0.0.1:${good.port}/mcp`,
			', probed_at',
			", now() - interval '1 hour'",
		);
		const stale = await seed(
			'sweep-stale',
			`http://127.0.0.1:${good.port}/mcp`,
			', probed_at, probe_error',
			", now() - interval '2 days', 'unreachable'::connector_probe_error",
		);
		const never = await seed('sweep-never', `http://127.0.0.1:${good.port}/mcp`);

		// One slot, so only the most overdue row can be taken. Never-probed is the
		// most overdue of all, which is why the index declares NULLS FIRST.
		const first = await probeUnverifiedConnectors(deps, { ...OPTS, limit: 1 });
		expect(first.probed).toBe(1);
		expect((await evidence(never)).probed_at).not.toBeNull();
		expect((await evidence(stale)).probe_error).toBe('unreachable');

		const second = await probeUnverifiedConnectors(deps, { ...OPTS, limit: 1 });
		expect(second.probed).toBe(1);
		// The stale row was re-proved, and the fresh one was never touched.
		expect((await evidence(stale)).probe_error).toBeNull();
		const freshRow = await evidence(fresh);
		expect(freshRow.probe_error).toBeNull();
		expect(Date.parse(freshRow.probed_at ?? '')).toBeLessThan(Date.now() - 30 * 60_000);
	});

	it('never probes a connector that already carries a credential', async () => {
		await db.query(`DELETE FROM mcp_connections`);
		const secret = await db.query<{ id: string }>(
			`INSERT INTO secrets (name, encrypted_value) VALUES ('MCP_SWEEP_SKIP', 'enc') RETURNING id`,
		);
		const id = await seed('sweep-keyed', `http://127.0.0.1:${refuses.port}/mcp`);
		await db.query(
			`UPDATE mcp_connections SET api_key_secret_id = $1, activated_at = now() WHERE id = $2`,
			[secret.rows[0].id, id],
		);

		const { probed } = await probeUnverifiedConnectors(deps, OPTS);
		expect(probed).toBe(0);
		expect((await evidence(id)).probed_at).toBeNull();
	});

	it('never probes a connector whose credential is a placeholder header', async () => {
		// The egress proxy substitutes it at request time, so a probe from here
		// would go out unauthenticated, be refused, and record a verdict about a
		// credential it never carried.
		await db.query(`DELETE FROM mcp_connections`);
		const r = await db.query<{ id: string }>(
			`INSERT INTO mcp_connections (name, kind, config, install_status)
			 VALUES ('sweep-header-auth', 'saas', $1::jsonb, 'installed') RETURNING id`,
			[
				JSON.stringify({
					url: `http://127.0.0.1:${refuses.port}/mcp`,
					headers: { Authorization: 'Bearer __HEZO_SECRET_TRACKER_KEY__' },
				}),
			],
		);

		const { probed } = await probeUnverifiedConnectors(deps, OPTS);
		expect(probed).toBe(0);
		expect((await evidence(r.rows[0].id)).probed_at).toBeNull();
	});

	it('skips revoked and non-hosted rows', async () => {
		await db.query(`DELETE FROM mcp_connections`);
		await seed('sweep-revoked', `http://127.0.0.1:${good.port}/mcp`, ', revoked_at', ', now()');
		await db.query(
			`INSERT INTO mcp_connections (name, kind, config, install_status)
			 VALUES ('sweep-local', 'local', $1::jsonb, 'installed')`,
			[JSON.stringify({ command: '/usr/bin/srv' })],
		);
		const { probed } = await probeUnverifiedConnectors(deps, OPTS);
		expect(probed).toBe(0);
	});

	it('gives up on a server that never answers, rather than wedging the tick', async () => {
		// Without a deadline the MCP client's connect runs on a bare fetch and
		// waits forever. On a cron that is not one slow probe, it is every later
		// tick: the sweep runs under a guard that will not start again while this
		// one is still in flight.
		await db.query(`DELETE FROM mcp_connections`);
		const stuck = await startTestMcpHttpServer({ hang: true });
		try {
			const id = await seed('sweep-hangs', `http://127.0.0.1:${stuck.port}/mcp`);
			const started = Date.now();
			await probeUnverifiedConnectors(deps, OPTS);
			// The deadline is 20s; the assertion is that it returns at all, well
			// inside the suite's own timeout.
			expect(Date.now() - started).toBeLessThan(40_000);
			const row = await evidence(id);
			expect(row.probed_at).not.toBeNull();
			expect(row.probe_error).toBe('unreachable');
		} finally {
			await stuck.close();
		}
	}, 60_000);
});
