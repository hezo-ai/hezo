import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import {
	buildSubscriptionLoginCodeScript,
	buildSubscriptionLoginScript,
	LOGIN_EXIT_FILE,
	LOGIN_LOG_FILE,
	LOGIN_STDIN_FIFO,
	shellQuote,
} from '../src/services/sandbox/proc-scripts';

const run = promisify(execFile);

/**
 * The login script is the one piece of this feature that is shell rather than
 * TypeScript, so it is tested the way `agent-prompt-delivery.test.ts` tests its
 * own block: asserted on as a string for the parts that must be exact, then
 * **executed under real `sh`** for the part that only running proves - that a
 * CLI launched by it can print a challenge, block on stdin minutes later, and
 * still receive what the operator eventually types.
 */

const dirs: string[] = [];
function tempDir(): string {
	const d = mkdtempSync(join(tmpdir(), 'hezo-login-'));
	dirs.push(d);
	return d;
}

/**
 * Best-effort, because the script deliberately outlives the command that
 * launched it - a `sleep` holds the FIFO open for the whole flow, which is the
 * mechanism under test. Every test below waits for its own exit file first, so
 * a leftover here is a stray temp directory the OS will reap, never a signal
 * worth failing a suite over.
 */
afterAll(() => {
	for (const d of dirs) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			// see above
		}
	}
});

describe('shellQuote', () => {
	it('wraps a plain argument', () => {
		expect(shellQuote('codex')).toBe("'codex'");
	});

	it('closes and reopens around an embedded quote, so nothing escapes the string', () => {
		expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
	});

	it('neutralises every shell metacharacter that would otherwise run', async () => {
		const hostile = `x'; touch ${'${PWD}'}/pwned; echo '`;
		const { stdout } = await run('sh', ['-c', `printf '%s' ${shellQuote(hostile)}`]);
		expect(stdout).toBe(hostile);
	});
});

describe('buildSubscriptionLoginScript', () => {
	const base = { dir: '/tmp/flow', argv: ['codex', 'login', '--device-auth'], holdSecs: 60 };

	it('rejects a directory that could break out of its quoting', () => {
		expect(() => buildSubscriptionLoginScript({ ...base, dir: '/tmp/$(id)' })).toThrow(
			/unsafe dir/,
		);
		expect(() => buildSubscriptionLoginScript({ ...base, dir: 'relative' })).toThrow(/unsafe dir/);
	});

	it('rejects an empty command and a nonsensical hold', () => {
		expect(() => buildSubscriptionLoginScript({ ...base, argv: [] })).toThrow(/argv is empty/);
		expect(() => buildSubscriptionLoginScript({ ...base, holdSecs: 0 })).toThrow(/bad holdSecs/);
		expect(() => buildSubscriptionLoginScript({ ...base, holdSecs: 1.5 })).toThrow(/bad holdSecs/);
	});

	it('rejects an env name that is not a shell identifier', () => {
		expect(() => buildSubscriptionLoginScript({ ...base, env: { 'A;rm -rf /': 'x' } })).toThrow(
			/unsafe env name/,
		);
	});

	/**
	 * Quoted twice on purpose: once per element, then again around the joined
	 * string, because `script -qec` takes the whole command as one argument and
	 * re-parses it with a shell. Both layers have to hold for an argv element to
	 * be safe, so this asserts on the nesting rather than the flat form.
	 */
	it('quotes each argv element separately, inside the outer quoting', () => {
		const script = buildSubscriptionLoginScript(base);
		expect(script).toContain(`'\\''codex'\\'' '\\''login'\\'' '\\''--device-auth'\\''`);
	});

	it('opens the PTY wide enough that a sign-in URL cannot wrap', () => {
		expect(buildSubscriptionLoginScript(base)).toContain('COLUMNS=1000');
	});

	it('holds the stdin FIFO open for the whole flow', () => {
		const script = buildSubscriptionLoginScript({ ...base, holdSecs: 960 });
		expect(script).toContain(`sleep 960 > '/tmp/flow/${LOGIN_STDIN_FIFO}'`);
	});

	it('merges stderr into the polled log, so a challenge printed there is not lost', () => {
		expect(buildSubscriptionLoginScript(base)).toContain(`> '/tmp/flow/${LOGIN_LOG_FILE}' 2>&1`);
	});

	it('records the exit status last, as the "process is gone" signal', () => {
		expect(buildSubscriptionLoginScript(base)).toContain(
			`echo $? > '/tmp/flow/${LOGIN_EXIT_FILE}'`,
		);
	});

	it('addresses every file absolutely, so the second background job cannot land elsewhere', () => {
		const script = buildSubscriptionLoginScript(base);
		expect(script).not.toMatch(/\bcd\b/);
		// Both background jobs must name the same absolute FIFO.
		expect(script.match(/'\/tmp\/flow\/in'/g)?.length).toBeGreaterThanOrEqual(3);
	});

	it('detaches both background jobs stdio, so the launching exec can complete', () => {
		const script = buildSubscriptionLoginScript(base);
		expect(script.match(/>\/dev\/null 2>&1 &/g)).toHaveLength(2);
	});

	it('passes driver env through to the CLI', () => {
		const script = buildSubscriptionLoginScript({ ...base, env: { CODEX_HOME: '/tmp/flow/home' } });
		expect(script).toContain(`CODEX_HOME='/tmp/flow/home'`);
	});
});

