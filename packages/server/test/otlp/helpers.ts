import { createServer, type Server } from 'node:http';
import type { OtlpConfig } from '../../src/config/types';
import { DEFAULT_CONFIG } from '../../src/config/types';
import type { MasterKeyManager } from '../../src/crypto/master-key';
import type { Db } from '../../src/db/database';
import { createOtlpExporter, type OtlpExporterHandle } from '../../src/services/otlp/exporter';
import type { ServerTestContext } from '../helpers/context';

/** One captured export request, decoded before the handler answers. */
export interface CollectorRequest {
	url: string;
	body: string;
	headers: Record<string, string | string[] | undefined>;
	/** The status the fake answered with, set once the handler returns. */
	status?: number;
}

export interface CollectorReply {
	status?: number;
	body?: string;
	headers?: Record<string, string>;
}

export interface FakeCollector {
	endpoint: string;
	requests: CollectorRequest[];
	close(): Promise<void>;
}

/**
 * A real loopback HTTP server standing in for an OpenTelemetry collector. No
 * mocking of `fetch`: the exporter's transport, timeout and retry paths are what
 * these tests are about.
 */
export async function startFakeCollector(
	handler: (
		req: CollectorRequest,
		index: number,
	) => CollectorReply | Promise<CollectorReply> = () => ({
		status: 200,
	}),
): Promise<FakeCollector> {
	const requests: CollectorRequest[] = [];
	const server: Server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk);
		const captured: CollectorRequest = {
			url: req.url ?? '/',
			body: Buffer.concat(chunks).toString('utf8'),
			headers: req.headers,
		};
		requests.push(captured);
		const reply = await handler(captured, requests.length - 1);
		captured.status = reply.status ?? 200;
		res.writeHead(reply.status ?? 200, {
			'content-type': 'application/json',
			...(reply.headers ?? {}),
		});
		res.end(reply.body ?? '{}');
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const addr = server.address();
	const port = typeof addr === 'object' && addr ? addr.port : 0;
	return {
		endpoint: `http://127.0.0.1:${port}`,
		requests,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

/** A complete, valid `otlp` block pointing at a test collector. */
export function otlpConfig(endpoint: string, overrides: Partial<OtlpConfig> = {}): OtlpConfig {
	return {
		...DEFAULT_CONFIG.otlp,
		enabled: true,
		endpoint,
		projects: ['*'],
		...overrides,
	};
}

export interface ExporterTestOptions {
	masterKeyManager?: MasterKeyManager;
	db?: Db;
}

export async function startExporter(
	ctx: ServerTestContext,
	config: OtlpConfig,
	opts: ExporterTestOptions = {},
): Promise<OtlpExporterHandle> {
	return createOtlpExporter({
		config,
		masterKeyManager: opts.masterKeyManager ?? ctx.masterKeyManager,
		db: opts.db ?? ctx.db,
		dataDir: ctx.dataDir,
	});
}

export interface SeededWorld {
	teamId: string;
	projectId: string;
	agentId: string;
	taskId: string;
	slug: string;
}

/** A team, one project, one agent member and one task, all scoped to this test. */
export async function seedWorld(ctx: ServerTestContext, tag: string): Promise<SeededWorld> {
	const slug = `otlp-${tag}-${Math.random().toString(36).slice(2, 8)}`;
	const team = await ctx.db.query<{ id: string }>(
		'INSERT INTO teams (name, slug) VALUES ($1, $1) RETURNING id',
		[slug],
	);
	const teamId = team.rows[0].id;
	const project = await ctx.db.query<{ id: string }>(
		`INSERT INTO projects (team_id, name, slug, task_prefix)
		 VALUES ($1, $2, $3, $4) RETURNING id`,
		[teamId, `${tag} project`, slug, slug.slice(0, 8).toUpperCase()],
	);
	const projectId = project.rows[0].id;
	const member = await ctx.db.query<{ id: string }>(
		`INSERT INTO members (team_id, member_type, display_name)
		 VALUES ($1, 'agent', $2) RETURNING id`,
		[teamId, `${tag} agent`],
	);
	const agentId = member.rows[0].id;
	await ctx.db.query(`INSERT INTO member_agents (id, title, slug) VALUES ($1, $2, $3)`, [
		agentId,
		`${tag} agent`,
		`${slug}-agent`,
	]);
	const task = await ctx.db.query<{ id: string }>(
		`INSERT INTO tasks (team_id, project_id, number, identifier, title)
		 VALUES ($1, $2, 1, $3, $4) RETURNING id`,
		[teamId, projectId, `${slug.toUpperCase()}-1`, `${tag} task`],
	);
	return { teamId, projectId, agentId, taskId: task.rows[0].id, slug };
}

export interface SeedRunOptions {
	id?: string;
	status?: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
	taskId?: string | null;
	startedAt?: string | null;
	finishedAt?: string | null;
	exitCode?: number | null;
	error?: string | null;
	inputTokens?: number;
	outputTokens?: number;
	cacheRead?: number | null;
	cacheCreation?: number | null;
	toolCallCounts?: Record<string, number> | null;
	model?: string | null;
	provider?: string | null;
	stopReason?: string | null;
	retryOfRunId?: string | null;
	/** Written into every text column the privacy negative control seeds. */
	invocationCommand?: string;
	logText?: string;
	workingDir?: string;
}

/** Insert one heartbeat run in a terminal state, returning its id. */
export async function seedRun(
	ctx: ServerTestContext,
	world: SeededWorld,
	opts: SeedRunOptions = {},
): Promise<string> {
	const inserted = await ctx.db.query<{ id: string }>(
		`INSERT INTO heartbeat_runs
		   (team_id, member_id, task_id, status, started_at, finished_at, exit_code, error,
		    input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
		    tool_call_counts, model, provider, stop_reason, retry_of_run_id,
		    invocation_command, working_dir)
		 VALUES ($1, $2, $3, $4::heartbeat_run_status, $5, $6, $7, $8,
		         $9, $10, $11, $12, $13, $14, $15::ai_provider, $16, $17,
		         $18, $19)
		 RETURNING id`,
		[
			world.teamId,
			world.agentId,
			opts.taskId === undefined ? world.taskId : opts.taskId,
			opts.status ?? 'succeeded',
			opts.startedAt === undefined ? '2026-11-20T00:00:00.000Z' : opts.startedAt,
			opts.finishedAt === undefined ? '2026-11-20T00:04:02.000Z' : opts.finishedAt,
			opts.exitCode === undefined ? 0 : opts.exitCode,
			opts.error === undefined ? null : opts.error,
			opts.inputTokens ?? 48213,
			opts.outputTokens ?? 2311,
			opts.cacheRead === undefined ? 12000 : opts.cacheRead,
			opts.cacheCreation === undefined ? 800 : opts.cacheCreation,
			opts.toolCallCounts === undefined ? { Bash: 3, Read: 2 } : opts.toolCallCounts,
			opts.model === undefined ? 'claude-sonnet-5' : opts.model,
			opts.provider === undefined ? 'anthropic' : opts.provider,
			opts.stopReason === undefined ? null : opts.stopReason,
			opts.retryOfRunId === undefined ? null : opts.retryOfRunId,
			opts.invocationCommand ?? 'hezo-agent --secret-command',
			opts.workingDir ?? '/home/agent/work',
		],
	);
	const id = inserted.rows[0].id;
	if (opts.logText !== undefined) {
		await ctx.db.query(
			'INSERT INTO heartbeat_run_log_chunks (run_id, seq, content) VALUES ($1, 0, $2)',
			[id, opts.logText],
		);
	}
	return id;
}

/** Wait until `predicate` holds, polling briefly. Fails rather than hanging. */
export async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	timeoutMs = 5000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`condition not met within ${timeoutMs}ms`);
}
