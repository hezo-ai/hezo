/**
 * Cost-source probe — pure core.
 *
 * Answers one empirical question per AI provider: **does a real agent run return
 * a usable dollar cost in its output, or must we compute it from the pricing
 * table?** This matters because providers like DeepSeek run *through* the Claude
 * Code runtime against a third-party Anthropic-compatible endpoint, where the CLI
 * may not be able to price the model — so whether `total_cost_usd` comes back is
 * a fact to measure, not assume.
 *
 * This module holds the pure, Docker-free pieces (so they're unit-testable):
 * assembling the faithful runtime invocation for a provider, and extracting the
 * runtime-reported cost + token usage from captured stdout. The Docker
 * orchestration lives in `scripts/cost-probe.ts`, which imports these.
 *
 * The invocation mirrors `buildRuntimeInvocation` (agent-runner.ts) — same env
 * (`buildProviderEnv`) and the same CLI-arg assembly from the shared `RUNTIME_*`
 * maps — minus the MCP/effort/egress wiring, none of which affects whether a
 * runtime reports a cost. Keep it in lockstep with those maps as providers are
 * added (see AGENTS.md › Provider cost-source probe).
 */
import {
	AgentRuntime,
	AiAuthMethod,
	type AiProvider,
	CLAUDE_CODE_QUIET_ENV,
	claudeCodeModelArg,
	opencodeModelArg,
	PROVIDER_TO_RUNTIME,
	RUNTIME_AUTO_APPROVE_ARGS,
	RUNTIME_COMMANDS,
	RUNTIME_DISALLOWED_TOOLS_ARGS,
	RUNTIME_HEADLESS_PREFIX_ARGS,
	RUNTIME_HEADLESS_SUFFIX_ARGS,
	RUNTIME_PROMPT_DELIVERY,
	RUNTIME_STREAM_ARGS,
} from '@hezo/shared';
import { buildProviderEnv } from './agent-runner';
import { createAgentStreamParser, findReportedCostUsd } from './agent-stream-parser';

/** The env var a probe reads a provider's API key from, e.g. `HEZO_PROBE_KEY_DEEPSEEK`. */
export function probeKeyEnv(provider: AiProvider): string {
	return `HEZO_PROBE_KEY_${provider.toUpperCase()}`;
}

/**
 * A cheap model per provider so a probe run is near-free; `--model` overrides.
 * Best-effort and **maintained** — update this (and `probeKeyEnv` coverage) when
 * a provider is added or its cheap model changes (see AGENTS.md). A provider with
 * no entry falls back to the runtime/provider default model.
 */
export const PROBE_DEFAULT_MODELS: Partial<Record<AiProvider, string>> = {
	anthropic: 'claude-haiku-4-5',
	deepseek: 'deepseek-v4-flash',
	z_ai: 'GLM-4.5-Air',
	openai: 'gpt-4o-mini',
	google: 'gemini-2.5-flash',
	openrouter: 'openai/gpt-4o-mini',
	// Kimi runs through Claude Code against Moonshot's Anthropic-compatible
	// endpoint (like DeepSeek/Z.ai), so it takes the model as a normal --model arg.
	kimi: 'kimi-k2.7-code',
};

/** A trivial, deterministic prompt that elicits a one-token reply. */
export const DEFAULT_PROBE_PROMPT = 'Reply with exactly the word: ok';

export interface ProbeInvocation {
	provider: AiProvider;
	runtime: AgentRuntime;
	/** The model the probe will run (empty when the runtime/provider default is used). */
	model: string;
	/** The runtime CLI argv (no prompt-delivery wrapper). */
	cmd: string[];
	/** `KEY=VALUE` env entries: the provider env a real run gets, plus `PROMPT`. */
	env: string[];
	/** How the prompt reaches the CLI — stdin pipe or trailing arg. */
	promptMode: 'stdin' | 'arg';
	/**
	 * Shell commands run inside the container before the CLI, to stage any
	 * credential/config files a runtime needs beyond env vars (e.g. Codex's
	 * `$CODEX_HOME/auth.json`). Empty for runtimes that authenticate from env.
	 */
	setup: string[];
}

export interface BuildProbeInvocationOpts {
	apiKey: string;
	model?: string;
	prompt?: string;
	/**
	 * Validation override: ignore the provider's normal runtime and instead drive
	 * the **Claude Code** runtime against this Anthropic-compatible base URL (the
	 * DeepSeek/Z.ai pattern). Used to check whether a third-party endpoint returns
	 * `total_cost_usd` through Claude Code — e.g. Kimi via `api.moonshot.ai/anthropic`
	 * — without changing the production adapter. Requires `model`.
	 */
	anthropicBaseUrl?: string;
}

