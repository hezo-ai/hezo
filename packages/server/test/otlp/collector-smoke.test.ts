import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OtlpExporterHandle } from '../../src/services/otlp/exporter';
import { createTestContext, destroyTestContext, type ServerTestContext } from '../helpers/context';
import { otlpConfig, seedWorld, startExporter } from './helpers';

/**
 * The one test that proves a real OTLP receiver accepts the payload. It needs
 * Docker and the collector image, so it is opt-in: `HEZO_OTLP_SMOKE=1`.
 */
const dockerAvailable =
	process.env.HEZO_OTLP_SMOKE === '1' &&
	spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;

const CONFIG_YAML = `receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
exporters:
  debug:
    verbosity: detailed
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [debug]
    metrics:
      receivers: [otlp]
      exporters: [debug]
`;

function run(command: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args);
		let out = '';
		child.stdout.on('data', (chunk: Buffer) => {
			out += chunk.toString('utf8');
		});
		child.stderr.on('data', (chunk: Buffer) => {
			out += chunk.toString('utf8');
		});
		child.on('error', reject);
		child.on('close', (code) =>
			code === 0 ? resolve(out) : reject(new Error(`${command} exited ${code}: ${out}`)),
		);
	});
}

describe.skipIf(!dockerAvailable)('OTLP collector smoke', () => {
	const name = `hezo-otlp-smoke-${Math.random().toString(36).slice(2, 10)}`;
	let dir = '';
	let endpoint = '';
	let ctx: ServerTestContext;
	let exporter: OtlpExporterHandle | null = null;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), 'hezo-otlp-smoke-'));
		const configPath = join(dir, 'config.yaml');
		writeFileSync(configPath, CONFIG_YAML);
		await run('docker', [
			'run',
			'-d',
			'--rm',
			'--name',
			name,
			'-p',
			'127.0.0.1:0:4318',
			'-v',
			`${configPath}:/etc/otelcol-contrib/config.yaml:ro`,
			'otel/opentelemetry-collector-contrib:latest',
			'--config=/etc/otelcol-contrib/config.yaml',
		]);
		const portOut = await run('docker', ['port', `${name}`, '4318/tcp']);
		const port = Number(portOut.trim().split(':').pop());
		endpoint = `http://127.0.0.1:${port}`;

		// The collector prints this once its pipelines are running.
		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline) {
			const logs = await run('docker', ['logs', name]);
			if (logs.includes('Everything is ready')) break;
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		ctx = await createTestContext();
	}, 120_000);

	afterAll(async () => {
		await exporter?.stop();
		if (dir) rmSync(dir, { recursive: true, force: true });
		if (ctx) await destroyTestContext(ctx);
		if (dockerAvailable) await run('docker', ['rm', '-f', name]).catch(() => {});
	});

	it('is accepted by a real collector and printed by the detailed debug exporter', async () => {
		const world = await seedWorld(ctx, 'smoke');
		const runId = crypto.randomUUID();
		exporter = await startExporter(ctx, otlpConfig(endpoint));
		exporter.emitRunFinished({
			runId,
			teamId: world.teamId,
			projectId: world.projectId,
			agentMemberId: world.agentId,
			taskId: world.taskId,
			status: 'succeeded',
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
		});
		await exporter.flush(5000);

		const traceId = runId.replaceAll('-', '');
		const deadline = Date.now() + 15_000;
		let logs = '';
		while (Date.now() < deadline) {
			logs = await run('docker', ['logs', name]);
			if (logs.includes(traceId)) break;
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		expect(logs).toContain('hezo.agent_run');
		expect(logs).toContain('hezo.runs.completed');
		expect(logs).toContain(traceId);
	}, 60_000);
});
