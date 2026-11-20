import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encrypt } from '../../src/crypto/encryption';
import { MasterKeyManager } from '../../src/crypto/master-key';
import { invalidateSecretsVault } from '../../src/services/egress/substitution';
import { createTestContext, destroyTestContext, type ServerTestContext } from '../helpers/context';
import {
	type FakeCollector,
	otlpConfig,
	seedWorld,
	startExporter,
	startFakeCollector,
	waitFor,
} from './helpers';

async function seedSecret(
	ctx: ServerTestContext,
	name: string,
	value: string,
	allowedHosts: string[],
): Promise<void> {
	const key = ctx.masterKeyManager.getKey();
	if (!key) throw new Error('test master key unavailable');
	await ctx.db.query(
		`INSERT INTO secrets (name, encrypted_value, category, allowed_hosts)
		 VALUES ($1, $2, 'api_token', $3)`,
		[name, await encrypt(value, key), allowedHosts],
	);
	// The vault is a module-level cache; a secret written after a load is
	// invisible until the cache is dropped, as a real write would do.
	invalidateSecretsVault();
}

/** A manager booted against the same database with no unlock key: state `locked`. */
async function bootLockedManager(ctx: ServerTestContext): Promise<MasterKeyManager> {
	const manager = new MasterKeyManager();
	const state = await manager.initialize(ctx.db);
	expect(state).toBe('locked');
	return manager;
}

function spanRecord(world: Awaited<ReturnType<typeof seedWorld>>, runId: string) {
	return {
		runId,
		teamId: world.teamId,
		projectId: world.projectId,
		agentMemberId: world.agentId,
		taskId: world.taskId,
		status: 'succeeded' as const,
		exitCode: 0,
		errorText: null,
		startedAt: '2026-11-20T00:00:00.000Z',
		finishedAt: '2026-11-20T00:04:02.000Z',
		provider: 'anthropic',
		model: 'claude-sonnet-5',
		tokens: { input: 1, output: 1, cacheRead: null, cacheCreation: null },
		toolCalls: null,
		stopReason: null,
		retryOfRunId: null,
		triggerSource: 'task',
	};
}

describe('OTLP locked master key', () => {
	let ctx: ServerTestContext;
	let collector: FakeCollector;

	beforeEach(async () => {
		ctx = await createTestContext();
		collector = await startFakeCollector();
	});

	afterEach(async () => {
		await collector.close();
		await destroyTestContext(ctx);
	});

	it('starts locked with a named secret and sends nothing', async () => {
		const name = `OTLP_LOCKED_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
		await seedSecret(ctx, name, 'Bearer locked-token', ['127.0.0.1']);
		const manager = await bootLockedManager(ctx);
		const exporter = await startExporter(
			ctx,
			otlpConfig(collector.endpoint, { headersSecret: name }),
			{ masterKeyManager: manager },
		);
		const world = await seedWorld(ctx, 'locked');
		try {
			expect(exporter.status()).toMatchObject({ state: 'locked', lastError: null });
			exporter.emitRunFinished(spanRecord(world, crypto.randomUUID()));
			await new Promise((resolve) => setTimeout(resolve, 1200));
			expect(collector.requests).toHaveLength(0);
		} finally {
			await exporter.stop();
		}
	});

	it('becomes ready and sends once unlocked with an allowing host', async () => {
		const name = `OTLP_ALLOW_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
		const token = 'Bearer unlocked-token';
		await seedSecret(ctx, name, token, ['127.0.0.1']);
		const manager = await bootLockedManager(ctx);
		const exporter = await startExporter(
			ctx,
			otlpConfig(collector.endpoint, { headersSecret: name }),
			{ masterKeyManager: manager },
		);
		const world = await seedWorld(ctx, 'unlock');
		const runId = crypto.randomUUID();
		try {
			expect(await manager.unlock(ctx.db, ctx.unlockKeyHex)).toBe(true);
			await waitFor(() => exporter.status().state === 'ready');
			exporter.emitRunFinished(spanRecord(world, runId));
			await exporter.flush(2000);

			const trace = collector.requests.find((r) => r.url.endsWith('/v1/traces'));
			expect(trace?.body).toContain(runId);
			expect(trace?.headers.authorization).toBe(token);
			expect(exporter.status().state).toBe('ready');
		} finally {
			await exporter.stop();
		}
	});

	it('becomes blocked when the resolved secret excludes the endpoint host', async () => {
		const name = `OTLP_BLOCK_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
		await seedSecret(ctx, name, 'Bearer elsewhere', ['collector.example']);
		const manager = await bootLockedManager(ctx);
		const exporter = await startExporter(
			ctx,
			otlpConfig(collector.endpoint, { headersSecret: name }),
			{ masterKeyManager: manager },
		);
		try {
			expect(await manager.unlock(ctx.db, ctx.unlockKeyHex)).toBe(true);
			await waitFor(() => exporter.status().state === 'blocked');
			expect(exporter.status()).toEqual({
				state: 'blocked',
				reason: 'endpoint_not_allowed_by_secret',
			});
			expect(collector.requests).toHaveLength(0);
		} finally {
			await exporter.stop();
		}
	});

	it('stays locked and names the secret when it is absent at unlock', async () => {
		const name = `OTLP_MISSING_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
		const manager = await bootLockedManager(ctx);
		const exporter = await startExporter(
			ctx,
			otlpConfig(collector.endpoint, { headersSecret: name }),
			{ masterKeyManager: manager },
		);
		try {
			expect(await manager.unlock(ctx.db, ctx.unlockKeyHex)).toBe(true);
			await waitFor(() => {
				const status = exporter.status();
				return status.state === 'locked' && status.lastError !== null;
			});
			const status = exporter.status();
			expect(status.state).toBe('locked');
			expect((status as { lastError: string | null }).lastError).toContain(name);
			expect(collector.requests).toHaveLength(0);
		} finally {
			await exporter.stop();
		}
	});
});
