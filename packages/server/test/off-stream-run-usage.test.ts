import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRuntime, type CostTokens, costCentsFromRate, type ModelRate } from '@hezo/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recoverOffStreamRunUsage } from '../src/services/agent-runner';
import { hostSandboxFiles } from '../src/services/sandbox/files';

/**
 * Covers the wiring between "the CLI wrote a usage file somewhere under the
 * per-run home" and "cost gets recorded".
 *
 * The pure extractors (`extractGrokUsageFromDebugLog`,
 * `extractKimiUsageFromSessionLog`) are tested directly in
 * agent-stream-parser.test.ts against known log contents. What is exercised here
 * is everything around them: locating the file, the depth-bounded directory walk
 * Kimi needs (its session log sits five levels down under a path whose ids are
 * generated at runtime), the scrub afterwards, and the fail-low behaviour when
 * anything is missing. That path decides whether a run records real cost or $0,
 * and none of it was covered before.
 */

const RATES: Record<string, ModelRate> = {
	'kimi-k2.7-code': {
		inputPerToken: 0.0000074,
		outputPerToken: 0.0000035,
		cacheReadPerToken: 0.0000002,
	},
	'grok-4.5': { inputPerToken: 0.00001, outputPerToken: 0.00003, cacheReadPerToken: 0.000001 },
};
const price = (model: string | undefined, tokens: CostTokens): number => {
	const rate = model ? RATES[model] : undefined;
	return rate ? costCentsFromRate(rate, tokens) : 0;
};

