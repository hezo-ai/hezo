import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	AgentRuntime,
	MAX_SINGLE_ARG_BYTES,
	RUNTIME_HEADLESS_SUFFIX_ARGS,
	RUNTIME_PROMPT_DELIVERY,
} from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROMPT_DELIVERY_SH } from '../src/services/agent-runner';

/**
 * The prompt-delivery script, run by a real `sh` against a real open stdin.
 *
 * **Two bugs live here, and neither is visible to a string assertion.**
 *
 * The first is a hang. An exec leaves the container process's stdin attached to a
 * pipe nothing ever writes to and nothing ever closes. A CLI that reads stdin in
 * headless mode then blocks forever - no output, no exit, no error - which reads
 * as a slow model until the run's deadline. Measured against a CLI that does read
 * it: the same invocation produced a full transcript in ~2s with stdin closed and
 * nothing at all in 15 minutes without it. So the parent's stdin here is a pipe
 * that is deliberately never written to and never closed - the exact condition
 * inside a container. A child that reads it hangs, and a hang is the failure:
 * these tests would time out rather than pass.
 *
 * The second is E2BIG. `arg` delivery expands the prompt's text into a single
 * argv element, and Linux caps one element at MAX_ARG_STRLEN regardless of the
 * far larger total ARG_MAX. Past it the exec dies with `Argument list too long`
 * before the CLI starts. The oversize cases below pin that, and pin that the
 * `file` and `stdin` branches are not subject to it.
 *
 * Both scripts are exercised: `PROMPT_DELIVERY_SH` (the non-bridge path) and the
 * marker-delimited block lifted out of `docker/scripts/hezo-run-with-bridge` (the
 * path essentially every real run takes). They are two hand-maintained copies of
 * one behaviour, so they run the same cases here rather than relying on review.
 */

const PROMPT = 'deliver-me';

/** Reports the trailing argv it was given and whatever stdin held. */
const CHILD = ['sh', '-c', 'echo "ARG=$1"; echo "STDIN=$(cat)"', 'sh'];

const BRIDGE_SCRIPT = join(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
	'..',
	'docker',
	'scripts',
	'hezo-run-with-bridge',
);

const START_MARKER = '# hezo:prompt-delivery:start';
const END_MARKER = '# hezo:prompt-delivery:end';

/**
 * The bridge script's prompt-delivery block, lifted verbatim between its markers
 * so the in-image copy is executed here rather than eyeballed. The block runs the
 * command in `"$@"`; its `EXIT_CODE=$?` / `exit` tail carries the child's status
 * out, which is what the oversize cases assert on.
 */
function bridgeDeliverySh(): string {
	const text = readFileSync(BRIDGE_SCRIPT, 'utf8');
	const start = text.indexOf(START_MARKER);
	const end = text.indexOf(END_MARKER);
	if (start === -1 || end === -1) {
		throw new Error(
			`${BRIDGE_SCRIPT} is missing its ${START_MARKER}/${END_MARKER} markers - the prompt-delivery block cannot be extracted, so nothing checks it against PROMPT_DELIVERY_SH.`,
		);
	}
	return text.slice(start + START_MARKER.length, end);
}

let dir = '';
let promptFile = '';
let hugePromptFile = '';

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'hezo-prompt-'));
	promptFile = join(dir, 'prompt.txt');
	writeFileSync(promptFile, PROMPT);
	// One byte past the per-argument ceiling: the smallest prompt that cannot be
	// an argv element. A real task prompt is comfortably past it - the shared
	// instructions alone are ~111 KB.
	hugePromptFile = join(dir, 'huge.txt');
	writeFileSync(hugePromptFile, 'x'.repeat(MAX_SINGLE_ARG_BYTES + 1));
});

afterAll(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
});

interface Delivered {
	out: string;
	err: string;
	code: number | null;
}