describe('buildSubscriptionLoginCodeScript', () => {
	it('rejects an unsafe directory', () => {
		expect(() => buildSubscriptionLoginCodeScript('/tmp/`id`', 'abc')).toThrow(/unsafe dir/);
	});

	it('quotes a code containing shell metacharacters', () => {
		const script = buildSubscriptionLoginCodeScript('/tmp/flow', "a'; id #");
		expect(script).toContain(`'a'\\''; id #'`);
	});
});

describe('the generated script, under real sh', () => {
	/**
	 * A stand-in for a vendor CLI: prints a challenge, then blocks reading a code
	 * from stdin and writes a credential once it arrives. That sequence - print,
	 * then block for an unbounded time, then read - is exactly what the FIFO
	 * exists for, and what a string assertion cannot prove works.
	 */
	function fakeCli(dir: string, body: string): string {
		const path = join(dir, 'fake-cli.sh');
		writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
		return path;
	}

	async function waitFor(check: () => boolean, timeoutMs = 15_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (check()) return;
			await new Promise((r) => setTimeout(r, 100));
		}
		throw new Error('timed out');
	}

	/**
	 * Wait until the flow has fully finished, not merely produced its output.
	 *
	 * The exit file is written *after* the CLI is reaped, so it is the only
	 * signal that nothing under the flow directory will be created again. Racing
	 * teardown against it is how this suite first failed on CI: cleanup deleted
	 * the log, the CLI then exited, and `echo $? > exit` recreated an entry in a
	 * directory that had just been walked - ENOTEMPTY.
	 */
	const exited = (dir: string) => () => existsSync(join(dir, LOGIN_EXIT_FILE));

	it('carries a challenge out and the operator code back in', async () => {
		const home = tempDir();
		const dir = join(tempDir(), 'flow');
		const cli = fakeCli(
			home,
			[
				'echo "Open this link:"',
				'echo "   https://auth.example.com/device"',
				'read code',
				'echo "got:$code"',
			].join('\n'),
		);

		await run('sh', ['-c', buildSubscriptionLoginScript({ dir, argv: [cli], holdSecs: 30 })]);

		const log = () => readFileSync(join(dir, LOGIN_LOG_FILE), 'utf8');
		await waitFor(() => log().includes('https://auth.example.com/device'));

		// The CLI is still blocked on stdin here - minutes may pass in production
		// while the operator signs in on another device.
		expect(log()).not.toContain('got:');

		await run('sh', ['-c', buildSubscriptionLoginCodeScript(dir, 'CODE-1234')]);
		await waitFor(() => log().includes('got:CODE-1234'));
		await waitFor(exited(dir));
	});

	it('writes the exit file once the CLI is gone', async () => {
		const home = tempDir();
		const dir = join(tempDir(), 'flow');
		const cli = fakeCli(home, 'echo done; exit 0');

		await run('sh', ['-c', buildSubscriptionLoginScript({ dir, argv: [cli], holdSecs: 30 })]);
		await waitFor(exited(dir));
	});

	it('delivers a code containing shell metacharacters verbatim', async () => {
		const home = tempDir();
		const dir = join(tempDir(), 'flow');
		const cli = fakeCli(home, 'echo ready\nread code\necho "got:$code"');
		const hostile = `a'; touch ${join(home, 'pwned')}; echo '`;

		await run('sh', ['-c', buildSubscriptionLoginScript({ dir, argv: [cli], holdSecs: 30 })]);
		const log = () => readFileSync(join(dir, LOGIN_LOG_FILE), 'utf8');
		await waitFor(() => log().includes('ready'));

		await run('sh', ['-c', buildSubscriptionLoginCodeScript(dir, hostile)]);
		await waitFor(() => log().includes('got:'));

		expect(log()).toContain(`got:${hostile}`);
		expect(() => readFileSync(join(home, 'pwned'))).toThrow();
		await waitFor(exited(dir));
	});
});
