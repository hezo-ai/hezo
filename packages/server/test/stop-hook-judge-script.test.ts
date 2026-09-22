import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AgentRuntime } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildJudgeScriptForRuntime } from '../src/services/stop-hook-prompt';

/**
 * Executes the generated Stop-hook judge scripts for real.
 *
 * The registry test covers which runtimes get a judge and with what model; this
 * one covers whether the emitted JavaScript actually *runs*. That gap is not
 * hypothetical: the scripts are written as `.mjs` (ESM), so a `require(...)` in
 * the generated body throws at load, the process exits non-zero, and every
 * runtime reads that as a broken hook and fails open — a judge that silently
 * never fires, with nothing in the run log to say so. Only executing the script
 * catches it.
 *
 * No API key is set in the environment for these runs, so each script takes its
 * documented fail-open path and exits 0 without making a network call. That is
 * exactly the property under test: fail open, never crash.
 */
describe('generated stop-hook judge scripts', () => {
	let dir: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'hezo-judge-'));
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	const runtimesWithScripts = Object.values(AgentRuntime).filter(
		(r) => buildJudgeScriptForRuntime(r) !== null,
	);

	it('covers every runtime that has a command-script judge', () => {
		// Claude Code uses a native prompt hook (no script); OpenCode, Grok and
		// Antigravity have no judge at all (agy's Stop hook does not fire headless).
		// Everything else must be exercised below.
		expect(runtimesWithScripts).toContain(AgentRuntime.Codex);
		expect(runtimesWithScripts).toContain(AgentRuntime.Kimi);
		expect(runtimesWithScripts).not.toContain(AgentRuntime.ClaudeCode);
		expect(runtimesWithScripts).not.toContain(AgentRuntime.Antigravity);
	});

	for (const runtime of runtimesWithScripts) {
		describe(runtime, () => {
			const scriptFor = (): string => {
				const script = buildJudgeScriptForRuntime(runtime);
				if (!script) throw new Error(`no judge script for ${runtime}`);
				const path = join(dir, `judge-${runtime}.mjs`);
				writeFileSync(path, script, { mode: 0o700 });
				return path;
			};

			/** Run the script with `input` on stdin and no API key in env. */
			const run = (input: string, env: Record<string, string> = {}): string =>
				execFileSync(process.execPath, [scriptFor()], {
					input,
					encoding: 'utf8',
					env: {
						PATH: process.env.PATH ?? '',
						// Deliberately no *_API_KEY — the fail-open path.
						...env,
					},
				});

			it('loads and exits cleanly as an ES module', () => {
				// A `require` in the body would throw ReferenceError here.
				expect(() =>
					run(JSON.stringify({ hook_event_name: 'Stop', session_id: 's1', cwd: '/workspace' })),
				).not.toThrow();
			});

			it('emits no decision when it cannot judge (fail open)', () => {
				const out = run(
					JSON.stringify({ hook_event_name: 'Stop', session_id: 's1', cwd: '/workspace' }),
				);
				expect(out.trim()).toBe('');
			});

			it('survives empty and malformed stdin', () => {
				expect(run('').trim()).toBe('');
				expect(run('not json at all').trim()).toBe('');
			});

			it('allows the stop immediately when the turn was already continued', () => {
				const out = run(JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: true }));
				expect(out.trim()).toBe('');
			});
		});
	}

	describe('kimi loop guard', () => {
		it('treats the marker file as "already continued once"', () => {
			// Kimi's Stop payload never sets stop_hook_active, so the marker file is
			// the only thing standing between a persistent verdict and an unbounded
			// loop. Assert the script reads it and exits without judging.
			const script = buildJudgeScriptForRuntime(AgentRuntime.Kimi);
			expect(script).not.toBeNull();
			const path = join(dir, 'judge-kimi-guard.mjs');
			writeFileSync(path, script ?? '', { mode: 0o700 });

			const home = mkdtempSync(join(tmpdir(), 'hezo-kimi-home-'));
			writeFileSync(join(home, '.hezo-stop-blocked'), '1');
			const out = execFileSync(process.execPath, [path], {
				input: JSON.stringify({ hook_event_name: 'Stop', session_id: 's1' }),
				encoding: 'utf8',
				env: {
					PATH: process.env.PATH ?? '',
					KIMI_CODE_HOME: home,
					// A key IS present here, so only the guard can stop it short.
					KIMI_MODEL_API_KEY: 'sk-test',
				},
			});
			expect(out.trim()).toBe('');
			rmSync(home, { recursive: true, force: true });
		});
	});

	describe('kimi final message from the session log', () => {
		// The Stop payload carries no final message, so the judge reads it from the
		// run's own wire.jsonl. The log here is recorded from Kimi Code 2.0.2, cut
		// where the Stop hook fires: after the first final answer, before the judge
		// has continued the turn.
		const SESSION = 'session_63bb03bc-129d-4f04-bef8-3bcc1befee16';
		const recorded = readFileSync(
			resolve(import.meta.dirname, 'fixtures/kimi/kimi-2.0.2.wire.jsonl'),
			'utf8',
		)
			.split('\n')
			.filter(Boolean);
		const atStop = recorded.slice(
			0,
			recorded.findIndex((l) => l.includes('FIRST_FINAL_ANSWER')) + 1,
		);

		/**
		 * Run the Kimi judge against a seeded home, with `fetch` replaced by a stub
		 * that records the request and answers with `verdict`.
		 */
		const judge = (wire: string[], verdict: unknown) => {
			const home = mkdtempSync(join(tmpdir(), 'hezo-kimi-home-'));
			const logDir = join(home, 'sessions', 'wd_ws_0', SESSION, 'agents', 'main');
			mkdirSync(logDir, { recursive: true });
			writeFileSync(join(logDir, 'wire.jsonl'), `${wire.join('\n')}\n`);
			const requestLog = join(home, 'judge-request.json');
			const stub = join(home, 'fetch-stub.mjs');
			writeFileSync(
				stub,
				`import fs from 'node:fs';
globalThis.fetch = async (url, init) => {
	fs.writeFileSync(${JSON.stringify(requestLog)}, JSON.stringify({ url: String(url), body: JSON.parse(init.body) }));
	return new Response(JSON.stringify({ choices: [{ message: { content: ${JSON.stringify(JSON.stringify(verdict))} } }] }), { status: 200 });
};
`,
			);
			const script = join(home, 'judge.mjs');
			writeFileSync(script, buildJudgeScriptForRuntime(AgentRuntime.Kimi) ?? '', { mode: 0o700 });
			const result = spawnSync(process.execPath, ['--import', stub, script], {
				// The payload as 2.0.2 sends it.
				input: JSON.stringify({
					hook_event_name: 'Stop',
					session_id: SESSION,
					cwd: '/workspace/repo',
					client_type: 'kimi_code_cli',
					stop_hook_active: false,
				}),
				encoding: 'utf8',
				env: {
					PATH: process.env.PATH ?? '',
					KIMI_CODE_HOME: home,
					KIMI_MODEL_API_KEY: 'sk-test',
				},
			});
			let request: { url: string; body: { messages: { content: string }[] } } | null = null;
			try {
				request = JSON.parse(readFileSync(requestLog, 'utf8'));
			} catch {}
			rmSync(home, { recursive: true, force: true });
			return { ...result, request };
		};

		it('judges the final answer the recorded log holds, and blocks by exit code 2', () => {
			const { status, stderr, request } = judge(atStop, {
				decision: 'block',
				reason: 'Post the handoff first.',
			});
			expect(request?.url).toBe('https://api.moonshot.ai/v1/chat/completions');
			expect(request?.body.messages[1].content).toBe(
				"Agent's final response:\nFIRST_FINAL_ANSWER: all steps done.",
			);
			expect(status).toBe(2);
			expect(stderr).toBe('Post the handoff first.');
		});

		it('allows the stop when the judge allows it', () => {
			const { status, request } = judge(atStop, { decision: 'allow', reason: '' });
			expect(request).not.toBeNull();
			expect(status).toBe(0);
		});

		it("ignores a subagent's text", () => {
			const subagent = JSON.stringify({
				type: 'context.append_loop_event',
				agentId: 'agent-7',
				event: {
					type: 'content.part',
					stepUuid: 'sub-step',
					part: { type: 'text', text: 'SUBAGENT REPORT' },
				},
			});
			const { request } = judge([...atStop, subagent], { decision: 'allow', reason: '' });
			expect(request?.body.messages[1].content).toContain('FIRST_FINAL_ANSWER');
		});
	});
});
