#!/usr/bin/env bun
/**
 * cost-probe — does a real agent run return its dollar cost in the output?
 *
 * For each selected AI provider, this drives Hezo's *real* Docker run path: it
 * spins up the production `hezo/agent-base` container, `docker exec`s the actual
 * runtime CLI (claude/codex/gemini/…) against the provider's real endpoint with a
 * real API key — assembled from the same `@hezo/shared` adapter maps the runner
 * uses — sends a trivial prompt, captures the JSONL, and reports whether the run
 * output carried a usable cost (vs. tokens we'd have to price from the table).
 *
 * Keys are read from `HEZO_PROBE_KEY_<PROVIDER>` env vars (never committed):
 *   export HEZO_PROBE_KEY_DEEPSEEK=sk-…   # then:
 *   bun run cost-probe --provider deepseek --build
 *
 * Provider traffic goes direct (no egress proxy/CA/DB needed); the only
 * prerequisites are Docker and the agent-base image (`--build` builds it).
 */
import { randomBytes } from 'node:crypto';
import { type AiProvider, ALL_AI_PROVIDERS } from '@hezo/shared';
import { Command } from 'commander';
import {
	buildProbeInvocation,
	extractReportedCost,
	type ProbeVerdict,
	probeKeyEnv,
	probeVerdict,
	wrapProbeExecCmd,
} from '../packages/server/src/services/cost-probe';
import { DockerClient } from '../packages/server/src/services/docker';
import { ensureImage } from '../packages/server/src/services/ensure-image';
import { MANAGED_AGENT_BASE_IMAGE } from '../packages/server/src/services/image-registry';

const program = new Command()
	.name('cost-probe')
	.description('Probe whether each AI provider returns cost in its agent-run output')
	.option('--provider <name...>', 'Provider slug(s) to probe (e.g. deepseek openai)')
	.option('--all', 'Probe every provider that has a HEZO_PROBE_KEY_<PROVIDER> env var set')
	.option('--model <model>', 'Override the probe model (applies to all selected providers)')
	.option('--prompt <text>', 'Override the probe prompt')
	.option('--build', 'Build the agent-base image if it is missing (else fail fast)')
	.option('--keep', 'Leave the probe container running for debugging (no auto-remove)')
	.option('--json', 'Emit machine-readable JSON instead of the formatted report')
	.parse();

const opts = program.opts<{
	provider?: string[];
	all?: boolean;
	model?: string;
	prompt?: string;
	build?: boolean;
	keep?: boolean;
	json?: boolean;
}>();

function fail(msg: string): never {
	console.error(`cost-probe: ${msg}`);
	process.exit(1);
}

/** Resolve the provider slugs to probe, validating against the known set. */
function resolveProviders(): AiProvider[] {
	if (opts.all) return [...ALL_AI_PROVIDERS];
	if (!opts.provider || opts.provider.length === 0) {
		fail(`pass --provider <slug...> or --all. Known: ${ALL_AI_PROVIDERS.join(', ')}`);
	}
	const out: AiProvider[] = [];
	for (const name of opts.provider) {
		const match = ALL_AI_PROVIDERS.find((p) => p === name);
		if (!match) fail(`unknown provider "${name}". Known: ${ALL_AI_PROVIDERS.join(', ')}`);
		out.push(match);
	}
	return out;
}

interface ProbeOutcome {
	provider: AiProvider;
	runtime: string;
	model: string;
	verdict: ProbeVerdict;
	exitCode: number;
	reportedCostUsd: number | null;
	inputTokens: number;
	outputTokens: number;
	costEvent: Record<string, unknown> | null;
	lastEvent: Record<string, unknown> | null;
	stderrTail: string;
}

async function probeProvider(docker: DockerClient, provider: AiProvider): Promise<ProbeOutcome> {
	const apiKey = process.env[probeKeyEnv(provider)];
	if (!apiKey) throw new Error('missing key'); // guarded by caller
	const inv = buildProbeInvocation(provider, {
		apiKey,
		model: opts.model,
		prompt: opts.prompt,
	});
	const name = `hezo-cost-probe-${randomBytes(4).toString('hex')}`;
	let id: string | null = null;
	try {
		({ Id: id } = await docker.createContainer(name, {
			Image: MANAGED_AGENT_BASE_IMAGE,
			Cmd: ['sleep', 'infinity'],
			Labels: { 'ai.hezo.role': 'cost-probe' },
			HostConfig: { ExtraHosts: ['host.docker.internal:host-gateway'] },
		}));
		await docker.startContainer(id);
		const execId = await docker.execCreate(id, {
			Cmd: wrapProbeExecCmd(inv.cmd, inv.promptMode),
			Env: inv.env,
			WorkingDir: '/workspace',
			User: 'node',
			AttachStdout: true,
			AttachStderr: true,
		});
		const { stdout, stderr } = await docker.execStart(execId);
		const { ExitCode } = await docker.execInspect(execId);
		const cost = extractReportedCost(inv.runtime, stdout);
		const stderrTail = stderr.trim().split('\n').slice(-4).join('\n');
		return {
			provider,
			runtime: inv.runtime,
			model: inv.model || '(runtime default)',
			verdict: probeVerdict(cost, ExitCode),
			exitCode: ExitCode,
			reportedCostUsd: cost.reportedCostUsd,
			inputTokens: cost.inputTokens,
			outputTokens: cost.outputTokens,
			costEvent: cost.costEvent,
			lastEvent: cost.lastEvent,
			stderrTail,
		};
	} finally {
		if (id && !opts.keep) await docker.removeContainer(id, true).catch(() => {});
	}
}

