import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRuntime, RUNTIME_PROMPT_DELIVERY } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROMPT_DELIVERY_SH } from '../src/services/agent-runner';

/**
 * The prompt-delivery script, run by a real `sh` against a real open stdin.
 *
 * **The bug this exists for is invisible to a string assertion.** An exec leaves
 * the container process's stdin attached to a pipe nothing ever writes to and
 * nothing ever closes. A CLI that reads stdin in headless mode then blocks
 * forever - no output, no exit, no error - which reads as a slow model until the
 * run's deadline. Measured on Prime Agent 0.7.1: the same invocation produced a
 * full transcript in ~2s with stdin closed and nothing at all in 15 minutes
 * without it. Every arg-mode runtime is exposed to it (OpenCode, Grok, Kimi
 * Code, Prime Agent), because in arg mode the prompt is already on the command
 * line and stdin has nothing to legitimately carry.
 *
 * So the parent's stdin here is a pipe that is deliberately never written to and
 * never closed - the exact condition inside a container. A child that reads it
 * hangs, and a hang is the failure: these tests would time out rather than pass.
 *
 * `docker/scripts/hezo-run-with-bridge` carries the same two branches for the
 * bridge path and has to keep matching this; nothing but review enforces that.
 */

const PROMPT = 'deliver-me';

/** Reports the trailing argv it was given and whatever stdin held. */
const CHILD = ['sh', '-c', 'echo "ARG=$1"; echo "STDIN=$(cat)"', 'sh'];

let dir = '';
let promptFile = '';

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'hezo-prompt-'));
	promptFile = join(dir, 'prompt.txt');
	writeFileSync(promptFile, PROMPT);
});

afterAll(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
});

function deliver(mode: 'arg' | 'stdin'): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn('sh', ['-c', PROMPT_DELIVERY_SH, 'sh', ...CHILD], {
			env: { ...process.env, HEZO_PROMPT_MODE: mode, HEZO_PROMPT_FILE: promptFile },
			// 'pipe' and then never touched: an open stdin nobody closes is the whole
			// point. `inherit` or `ignore` would quietly hand the child an EOF and the
			// test would pass on a script that hangs in production.
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		let out = '';
		child.stdout.on('data', (c) => {
			out += c.toString();
		});
		child.on('error', reject);
		child.on('close', () => resolve(out));
	});
}

describe('agent prompt delivery', () => {
	it('passes the prompt as a trailing arg and closes stdin in arg mode', async () => {
		const out = await deliver('arg');
		expect(out).toContain(`ARG=${PROMPT}`);
		// Empty, not absent: the child read stdin to EOF rather than blocking on it.
		expect(out).toContain('STDIN=');
		expect(out).not.toContain(`STDIN=${PROMPT}`);
	});

	it('feeds the prompt on stdin in stdin mode, with no trailing arg', async () => {
		const out = await deliver('stdin');
		expect(out).toContain(`STDIN=${PROMPT}`);
		expect(out).toContain('ARG=\n');
	});

	it('covers every runtime with one of the two branches', () => {
		// Neither branch is reachable by a runtime the table does not classify, and
		// an unclassified one would fall through to the stdin branch by default -
		// which for an arg-mode CLI is the hang above.
		for (const runtime of Object.values(AgentRuntime)) {
			expect(['arg', 'stdin']).toContain(RUNTIME_PROMPT_DELIVERY[runtime]);
		}
	});
});