/**
 * Build the exact env + argv a one-shot probe run uses for `provider`, mirroring
 * the production run path's assembly (agent-runner.ts `buildRuntimeInvocation`,
 * ~lines 476-499) minus MCP/effort/egress.
 */
export function buildProbeInvocation(
	provider: AiProvider,
	opts: BuildProbeInvocationOpts,
): ProbeInvocation {
	const prompt = opts.prompt ?? DEFAULT_PROBE_PROMPT;
	if (opts.anthropicBaseUrl) {
		return buildClaudeCodeEndpointProbe(
			provider,
			opts.apiKey,
			opts.anthropicBaseUrl,
			opts.model ?? '',
			prompt,
		);
	}
	const runtime = PROVIDER_TO_RUNTIME[provider];
	const model = opts.model ?? PROBE_DEFAULT_MODELS[provider] ?? '';

	// Most runtimes authenticate from env alone. Codex is the exception: `codex exec`
	// reads its credential from `$CODEX_HOME/auth.json`, and a bare `OPENAI_API_KEY`
	// env run falls back to ChatGPT mode (401 on /v1/responses). Stage the key the
	// canonical `codex login --api-key` way. (The auth method doesn't change whether
	// the run output carries a cost — which is all the probe measures.)
	const extraEnv: string[] = [];
	const setup: string[] = [];
	if (runtime === AgentRuntime.Codex) {
		// Under the agent-base run-user's home, not /tmp: Codex refuses to create its
		// helper binaries under a temporary dir ("Refusing to create helper binaries
		// under temporary dir"). `/home/node` is the node user's writable home in the
		// node:24-slim agent-base image (the probe execs as `node`).
		const codexHome = '/home/node/.codex';
		extraEnv.push(
			`CODEX_HOME=${codexHome}`,
			`CODEX_AUTH_JSON=${JSON.stringify({ OPENAI_API_KEY: opts.apiKey })}`,
		);
		setup.push('mkdir -p "$CODEX_HOME"', 'printf %s "$CODEX_AUTH_JSON" > "$CODEX_HOME/auth.json"');
	}

	// Provider env: base URL + model defaults + credential env — exactly what a
	// real run receives (api-key auth; the probe always uses a pasted key).
	const env = [
		...buildProviderEnv(provider, { value: opts.apiKey, authMethod: AiAuthMethod.ApiKey }),
		...extraEnv,
		`PROMPT=${prompt}`,
	];

	let cliModel = model;
	if (model) {
		if (runtime === AgentRuntime.ClaudeCode) cliModel = claudeCodeModelArg(provider, model);
		else if (runtime === AgentRuntime.OpenCode) cliModel = opencodeModelArg(provider, model);
	}
	const modelArgs = cliModel ? ['--model', cliModel] : [];

	const cmd = [
		RUNTIME_COMMANDS[runtime],
		...RUNTIME_HEADLESS_PREFIX_ARGS[runtime],
		...RUNTIME_STREAM_ARGS[runtime],
		...RUNTIME_AUTO_APPROVE_ARGS[runtime],
		...RUNTIME_DISALLOWED_TOOLS_ARGS[runtime],
		...modelArgs,
		...RUNTIME_HEADLESS_SUFFIX_ARGS[runtime],
	];

	return {
		provider,
		runtime,
		model,
		cmd,
		env,
		promptMode: RUNTIME_PROMPT_DELIVERY[runtime],
		setup,
	};
}

/**
 * Validation override (see `BuildProbeInvocationOpts.anthropicBaseUrl`): build a
 * Claude Code invocation pointed at an arbitrary Anthropic-compatible endpoint,
 * using `provider`'s probe key. Same shape DeepSeek/Z.ai use, so it surfaces
 * `total_cost_usd` if the endpoint returns one.
 */
