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
	.option(
		'--anthropic-base-url <url>',
		'Validate via Claude Code against an Anthropic-compatible endpoint (use with --model), e.g. Kimi at https://api.moonshot.ai/anthropic',
	)
	.option('--build', 'Build the agent-base image if it is missing (else fail fast)')
	.option('--rebuild', 'Remove and rebuild the agent-base image (replaces a stale one)')
	.option('--keep', 'Leave the probe container running for debugging (no auto-remove)')
	.option('--timeout <seconds>', 'Abort a run that hangs past this many seconds', '120')
	.option('--raw', 'Dump the full captured stdout/stderr (to inspect a runtime’s event shapes)')
	.option('--json', 'Emit machine-readable JSON instead of the formatted report')
	.parse();

const opts = program.opts<{
	provider?: string[];
	all?: boolean;
	model?: string;
	prompt?: string;
	anthropicBaseUrl?: string;
	build?: boolean;
	rebuild?: boolean;
	keep?: boolean;
	timeout?: string;
	raw?: boolean;
	json?: boolean;
}>();

const timeoutMs = Math.max(1, Number.parseInt(opts.timeout ?? '120', 10) || 120) * 1000;

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
	timedOut: boolean;
	reportedCostUsd: number | null;
	tableCostUsd: number | null;
	reportedVsTableRatio: number | null;
	modelId: string | null;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	costEvent: Record<string, unknown> | null;
	lastEvent: Record<string, unknown> | null;
	stderrTail: string;
	rawStdout: string;
	rawStderr: string;
}

async function probeProvider(docker: DockerClient, provider: AiProvider): Promise<ProbeOutcome> {
	const apiKey = process.env[probeKeyEnv(provider)];
	if (!apiKey) throw new Error('missing key'); // guarded by caller
	const inv = buildProbeInvocation(provider, {
		apiKey,
		model: opts.model,
		prompt: opts.prompt,
		anthropicBaseUrl: opts.anthropicBaseUrl,
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
			Cmd: wrapProbeExecCmd(inv.cmd, inv.promptMode, inv.setup),
			Env: inv.env,
			WorkingDir: '/workspace',
			User: 'node',
			AttachStdout: true,
			AttachStderr: true,
		});

		// Accumulate output via onChunk so a hung run that we abort on timeout still
		// yields whatever it emitted (e.g. an error/usage event), and abort the exec
		// stream when the deadline passes so the probe never hangs.
		let stdout = '';
		let stderr = '';
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), timeoutMs);
		let timedOut = false;
		let exitCode = -1;
		try {
			await docker.execStart(execId, {
				signal: ctrl.signal,
				onChunk: (c) => {
					if (c.stream === 'stdout') stdout += c.text;
					else stderr += c.text;
				},
			});
			exitCode = (await docker.execInspect(execId)).ExitCode;
		} catch (err) {
			if (ctrl.signal.aborted) timedOut = true;
			else throw err;
		} finally {
			clearTimeout(timer);
		}

		const cost = extractReportedCost(inv.runtime, stdout);
		const stderrTail = stderr.trim().split('\n').slice(-4).join('\n');
		return {
			provider,
			runtime: inv.runtime,
			model: inv.model || '(runtime default)',
			verdict: probeVerdict(cost, timedOut ? -1 : exitCode),
			exitCode,
			timedOut,
			reportedCostUsd: cost.reportedCostUsd,
			tableCostUsd: cost.tableCostUsd,
			reportedVsTableRatio: cost.reportedVsTableRatio,
			modelId: cost.modelId,
			inputTokens: cost.inputTokens,
			outputTokens: cost.outputTokens,
			cacheReadTokens: cost.cacheReadTokens,
			cacheCreationTokens: cost.cacheCreationTokens,
			costEvent: cost.costEvent,
			lastEvent: cost.lastEvent,
			stderrTail,
			rawStdout: stdout,
			rawStderr: stderr,
		};
	} finally {
		if (id && !opts.keep) await docker.removeContainer(id, true).catch(() => {});
	}
}

const VERDICT_LABEL: Record<ProbeVerdict, string> = {
	'cost-emitted': 'COST EMITTED',
	'tokens-only': 'TOKENS ONLY',
	'no-usage': 'NO COST/USAGE',
	'no-output': 'NO USABLE OUTPUT',
};

