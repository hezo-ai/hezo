import { describe, expect, it } from 'vitest';
import {
	renderDaytonaExec,
	renderDaytonaExecScript,
	renderStderrDrain,
	shellQuote,
} from '../src/services/sandbox/daytona/command';

/**
 * Daytona takes a command as one **string**, not argv, so every exec Hezo runs
 * is re-parsed by a shell on the way in. That makes the quoting here the whole
 * security boundary for the adapter: an argument that survives as syntax is a
 * command injection, and the values flowing through include agent-authored
 * prompts and branch names.
 */
describe('shellQuote', () => {
	it('neutralizes every shell metacharacter', () => {
		for (const hostile of [
			'; rm -rf /',
			'$(whoami)',
			'`id`',
			'a && b',
			'x | y',
			'$HOME',
			'a\nb',
			'*',
			'>out',
		]) {
			expect(shellQuote(hostile)).toBe(`'${hostile}'`);
		}
	});

	it('escapes an embedded single quote by closing and reopening', () => {
		// The one case single-quoting cannot contain on its own. Getting this
		// wrong ends the quoted string early and hands the remainder to the shell.
		expect(shellQuote(`it's`)).toBe(`'it'\\''s'`);
		expect(shellQuote(`'; id; '`)).toBe(`''\\''; id; '\\'''`);
	});
});

describe('renderDaytonaExecScript', () => {
	const stderrPath = '/tmp/.hezo-exec-1.err';

	it('runs as-is when no user is named, since Daytona already execs as root', () => {
		const out = renderDaytonaExecScript({ cmd: ['git', 'status'], stderrPath });
		expect(out).not.toContain('runuser');
		expect(out).toContain(`'git' 'status'`);
	});

	it('renders a non-root user as deprivileging, not elevation', () => {
		// The inverse of the Docker path: there `root` is what has to be asked
		// for. Shipping the Docker assumption here would have run every agent
		// exec as root and left root-owned files in the worktree.
		const out = renderDaytonaExecScript({ cmd: ['git', 'status'], user: 'node', stderrPath });
		expect(out).toContain(`'runuser' '-u' 'node' '--'`);
	});

	it('treats an explicit root user as no wrapper at all', () => {
		const out = renderDaytonaExecScript({ cmd: ['id'], user: 'root', stderrPath });
		expect(out).not.toContain('runuser');
	});

	it('sets env inside runuser so the vars survive its environment reset', () => {
		const out = renderDaytonaExecScript({
			cmd: ['agent'],
			env: ['FOO=bar', 'HEZO_HEARTBEAT_RUN_ID=abc'],
			user: 'node',
			stderrPath,
		});
		expect(out.indexOf(`'runuser'`)).toBeLessThan(out.indexOf(`'env'`));
		expect(out).toContain(`'env' 'FOO=bar' 'HEZO_HEARTBEAT_RUN_ID=abc'`);
	});

	it('redirects stderr to the file outside the group so wrapper errors are captured too', () => {
		// A failed `runuser` writes its message to stderr; if the redirect sat
		// inside the group that diagnostic would be lost and a permissions
		// failure would surface as an empty one.
		const out = renderDaytonaExecScript({ cmd: ['agent'], user: 'node', stderrPath });
		expect(out).toContain(`2>'${stderrPath}'`);
		expect(out.indexOf('runuser')).toBeLessThan(out.indexOf('2>'));
	});

	it('quotes an argument that would otherwise be re-parsed as syntax', () => {
		const out = renderDaytonaExecScript({
			cmd: ['sh', '-c', 'echo hi; rm -rf /'],
			stderrPath,
		});
		expect(out).toContain(`'echo hi; rm -rf /'`);
	});

	it('pins the shell when wrapped for sending', () => {
		// Daytona would shell-parse a bare script anyway; naming `sh` is what
		// stops a provider-side default shell change from silently breaking the
		// POSIX scripts Hezo sends.
		const out = renderDaytonaExec({ cmd: ['id'], stderrPath });
		expect(out.startsWith(`sh -c '`)).toBe(true);
		expect(out).toContain(`id`);
	});
});

describe('renderStderrDrain', () => {
	it('bounds the read-back and removes the file', () => {
		// An agent run lasting hours can write unbounded stderr; reading the
		// whole file would materialize it in the server process.
		const out = renderStderrDrain('/tmp/.hezo-exec-1.err', 4096);
		expect(out).toContain('tail -c 4096');
		expect(out).toContain('rm -f');
	});
});