function buildClaudeCodeEndpointProbe(
	provider: AiProvider,
	apiKey: string,
	baseUrl: string,
	model: string,
	prompt: string,
): ProbeInvocation {
	const runtime = AgentRuntime.ClaudeCode;
	const env = [
		...Object.entries(CLAUDE_CODE_QUIET_ENV).map(([k, v]) => `${k}=${v}`),
		`ANTHROPIC_BASE_URL=${baseUrl}`,
		...(model
			? [
					`ANTHROPIC_DEFAULT_OPUS_MODEL=${model}`,
					`ANTHROPIC_DEFAULT_SONNET_MODEL=${model}`,
					`ANTHROPIC_DEFAULT_HAIKU_MODEL=${model}`,
					`CLAUDE_CODE_SUBAGENT_MODEL=${model}`,
				]
			: []),
		`ANTHROPIC_AUTH_TOKEN=${apiKey}`,
		`PROMPT=${prompt}`,
	];
	const cmd = [
		RUNTIME_COMMANDS[runtime],
		...RUNTIME_HEADLESS_PREFIX_ARGS[runtime],
		...RUNTIME_STREAM_ARGS[runtime],
		...RUNTIME_AUTO_APPROVE_ARGS[runtime],
		...RUNTIME_DISALLOWED_TOOLS_ARGS[runtime],
		...(model ? ['--model', model] : []),
		...RUNTIME_HEADLESS_SUFFIX_ARGS[runtime],
	];
	return {
		provider,
		runtime,
		model,
		cmd,
		env,
		promptMode: RUNTIME_PROMPT_DELIVERY[runtime],
		setup: [],
	};
}

/**
 * The shell wrapper that delivers `$PROMPT` to the CLI the way the runtime
 * expects — piped on stdin, or appended as the trailing arg — matching
 * `RUNTIME_PROMPT_DELIVERY`. Returns the full `docker exec` argv given the CLI
 * argv. (Production reads the prompt from a mounted file; the probe sources it
 * from the `PROMPT` env var instead, which is irrelevant to cost reporting.)
 */
export function wrapProbeExecCmd(
	cmd: string[],
	promptMode: 'stdin' | 'arg',
	setup: string[] = [],
): string[] {
	const promptClause = promptMode === 'arg' ? 'exec "$@" "$PROMPT"' : 'printf %s "$PROMPT" | "$@"';
	const script = [...setup, promptClause].join('\n');
	return ['sh', '-c', script, 'sh', ...cmd];
}

export interface ProbeCostResult {
	/**
	 * The runtime's own reported run cost in USD, scanned from the raw stdout
	 * independent of any pricing table, or `null` when the run output carried no
	 * cost field. This is the probe's headline answer.
	 */
	reportedCostUsd: number | null;
	inputTokens: number;
	outputTokens: number;
	/** The parsed event that carried the cost, for display; `null` if none. */
	costEvent: Record<string, unknown> | null;
	/** The last parsed JSON event seen, for context when no cost was reported. */
	lastEvent: Record<string, unknown> | null;
}

/**
 * Extract the runtime-reported cost + token usage from a run's captured stdout.
 * Tokens come from the real `agent-stream-parser` (authoritative per runtime);
 * the reported cost is scanned from the raw JSONL with the same
 * `findReportedCostUsd` the parsers use, so the probe and the run path agree on
 * what counts as "a reported cost".
 */
export function extractReportedCost(runtime: AgentRuntime, stdout: string): ProbeCostResult {
	const parser = createAgentStreamParser(runtime);
	parser.onStdout(stdout);
	parser.flush();
	const usage = parser.getUsage();

	let reportedCostUsd: number | null = null;
	let costEvent: Record<string, unknown> | null = null;
	let lastEvent: Record<string, unknown> | null = null;
	for (const line of stdout.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let event: unknown;
		try {
			event = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (event && typeof event === 'object' && !Array.isArray(event)) {
			lastEvent = event as Record<string, unknown>;
		}
		const cost = findReportedCostUsd(event);
		if (cost !== null) {
			reportedCostUsd = cost;
			if (lastEvent) costEvent = lastEvent;
		}
	}

	return {
		reportedCostUsd,
		inputTokens: usage?.inputTokens ?? 0,
		outputTokens: usage?.outputTokens ?? 0,
		costEvent,
		lastEvent,
	};
}

export type ProbeVerdict = 'cost-emitted' | 'tokens-only' | 'no-usage' | 'no-output';

/** Classify a probe run for the summary line. */
export function probeVerdict(result: ProbeCostResult, exitCode: number): ProbeVerdict {
	if (result.reportedCostUsd !== null) return 'cost-emitted';
	if (result.inputTokens > 0 || result.outputTokens > 0) return 'tokens-only';
	// Ran cleanly and produced output, but emitted no cost and no token usage —
	// such a run can't be priced from output or the table.
	if (exitCode === 0 && result.lastEvent) return 'no-usage';
	return 'no-output';
}
