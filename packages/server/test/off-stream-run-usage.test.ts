import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRuntime } from '@hezo/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recoverOffStreamRunUsage } from '../src/services/agent-runner';
import { RUNTIME_ADAPTERS } from '../src/services/runtime-adapters';
import { MAX_OFF_STREAM_USAGE_BYTES } from '../src/services/runtime-adapters/types';
import { hostSandboxFiles } from '../src/services/sandbox/files';

/**
 * Covers the wiring between "the CLI wrote a usage file somewhere under the
 * per-run home" and "usage gets recorded".
 *
 * The pure extractors (`extractGrokUsageFromDebugLog`,
 * `extractKimiUsageFromSessionLog`) are tested directly in
 * agent-stream-parser.test.ts against known log contents. What is exercised here
 * is everything around them: locating the file, the depth-bounded directory walk
 * Kimi needs (its session log sits five levels down under a path whose ids are
 * generated at runtime), the scrub afterwards, and the fail-low behaviour when
 * anything is missing. That path decides whether a run records its tokens or
 * none, and none of it was covered before.
 */

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

	describe('codex', () => {
		/** A rollout at Codex's real nesting: sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl */
		const seedRollout = (contents: string, dir = 'sessions', name = 'abc'): string => {
			const full = join(home, dir, '2026', '09', '12');
			mkdirSync(full, { recursive: true });
			const path = join(full, `rollout-2026-09-12T10-00-00-${name}.jsonl`);
			writeFileSync(path, contents);
			return path;
		};
		const rolloutUsage = (input: number, cached: number, output: number): string =>
			JSON.stringify({
				type: 'event_msg',
				payload: {
					type: 'token_count',
					info: {
						total_token_usage: {
							input_tokens: input,
							cached_input_tokens: cached,
							cache_write_input_tokens: 0,
							output_tokens: output,
							reasoning_output_tokens: 0,
							total_tokens: input + output,
						},
					},
				},
			});
		const turnContext = (model: string): string =>
			JSON.stringify({ type: 'turn_context', payload: { model } });

		it('finds the rollout by its generated name and records the model it names', async () => {
			// The name carries a timestamp and a uuid, so an exact-basename match
			// cannot find it - this is what the prefix/suffix form of findByName is for.
			const path = seedRollout([turnContext('grok-4.5'), rolloutUsage(1000, 500, 200)].join('\n'));

			const usage = await recoverOffStreamRunUsage(AgentRuntime.Codex, mount(), onError);

			expect(usage?.inputTokens).toBe(1000);
			expect(usage?.outputTokens).toBe(200);
			expect(usage?.model).toBe('grok-4.5');
			expect(usage?.buckets).toEqual({
				inputTokens: 500,
				cacheReadTokens: 500,
				cacheCreationTokens: 0,
				outputTokens: 200,
			});
			// Scrubbed: a rollout is the whole verbatim transcript, materially more
			// sensitive than the credential file beside it.
			expect(existsSync(path)).toBe(false);
			expect(existsSync(join(home, 'sessions'))).toBe(false);
		});

		it('sums every rollout under the run home, including an archived one', async () => {
			// CODEX_HOME is per-run, so everything under it belongs to this run -
			// a subagent's rollout bills to the same account.
			seedRollout(rolloutUsage(100, 0, 10), 'sessions', 'one');
			seedRollout(rolloutUsage(50, 0, 5), 'archived_sessions', 'two');

			const usage = await recoverOffStreamRunUsage(AgentRuntime.Codex, mount(), onError);

			expect(usage?.inputTokens).toBe(150);
			expect(usage?.outputTokens).toBe(15);
			expect(existsSync(join(home, 'archived_sessions'))).toBe(false);
		});

		it('reads the tokens from the tail and the model from the head of a rollout too large to buffer', async () => {
			// These run to hundreds of megabytes; a whole-file read at ten concurrent
			// runs is an out-of-memory fault. The token totals are cumulative, so the
			// tail carries them. A single-turn rollout names its model once, near the
			// start, so the tail alone records no model.
			const filler = `${JSON.stringify({ type: 'response_item', payload: { junk: 'x'.repeat(400) } })}\n`;
			seedRollout(
				[turnContext('gpt-5-codex'), filler.repeat(8000), rolloutUsage(9000, 0, 900)].join('\n'),
			);

			const usage = await recoverOffStreamRunUsage(AgentRuntime.Codex, mount(), onError);
			expect(usage?.model).toBe('gpt-5-codex');

			expect(usage?.inputTokens).toBe(9000);
			expect(errors).toEqual([]);
		});

		it("carries the provider's usage window through, the newest across the run's rollouts", async () => {
			const withWeek = (input: number, used: number, resetsAt: number): string =>
				JSON.stringify({
					type: 'event_msg',
					payload: {
						type: 'token_count',
						info: { total_token_usage: { input_tokens: input, output_tokens: 1 } },
						rate_limits: {
							primary: { used_percent: 80, window_minutes: 300, resets_at: resetsAt - 3600 },
							secondary: { used_percent: used, window_minutes: 10_080, resets_at: resetsAt },
						},
					},
				});
			const reset = Date.parse('2026-10-01T02:42:00Z') / 1000;
			// A helper session's rollout read the window a moment later, higher.
			seedRollout(withWeek(100, 21, reset), 'sessions', 'main');
			seedRollout(withWeek(40, 23, reset), 'sessions', 'helper');

			const usage = await recoverOffStreamRunUsage(AgentRuntime.Codex, mount(), onError);

			expect(usage?.inputTokens).toBe(140);
			expect(usage?.allowance).toEqual({
				usedPercent: 23,
				windowMinutes: 10_080,
				resetsAt: new Date(reset * 1000),
			});
		});

		it('reports nothing rather than failing when there is no rollout at all', async () => {
			expect(await recoverOffStreamRunUsage(AgentRuntime.Codex, mount(), onError)).toBeNull();
			expect(errors).toEqual([]);
		});

		it("reads a rollout mid-run without removing it, so a later read or the run's end finds it", async () => {
			const path = seedRollout(rolloutUsage(4000, 0, 40));
			const reader = RUNTIME_ADAPTERS[AgentRuntime.Codex].offStreamUsage;

			expect((await reader?.read({ files: mount(), onError }))?.inputTokens).toBe(4000);
			expect(existsSync(path)).toBe(true);
			expect(
				(await recoverOffStreamRunUsage(AgentRuntime.Codex, mount(), onError))?.inputTokens,
			).toBe(4000);
			expect(existsSync(path)).toBe(false);
		});
	});

	describe('kimi', () => {
		it('finds the session log nested under the run home and counts it', async () => {
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

			const usage = await recoverOffStreamRunUsage(AgentRuntime.Kimi, mount(), onError);
			expect(usage).not.toBeNull();
			expect(usage?.inputTokens).toBe(1300 + 500);
			expect(usage?.outputTokens).toBe(250);
			expect(usage?.model).toBe('kimi-k2.7-code');
			expect(errors).toEqual([]);
		});

		it('reads the session log mid-run without removing it', async () => {
			const path = seedKimiSessionLog(
				kimiRecord({
					type: 'usage',
					request_id: 'r1',
					model_id: 'kimi-k2.7-code',
					usage: { inputTokens: 10, outputTokens: 1 },
				}),
			);
			const reader = RUNTIME_ADAPTERS[AgentRuntime.Kimi].offStreamUsage;
			await reader?.read({ files: mount(), onError });
			expect(existsSync(path)).toBe(true);
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
			await recoverOffStreamRunUsage(AgentRuntime.Kimi, mount(), onError);
			expect(existsSync(path)).toBe(false);
		});

		it('returns null when no session log was written (no tokens, not a failed run)', async () => {
			// The run may have died before the CLI flushed anything.
			mkdirSync(join(home, 'sessions'), { recursive: true });
			expect(await recoverOffStreamRunUsage(AgentRuntime.Kimi, mount(), onError)).toBeNull();
			expect(errors).toEqual([]);
		});

		it('returns null when the sessions directory does not exist at all', async () => {
			expect(await recoverOffStreamRunUsage(AgentRuntime.Kimi, mount(), onError)).toBeNull();
			expect(errors).toEqual([]);
		});

		it('returns null, without throwing, when the log holds no usage records', async () => {
			seedKimiSessionLog('{"role":"assistant","content":"hi"}\nnot json\n');
			expect(await recoverOffStreamRunUsage(AgentRuntime.Kimi, mount(), onError)).toBeNull();
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

			const usage = await recoverOffStreamRunUsage(AgentRuntime.Kimi, mount(), onError);
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

			expect(await recoverOffStreamRunUsage(AgentRuntime.Kimi, mount(), onError)).toBeNull();
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
			const usage = await recoverOffStreamRunUsage(AgentRuntime.Grok, mount(), onError);
			expect(usage?.inputTokens).toBe(100);
			expect(usage?.outputTokens).toBe(20);
			// The debug file holds the XAI_API_KEY in plaintext.
			expect(existsSync(path)).toBe(false);
		});

		it('reads the debug file mid-run without removing it', async () => {
			const path = join(home, 'debug.log');
			writeFileSync(
				path,
				'DEBUG session.process_conversation_turn{model_id="grok-4.5" request_id="r1" input_tokens=100 output_tokens=20 cache_read_tokens=10}: record',
			);
			const reader = RUNTIME_ADAPTERS[AgentRuntime.Grok].offStreamUsage;
			expect((await reader?.read({ files: mount(), onError }))?.inputTokens).toBe(100);
			expect(existsSync(path)).toBe(true);
		});

		it('returns null when the debug file is absent', async () => {
			expect(await recoverOffStreamRunUsage(AgentRuntime.Grok, mount(), onError)).toBeNull();
		});

		it('leaves a log past the read budget unread and says so', async () => {
			// The figures are counted by request id, so a tail would undercount. A log
			// this size is skipped instead: the read repeats for the life of the run,
			// in the process that is also the API and the database.
			const path = join(home, 'debug.log');
			writeFileSync(path, 'x'.repeat(MAX_OFF_STREAM_USAGE_BYTES + 1));
			const reader = RUNTIME_ADAPTERS[AgentRuntime.Grok].offStreamUsage;
			expect(await reader?.read({ files: mount(), onError })).toBeNull();
			expect(errors.join(' ')).toContain('read budget');
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
				expect(await recoverOffStreamRunUsage(runtime, mount(), onError), runtime).toBeNull();
			}
		});

		it('returns null when there is no home mount at all', async () => {
			expect(await recoverOffStreamRunUsage(AgentRuntime.Kimi, null, onError)).toBeNull();
			expect(await recoverOffStreamRunUsage(AgentRuntime.Grok, null, onError)).toBeNull();
		});
	});
});
