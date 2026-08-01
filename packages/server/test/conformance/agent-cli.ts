/**
 * A real coding-CLI run, inside a real container, against a real model provider.
 *
 * The engine and files suites prove a backend can create a sandbox, exec in it
 * and move bytes. None of that answers the question an operator actually has:
 * *can an agent run there*. That depends on things only the live combination
 * exercises - the image really carries the CLI, the sandbox can reach the
 * provider's endpoint, the exec transport carries a long-lived streaming
 * stdout without truncating or reordering it, the prompt arrives on the channel
 * the runtime expects, and the CLI reports token usage the pricing table can
 * charge against. A fake provider answers none of them, which is why this suite
 * is opt-in on a real key rather than part of the default run.
 *
 * **The invocation is assembled from the production tables**
 * (`PROVIDER_RUNTIME_ADAPTERS`, `RUNTIME_COMMANDS`, and the arg tables in
 * `@hezo/shared`), never hand-written here. A suite that spelled out its own
 * flags would keep passing after the runner changed how it invokes the CLI,
 * which is the one failure it exists to catch. It also means a second provider
 * is a fixture field rather than a second suite - the same rule the rest of
 * `test/conformance/` follows.
 *
 * Cost: one short completion per run, on whatever model the fixture pins (pick
 * the provider's cheapest). It is opt-in for the same reason the Daytona suites
 * are - see `test/live/`.
 */

import {
	AgentRuntime,
	AiAuthMethod,
	PROVIDER_RUNTIME_ADAPTERS,
	RUNTIME_AUTO_APPROVE_ARGS,
	RUNTIME_COMMANDS,
	RUNTIME_DISALLOWED_TOOLS_ARGS,
	RUNTIME_HEADLESS_PREFIX_ARGS,
	RUNTIME_HEADLESS_SUFFIX_ARGS,
	RUNTIME_PROMPT_DELIVERY,
	RUNTIME_STREAM_ARGS,
} from '@hezo/shared';
import type { ContainerEngine, ExecLogChunk } from '../../src/services/sandbox/types';
import {
	CONFORMANCE_LABEL,
	type ConformanceHarness,
	conformanceRunId,
	type LiveAdapterFixture,
	type LiveModelProvider,
	sweepConformanceContainers,
} from './fixture';

/**
 * The word the prompt asks for back. Distinctive enough that finding it in the
 * transcript cannot be a coincidence, and short enough that a small model
 * reproduces it exactly.
 */
const SENTINEL = 'HEZO-LIVE-OK';
const PROMPT = `Reply with exactly ${SENTINEL} and nothing else. Do not use any tools.`;
/** Where the prompt file lands, mirroring the runner's own per-run prompt file. */
const PROMPT_FILE = 'live-cli-prompt.txt';

/**
 * Single-quote for `sh -c`, the same way the runner's exec wrapper has to.
 * Nothing here is attacker-controlled, but a path with a space would silently
 * split into two arguments and the failure would read as "the CLI is missing".
 */