describe('recoverOffStreamRunUsage', () => {
	let home: string;
	const errors: string[] = [];
	const onError = (msg: string): void => {
		errors.push(msg);
	};
	// Recovery reads through the SandboxFiles seam now, rooted at the per-run
	// home. Under Docker that root is the host side of the bind mount, which is
	// what these tests seed.
	const mount = () => hostSandboxFiles(home);

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), 'hezo-offstream-'));
		errors.length = 0;
	});
	afterEach(() => rmSync(home, { recursive: true, force: true }));

	/** Write a wire.jsonl at Kimi Code's real nesting depth under the run home. */
	const seedKimiSessionLog = (contents: string, sessionId = 'sess-1'): string => {
		const dir = join(home, 'sessions', 'ws-1', sessionId, 'agents', 'agent-1');
		mkdirSync(dir, { recursive: true });
		const path = join(dir, 'wire.jsonl');
		writeFileSync(path, contents);
		return path;
	};

	const kimiRecord = (o: Record<string, unknown>): string => JSON.stringify(o);

	describe('kimi', () => {
		it('finds the session log nested under the run home and prices it', async () => {
			seedKimiSessionLog(
				[
					kimiRecord({
						scope: 'turn',
						request_id: 'r1',
						model: 'kimi-k2.7-code',
						usage: { inputOther: 1000, output: 200, inputCacheRead: 500 },
					}),
					kimiRecord({
						scope: 'turn',
						request_id: 'r2',
						model: 'kimi-k2.7-code',
						usage: { inputOther: 300, output: 50 },
					}),
				].join('\n'),
			);

			const usage = await recoverOffStreamRunUsage(AgentRuntime.Kimi, mount(), price, onError);
			expect(usage).not.toBeNull();
			expect(usage?.inputTokens).toBe(1300 + 500);
			expect(usage?.outputTokens).toBe(250);
			expect(usage?.costCents).toBeGreaterThan(0);
			expect(errors).toEqual([]);
		});

		it('scrubs the session log after reading it', async () => {
			// A wire log plausibly captures request headers, i.e. the Moonshot bearer,
			// so it must not outlive the run on the host.
			const path = seedKimiSessionLog(
				kimiRecord({
					scope: 'turn',
					request_id: 'r1',
					model: 'kimi-k2.7-code',
					usage: { inputOther: 10, output: 1 },
				}),
			);
			expect(existsSync(path)).toBe(true);
			await recoverOffStreamRunUsage(AgentRuntime.Kimi, mount(), price, onError);
			expect(existsSync(path)).toBe(false);
		});

		it('returns null when no session log was written (⇒ $0, not a failed run)', async () => {
			// The run may have died before the CLI flushed anything.
			mkdirSync(join(home, 'sessions'), { recursive: true });
			expect(await recoverOffStreamRunUsage(AgentRuntime.Kimi, mount(), price, onError)).toBeNull();
			expect(errors).toEqual([]);
		});

		it('returns null when the sessions directory does not exist at all', async () => {
			expect(await recoverOffStreamRunUsage(AgentRuntime.Kimi, mount(), price, onError)).toBeNull();
			expect(errors).toEqual([]);
		});

		it('returns null, without throwing, when the log holds no usage records', async () => {
			seedKimiSessionLog('{"role":"assistant","content":"hi"}\nnot json\n');
			expect(await recoverOffStreamRunUsage(AgentRuntime.Kimi, mount(), price, onError)).toBeNull();
		});

		it('combines logs from multiple session dirs without double-counting', async () => {
			// A resumed session or a subagent can leave more than one log under the
			// run home; the extractor dedupes by record id, not by file.
			seedKimiSessionLog(
				kimiRecord({
					scope: 'turn',
					request_id: 'r1',
					model: 'kimi-k2.7-code',
					usage: { inputOther: 100, output: 10 },
				}),
				'sess-1',
			);
			seedKimiSessionLog(
				[
					kimiRecord({
						scope: 'turn',
						request_id: 'r1',
						model: 'kimi-k2.7-code',
						usage: { inputOther: 100, output: 10 },
					}),
					kimiRecord({
						scope: 'turn',
						request_id: 'r2',
						model: 'kimi-k2.7-code',
						usage: { inputOther: 200, output: 20 },
					}),
				].join('\n'),
				'sess-2',
			);

			const usage = await recoverOffStreamRunUsage(AgentRuntime.Kimi, mount(), price, onError);
			// r1 appears in both files and is counted once.
			expect(usage?.inputTokens).toBe(300);
			expect(usage?.outputTokens).toBe(30);
		});

		it('does not follow symlinks out of the run home', async () => {
			// The depth cap only bounds the walk if symlinks are never followed.
			const outside = mkdtempSync(join(tmpdir(), 'hezo-outside-'));
			mkdirSync(join(outside, 'agents'), { recursive: true });
			writeFileSync(
				join(outside, 'agents', 'wire.jsonl'),
				kimiRecord({
					scope: 'turn',
					request_id: 'x',
					model: 'kimi-k2.7-code',
					usage: { inputOther: 999999, output: 999999 },
				}),
			);
			const sessions = join(home, 'sessions');
			mkdirSync(sessions, { recursive: true });
			const link = join(sessions, 'linked');
			symlinkSync(outside, link, 'dir');
			// Guard against a vacuous pass: the link must really resolve to the
			// planted log, so a null result can only mean the walk declined to
			// follow it.
			expect(existsSync(join(link, 'agents', 'wire.jsonl'))).toBe(true);

			expect(await recoverOffStreamRunUsage(AgentRuntime.Kimi, mount(), price, onError)).toBeNull();
			rmSync(outside, { recursive: true, force: true });
		});
	});

	describe('grok', () => {
		it('reads and scrubs the per-run debug file', async () => {
			const path = join(home, 'debug.log');
			writeFileSync(
				path,
				'DEBUG session.process_conversation_turn{model_id="grok-4.5" request_id="r1" input_tokens=100 output_tokens=20 cache_read_tokens=10}: record',
			);
			const usage = await recoverOffStreamRunUsage(AgentRuntime.Grok, mount(), price, onError);
			expect(usage?.inputTokens).toBe(100);
			expect(usage?.outputTokens).toBe(20);
			// The debug file holds the XAI_API_KEY in plaintext.
			expect(existsSync(path)).toBe(false);
		});

		it('returns null when the debug file is absent', async () => {
			expect(await recoverOffStreamRunUsage(AgentRuntime.Grok, mount(), price, onError)).toBeNull();
		});
	});

	describe('every other runtime', () => {
		it('returns null so the caller keeps the parser stream usage', async () => {
			// Claude Code / Codex / Gemini / OpenCode all report usage on stdout; this
			// path must not overwrite it.
			for (const runtime of [
				AgentRuntime.ClaudeCode,
				AgentRuntime.Codex,
				AgentRuntime.Antigravity,
				AgentRuntime.OpenCode,
			]) {
				expect(
					await recoverOffStreamRunUsage(runtime, mount(), price, onError),
					runtime,
				).toBeNull();
			}
		});

		it('returns null when there is no home mount at all', async () => {
			expect(await recoverOffStreamRunUsage(AgentRuntime.Kimi, null, price, onError)).toBeNull();
			expect(await recoverOffStreamRunUsage(AgentRuntime.Grok, null, price, onError)).toBeNull();
		});
	});
});