function deliver(script: string, mode: string, file = promptFile): Promise<Delivered> {
	return new Promise((resolve, reject) => {
		const child = spawn('sh', ['-c', script, 'sh', ...CHILD], {
			env: { ...process.env, HEZO_PROMPT_MODE: mode, HEZO_PROMPT_FILE: file },
			// 'pipe' and then never touched: an open stdin nobody closes is the whole
			// point. `inherit` or `ignore` would quietly hand the child an EOF and the
			// test would pass on a script that hangs in production.
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		let out = '';
		let err = '';
		child.stdout.on('data', (c) => {
			out += c.toString();
		});
		child.stderr.on('data', (c) => {
			err += c.toString();
		});
		child.on('error', reject);
		child.on('close', (code) => resolve({ out, err, code }));
	});
}

const SCRIPTS: Array<[string, () => string]> = [
	['PROMPT_DELIVERY_SH', () => PROMPT_DELIVERY_SH],
	['hezo-run-with-bridge', bridgeDeliverySh],
];

describe.each(SCRIPTS)('agent prompt delivery (%s)', (_name, script) => {
	it('passes the prompt as a trailing arg and closes stdin in arg mode', async () => {
		const { out } = await deliver(script(), 'arg');
		expect(out).toContain(`ARG=${PROMPT}`);
		// Empty, not absent: the child read stdin to EOF rather than blocking on it.
		expect(out).toContain('STDIN=');
		expect(out).not.toContain(`STDIN=${PROMPT}`);
	});

	it('feeds the prompt on stdin in stdin mode, with no trailing arg', async () => {
		const { out } = await deliver(script(), 'stdin');
		expect(out).toContain(`STDIN=${PROMPT}`);
		expect(out).toContain('ARG=\n');
	});

	it('appends nothing and closes stdin in file mode', async () => {
		// The CLI opens the prompt file itself; its path is already in the argv the
		// server built, so the wrapper must add neither the text nor the path.
		const { out } = await deliver(script(), 'file');
		expect(out).toContain('ARG=\n');
		expect(out).toContain('STDIN=\n');
	});

	it('defaults to stdin when the mode is unset', async () => {
		const { out } = await deliver(script(), '');
		expect(out).toContain(`STDIN=${PROMPT}`);
	});

	// Linux-only: macOS has no per-argument ceiling, so an oversize arg succeeds
	// there and the assertion would pass against a script that fails in production.
	const onLinux = it.skipIf(process.platform !== 'linux');

	onLinux('fails the exec in arg mode once the prompt passes MAX_ARG_STRLEN', async () => {
		const { code, err } = await deliver(script(), 'arg', hugePromptFile);
		expect(code).not.toBe(0);
		expect(err).toMatch(/Argument list too long/);
	});

	onLinux('carries the same oversize prompt in file mode', async () => {
		const { code, out, err } = await deliver(script(), 'file', hugePromptFile);
		expect(code).toBe(0);
		expect(err).not.toMatch(/Argument list too long/);
		expect(out).toContain('ARG=\n');
	});

	// Pins which side of MAX_SINGLE_ARG_BYTES the kernel refuses, and so pins the
	// `<` in `assertPromptDeliverable`: measured on Linux, an argument of exactly
	// MAX_SINGLE_ARG_BYTES fails (the cap counts the NUL terminator) and one byte
	// less succeeds. An off-by-one here either rejects runs that would have worked
	// or lets through the exact size that dies in the exec.
	onLinux('accepts an arg one byte under the cap and refuses one exactly at it', async () => {
		const under = join(dir, 'under.txt');
		writeFileSync(under, 'x'.repeat(MAX_SINGLE_ARG_BYTES - 1));
		const at = join(dir, 'at.txt');
		writeFileSync(at, 'x'.repeat(MAX_SINGLE_ARG_BYTES));

		expect((await deliver(script(), 'arg', under)).code).toBe(0);
		const atCap = await deliver(script(), 'arg', at);
		expect(atCap.code).not.toBe(0);
		expect(atCap.err).toMatch(/Argument list too long/);
	});

	onLinux('carries the same oversize prompt in stdin mode', async () => {
		const { code, out, err } = await deliver(script(), 'stdin', hugePromptFile);
		expect(code).toBe(0);
		expect(err).not.toMatch(/Argument list too long/);
		expect(out).toContain('ARG=\n');
	});
});

describe('prompt delivery table', () => {
	it('covers every runtime with one of the three branches', () => {
		// No branch is reachable by a runtime the table does not classify, and an
		// unclassified one would fall through to the stdin branch by default - which
		// for a CLI that does not read stdin is the hang above.
		for (const runtime of Object.values(AgentRuntime)) {
			expect(['arg', 'stdin', 'file']).toContain(RUNTIME_PROMPT_DELIVERY[runtime]);
		}
	});

	it('gives every file-delivery runtime a flag for the path to follow', () => {
		// `buildRuntimeInvocation` appends the prompt path after the suffix args. With
		// no suffix flag it would land as a bare positional, which no CLI here reads
		// as a prompt file.
		for (const runtime of Object.values(AgentRuntime)) {
			if (RUNTIME_PROMPT_DELIVERY[runtime] !== 'file') continue;
			expect(RUNTIME_HEADLESS_SUFFIX_ARGS[runtime].length).toBeGreaterThan(0);
		}
	});
});