function printOutcome(o: ProbeOutcome): void {
	console.log(`\n── ${o.provider} (${o.runtime}, model=${o.model}) ──`);
	const detail =
		o.verdict === 'cost-emitted'
			? `$${o.reportedCostUsd?.toFixed(6)} reported`
			: o.verdict === 'tokens-only'
				? `tokens ${o.inputTokens}/${o.outputTokens}, no cost field`
				: o.verdict === 'no-usage'
					? 'ran, but reported no cost or token usage'
					: o.timedOut
						? `timed out after ${timeoutMs / 1000}s`
						: `exit ${o.exitCode}`;
	console.log(`  verdict: ${VERDICT_LABEL[o.verdict]} — ${detail}`);
	console.log(
		`  tokens : in=${o.inputTokens} out=${o.outputTokens} cache=${o.cacheReadTokens}/${o.cacheCreationTokens}`,
	);
	if (o.tableCostUsd !== null) {
		const ratio =
			o.reportedVsTableRatio !== null
				? ` — reported is ${o.reportedVsTableRatio.toFixed(1)}x the table`
				: '';
		console.log(
			`  table  : $${o.tableCostUsd.toFixed(6)} (${o.modelId ?? 'unknown model'})${ratio}`,
		);
		if (
			o.reportedVsTableRatio !== null &&
			(o.reportedVsTableRatio > 2 || o.reportedVsTableRatio < 0.5)
		) {
			console.log(
				'           ⚠ large divergence: the runtime priced this run with the wrong rate card,',
			);
			console.log(
				'           or the table entry is stale — verify against the provider pricing page.',
			);
		}
	} else if (o.modelId) {
		console.log(
			`  table  : no rate for "${o.modelId}" — a real run would record $0 (add a curated/manual rate)`,
		);
	}
	const shown = o.costEvent ?? o.lastEvent;
	if (shown) {
		const json = JSON.stringify(shown);
		console.log(`  event  : ${json.length > 600 ? `${json.slice(0, 600)}…` : json}`);
	}
	if (o.verdict === 'no-output' && o.stderrTail) {
		console.log(`  stderr : ${o.stderrTail.replace(/\n/g, '\n           ')}`);
	}
	if (opts.raw) {
		console.log(
			`  ┌─ raw stdout ─\n${o.rawStdout || '(empty)'}\n  ├─ raw stderr ─\n${o.rawStderr || '(empty)'}\n  └─`,
		);
	}
}

async function main(): Promise<void> {
	if (opts.anthropicBaseUrl && !opts.model) {
		fail('--anthropic-base-url requires --model (the endpoint has no default model).');
	}
	const providers = resolveProviders();

	// Partition by whether a key is present so --all silently skips the rest.
	const withKey = providers.filter((p) => process.env[probeKeyEnv(p)]);
	const skipped = providers.filter((p) => !process.env[probeKeyEnv(p)]);
	if (withKey.length === 0) {
		fail(`no API keys found. Set ${providers.map((p) => probeKeyEnv(p)).join(' / ')} and re-run.`);
	}

	const docker = new DockerClient();
	if (!(await docker.ping())) fail('cannot reach the Docker daemon (is Docker running?).');

	// --rebuild forces a fresh build, replacing a stale image (e.g. one built
	// before a runtime CLI was added to the Dockerfile).
	if (opts.rebuild) {
		console.log(`Removing ${MANAGED_AGENT_BASE_IMAGE} to force a rebuild…`);
		await docker.removeImage(MANAGED_AGENT_BASE_IMAGE, true).catch(() => {});
	}

	if (!(await docker.imageExists(MANAGED_AGENT_BASE_IMAGE))) {
		if (!opts.build && !opts.rebuild) {
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
				outcomes.map(
					({
						costEvent: _c,
						lastEvent: _l,
						stderrTail: _s,
						rawStdout: _ro,
						rawStderr: _re,
						...rest
					}) => rest,
				),
				null,
				2,
			),
		);
		return;
	}

	for (const o of outcomes) printOutcome(o);

	console.log('\n── summary ──');
	for (const o of outcomes) {
		const ratio =
			o.reportedVsTableRatio !== null
				? ` (reported ${o.reportedVsTableRatio.toFixed(1)}x table)`
				: '';
		console.log(`  ${o.provider.padEnd(11)} ${VERDICT_LABEL[o.verdict]}${ratio}`);
	}
	console.log(
		'\nRun cost is always recorded from the pricing table; a runtime-reported figure is a\n' +
			'client-side estimate and is ignored. A reported-vs-table ratio far from 1 usually means\n' +
			'the runtime priced the run with the wrong rate card (expected for third-party\n' +
			'Anthropic-compatible endpoints) — but if the runtime was pricing its own provider, check\n' +
			'the table entry against the official pricing page and add a curated rate if stale.',
	);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