function shellQuote(arg: string): string {
	return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/**
 * Environment for the run, built the way `buildProviderEnv` builds it: the
 * adapter's `staticEnv` (which is where an Anthropic-compatible provider's
 * `ANTHROPIC_BASE_URL` and model defaults live), then the credential under the
 * variable that provider's auth method names.
 */
function providerEnv(mp: LiveModelProvider): string[] {
	const adapter = PROVIDER_RUNTIME_ADAPTERS[mp.provider];
	const env = Object.entries(adapter.staticEnv ?? {}).map(([k, v]) => `${k}=${v}`);
	const varName = adapter.credentialEnvByAuthMethod[AiAuthMethod.ApiKey];
	if (!varName) throw new Error(`${mp.provider} has no api-key credential variable`);
	env.push(`${varName}=${mp.apiKey}`);
	// Claude Code prefers ANTHROPIC_API_KEY when both are present, so an inherited
	// one would be sent to the wrong endpoint. The runner blanks it; so do we.
	if (adapter.runtime === AgentRuntime.ClaudeCode) env.push('ANTHROPIC_API_KEY=');
	env.push('HOME=/home/node', 'CI=1');
	return env;
}

/** The argv the runner would build for this runtime, minus the per-run pieces. */
function cliArgv(mp: LiveModelProvider): string[] {
	const runtime = PROVIDER_RUNTIME_ADAPTERS[mp.provider].runtime;
	return [
		RUNTIME_COMMANDS[runtime],
		...RUNTIME_HEADLESS_PREFIX_ARGS[runtime],
		...RUNTIME_STREAM_ARGS[runtime],
		...RUNTIME_AUTO_APPROVE_ARGS[runtime],
		...RUNTIME_DISALLOWED_TOOLS_ARGS[runtime],
		...(mp.model ? ['--model', mp.model] : []),
		...RUNTIME_HEADLESS_SUFFIX_ARGS[runtime],
	];
}

/** Registers the live agent-CLI suite for one backend, if the fixture has a key. */
export function describeAgentCliConformance(
	fixture: LiveAdapterFixture,
	h: ConformanceHarness,
): void {
	const { describe, it, expect, beforeAll, afterAll } = h;
	const mp = fixture.modelProvider;

	if (!mp) {
		describe(`${fixture.name}: live agent CLI run`, () => {
			it.skip('skipped - no model-provider key supplied', () => {});
		});
		return;
	}

	describe(`${fixture.name}: live agent CLI run (${mp.name})`, () => {
		const engine: ContainerEngine = fixture.engine;
		let containerId: string;
		let transcript = '';
		let exitCode = -1;

		beforeAll(async () => {
			await sweepConformanceContainers(engine);
			const created = await engine.createContainer(`hezo-conf-cli-${conformanceRunId()}`, {
				Image: fixture.image,
				Cmd: ['sleep', 'infinity'],
				Labels: { [CONFORMANCE_LABEL]: '1' },
				HostConfig: { Memory: fixture.memoryBytes },
			});
			containerId = created.Id;
			await engine.startContainer(containerId);

			const files = engine.files(containerId, fixture.workRoot);
			await files.mkdir('.');
			await files.write(PROMPT_FILE, PROMPT);

			const runtime = PROVIDER_RUNTIME_ADAPTERS[mp.provider].runtime;
			const argv = cliArgv(mp).map(shellQuote).join(' ');
			const promptPath = shellQuote(`${fixture.workRoot}/${PROMPT_FILE}`);
			// Prompt delivery is the runtime's own convention, and getting it wrong is
			// a hang rather than an error - a CLI waiting on a stdin that never closes
			// looks exactly like a slow model.
			const line =
				RUNTIME_PROMPT_DELIVERY[runtime] === 'arg'
					? `${argv} "$(cat ${promptPath})"`
					: `${argv} < ${promptPath}`;

			const execId = await engine.execCreate(containerId, {
				Cmd: ['sh', '-c', line],
				Env: providerEnv(mp),
				WorkingDir: fixture.workRoot,
				User: fixture.honoursExecUser ? fixture.runUser : undefined,
				AttachStdout: true,
				AttachStderr: true,
			});
			// Streamed, not buffered, because that is how production consumes it: an
			// agent run's stream-json transcript reaches hundreds of MB, so the engine
			// deliberately retains nothing on this path. A suite that used the buffered
			// path would be testing a contract production never uses.
			await engine.execStart(execId, {
				onChunk: (c: ExecLogChunk) => {
					transcript += c.text;
				},
			});
			exitCode = (await engine.execInspect(execId)).ExitCode;
		}, 600_000);

		afterAll(async () => {
			await sweepConformanceContainers(engine);
		}, 120_000);

		it('exits cleanly', () => {
			// The transcript rides along in the message: a non-zero exit here is
			// almost always the provider refusing the credential or the endpoint being
			// unreachable, and both say so in the output.
			expect(`exit=${exitCode} :: ${transcript.slice(-2000)}`).toContain('exit=0');
		});

		it('streams a well-formed stream-json transcript', () => {
			const lines = transcript
				.split('\n')
				.map((l) => l.trim())
				.filter((l) => l.startsWith('{'));
			expect(lines.length).toBeGreaterThan(0);
			// Every line parses: this is what catches a transport that interleaves or
			// splits frames. Daytona merges stdout and stderr onto one channel, so a
			// stray write landing mid-line would surface exactly here.
			const events = lines.map((l) => JSON.parse(l) as { type?: string; subtype?: string });
			const result = events.find((e) => e.type === 'result');
			expect(result).toBeDefined();
			expect(result?.subtype).toBe('success');
		});

		it('round-trips the prompt through the model', () => {
			// The prompt reached the CLI on the channel its runtime expects, the CLI
			// reached the provider, and the answer came back through the exec stream.
			expect(transcript).toContain(SENTINEL);
		});

		it('reports token usage the pricing table can charge against', () => {
			// Runs price only from `model_pricing`, using the buckets the CLI reports -
			// so a runtime that streams no usage prices every run at $0. That failure
			// is invisible in production (a $0 run looks like a cheap run), and this is
			// the only place it surfaces.
			const usage = transcript
				.split('\n')
				.map((l) => l.trim())
				.filter((l) => l.startsWith('{'))
				.map((l) => JSON.parse(l) as { type?: string; usage?: Record<string, unknown> })
				.find((e) => e.type === 'result')?.usage;
			expect(usage).toBeDefined();
			const total = Object.values(usage ?? {}).reduce<number>(
				(sum, v) => sum + (typeof v === 'number' ? v : 0),
				0,
			);
			expect(total).toBeGreaterThan(0);
		});
	});
}
