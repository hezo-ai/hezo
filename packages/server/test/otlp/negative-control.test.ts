import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encrypt } from '../../src/crypto/encryption';
import { DomainEventBus } from '../../src/events/bus';
import { registerOtlpObserver } from '../../src/events/otlp-observer';
import { createTestContext, destroyTestContext, type ServerTestContext } from '../helpers/context';
import {
	type FakeCollector,
	otlpConfig,
	seedRun,
	seedWorld,
	startExporter,
	startFakeCollector,
} from './helpers';

/**
 * The test that protects the privacy model. Every text surface a run touches
 * carries its own sentinel; after a full event-to-wire pass with both opt-ins
 * on, none of them may appear in the request body, and the span's attribute
 * keys must be exactly the allowlist.
 */
describe('OTLP negative control', () => {
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

	it('never emits a sentinel from any run text surface', async () => {
		const tag = Math.random().toString(36).slice(2, 10);
		const sentinel = (what: string) => `SENTINEL_${what}_${tag}`;
		const world = await seedWorld(ctx, 'privacy');

		await ctx.db.query('UPDATE tasks SET title = $2, description = $3 WHERE id = $1', [
			world.taskId,
			sentinel('TASK_TITLE'),
			sentinel('TASK_DESCRIPTION'),
		]);
		await ctx.db.query(
			`UPDATE member_agents SET role_description = $2, summary = $3, team_context = $4,
			   title = $5
			 WHERE id = $1`,
			[
				world.agentId,
				sentinel('PROMPT_BODY'),
				sentinel('AGENT_SUMMARY'),
				sentinel('TEAM_CONTEXT'),
				'Engineer',
			],
		);
		await ctx.db.query(
			`INSERT INTO repos (project_id, repo_identifier, host_type)
			 VALUES ($1, $2, 'github')`,
			[world.projectId, sentinel('REPO_NAME')],
		);
		await ctx.db.query(
			`INSERT INTO task_comments (task_id, author_member_id, content, public_id)
			 VALUES ($1, $2, $3::jsonb, $4)`,
			[world.taskId, world.agentId, JSON.stringify({ text: sentinel('COMMENT_BODY') }), `T${tag}`],
		);
		const key = ctx.masterKeyManager.getKey();
		if (!key) throw new Error('test master key unavailable');
		await ctx.db.query(
			`INSERT INTO secrets (name, encrypted_value, category, allowed_hosts)
			 VALUES ($1, $2, 'api_token', '{}')`,
			[`SENTINEL_SECRET_${tag.toUpperCase()}`, await encrypt(sentinel('SECRET_VALUE'), key)],
		);

		const runId = await seedRun(ctx, world, {
			invocationCommand: sentinel('INVOCATION'),
			logText: sentinel('LOG_CHUNK'),
			workingDir: sentinel('WORKING_DIR'),
			error: 'the run failed cleanly',
		});
		await ctx.db.query('UPDATE tasks SET branch_name = $2 WHERE id = $1', [
			world.taskId,
			sentinel('BRANCH'),
		]);

		const config = otlpConfig(collector.endpoint, {
			includeNames: true,
			includeErrorText: true,
		});
		const exporter = await startExporter(ctx, config);
		const events = new DomainEventBus();
		registerOtlpObserver(events, ctx.db, exporter, config);
		try {
			events.emit({
				type: 'agent_run.started',
				runId,
				taskId: world.taskId,
				agentMemberId: world.agentId,
				triggerSource: 'task',
				teamId: world.teamId,
				projectId: world.projectId,
			});
			events.emit({
				type: 'agent_run.completed',
				runId,
				taskId: world.taskId,
				agentMemberId: world.agentId,
				status: 'succeeded',
				exitCode: 0,
				teamId: world.teamId,
				projectId: world.projectId,
			});
			await exporter.flush(2000);
		} finally {
			await exporter.stop();
		}

		const traceRequest = collector.requests.find((r) => r.url.endsWith('/v1/traces'));
		expect(traceRequest).toBeDefined();
		const serialized = collector.requests.map((r) => r.body).join('\n');
		for (const what of [
			'TASK_TITLE',
			'TASK_DESCRIPTION',
			'PROMPT_BODY',
			'AGENT_SUMMARY',
			'TEAM_CONTEXT',
			'REPO_NAME',
			'COMMENT_BODY',
			'SECRET_VALUE',
			'INVOCATION',
			'LOG_CHUNK',
			'WORKING_DIR',
			'BRANCH',
		]) {
			expect(serialized).not.toContain(sentinel(what));
		}

		const parsed = JSON.parse(traceRequest?.body ?? '{}') as {
			resourceSpans: Array<{
				scopeSpans: Array<{ spans: Array<{ name: string; attributes: Array<{ key: string }> }> }>;
			}>;
		};
		const span = parsed.resourceSpans[0]?.scopeSpans[0]?.spans[0];
		expect(span?.name).toBe('hezo.agent_run');
		expect(new Set(span?.attributes.map((a) => a.key))).toEqual(
			new Set([
				'hezo.run.id',
				'hezo.team.id',
				'hezo.project.id',
				'hezo.task.id',
				'hezo.agent.id',
				'hezo.run.status',
				'hezo.run.exit_code',
				'hezo.run.trigger_source',
				'hezo.provider',
				'hezo.model',
				'hezo.tokens.input',
				'hezo.tokens.output',
				'hezo.tokens.cache_read',
				'hezo.tokens.cache_creation',
				'hezo.tool.calls',
				'hezo.run.error',
				'hezo.project.name',
				'hezo.team.name',
				'hezo.agent.name',
			]),
		);
		// A stable digest of the key set: any new key fails here even if its value
		// happens to be empty or null.
		const digest = createHash('sha256')
			.update((span?.attributes.map((a) => a.key) ?? []).slice().sort().join('\n'))
			.digest('hex');
		expect(digest).toBe(
			createHash('sha256')
				.update(
					[
						'hezo.agent.id',
						'hezo.agent.name',
						'hezo.model',
						'hezo.project.id',
						'hezo.project.name',
						'hezo.provider',
						'hezo.run.error',
						'hezo.run.exit_code',
						'hezo.run.id',
						'hezo.run.status',
						'hezo.run.trigger_source',
						'hezo.task.id',
						'hezo.team.id',
						'hezo.team.name',
						'hezo.tokens.cache_creation',
						'hezo.tokens.cache_read',
						'hezo.tokens.input',
						'hezo.tokens.output',
						'hezo.tool.calls',
					].join('\n'),
				)
				.digest('hex'),
		);
	});
});
