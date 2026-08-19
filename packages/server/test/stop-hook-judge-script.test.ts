import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
});