const VERDICT_LABEL: Record<ProbeVerdict, string> = {
	'cost-emitted': 'COST EMITTED',
	'tokens-only': 'TOKENS ONLY',
	'no-output': 'NO USABLE OUTPUT',
};

function printOutcome(o: ProbeOutcome): void {
	console.log(`\n── ${o.provider} (${o.runtime}, model=${o.model}) ──`);
	const detail =
		o.verdict === 'cost-emitted'
			? `$${o.reportedCostUsd?.toFixed(6)} reported`
			: o.verdict === 'tokens-only'
				? `tokens ${o.inputTokens}/${o.outputTokens}, no cost field`
				: `exit ${o.exitCode}`;
	console.log(`  verdict: ${VERDICT_LABEL[o.verdict]} — ${detail}`);
	console.log(`  tokens : in=${o.inputTokens} out=${o.outputTokens}`);
	const shown = o.costEvent ?? o.lastEvent;
	if (shown) {
		const json = JSON.stringify(shown);
		console.log(`  event  : ${json.length > 600 ? `${json.slice(0, 600)}…` : json}`);
	}
	if (o.verdict === 'no-output' && o.stderrTail) {
		console.log(`  stderr : ${o.stderrTail.replace(/\n/g, '\n           ')}`);
	}
}

async function main(): Promise<void> {
	const providers = resolveProviders();

	// Partition by whether a key is present so --all silently skips the rest.
	const withKey = providers.filter((p) => process.env[probeKeyEnv(p)]);
	const skipped = providers.filter((p) => !process.env[probeKeyEnv(p)]);
	if (withKey.length === 0) {
		fail(`no API keys found. Set ${providers.map((p) => probeKeyEnv(p)).join(' / ')} and re-run.`);
	}

	const docker = new DockerClient();
	if (!(await docker.ping())) fail('cannot reach the Docker daemon (is Docker running?).');

	if (!(await docker.imageExists(MANAGED_AGENT_BASE_IMAGE))) {
		if (!opts.build) {
			fail(
				`image ${MANAGED_AGENT_BASE_IMAGE} not found. Re-run with --build, or build it:\n` +
					`  docker build -t ${MANAGED_AGENT_BASE_IMAGE} -f docker/Dockerfile.agent-base docker`,
			);
		}
		console.log(`Building ${MANAGED_AGENT_BASE_IMAGE} (first run can take a few minutes)…`);
		await ensureImage(docker, MANAGED_AGENT_BASE_IMAGE, {
			onLine: (_stream, text) => process.stdout.write(text),
		});
	}

	if (skipped.length > 0 && !opts.json) {
		console.log(`Skipping (no key): ${skipped.join(', ')}`);
	}

	const outcomes: ProbeOutcome[] = [];
	for (const provider of withKey) {
		if (!opts.json) console.log(`\nProbing ${provider}…`);
		try {
			outcomes.push(await probeProvider(docker, provider));
		} catch (err) {
			console.error(`  ${provider}: probe errored — ${(err as Error).message}`);
		}
	}

	if (opts.json) {
		console.log(
			JSON.stringify(
				outcomes.map(({ costEvent: _c, lastEvent: _l, stderrTail: _s, ...rest }) => rest),
				null,
				2,
			),
		);
		return;
	}

	for (const o of outcomes) printOutcome(o);

	console.log('\n── summary ──');
	for (const o of outcomes) {
		console.log(`  ${o.provider.padEnd(11)} ${VERDICT_LABEL[o.verdict]}`);
	}
	const emitted = outcomes.filter((o) => o.verdict === 'cost-emitted').map((o) => o.provider);
	console.log(
		emitted.length > 0
			? `\nReturn cost in run output: ${emitted.join(', ')} — prefer it over the pricing table.`
			: '\nNo probed provider returned cost in run output — the pricing table is the source of truth.',
	);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
