import { describe, expect, it } from 'vitest';
import {
	assertRequiredTools,
	compareVersions,
	parseGitVersion,
	parseOpenSshVersion,
	REQUIRED_TOOLS,
	runToolChecks,
	type ToolRequirement,
} from '../src/services/preflight';

describe('version parsing', () => {
	it('parses git version output', () => {
		expect(parseGitVersion('git version 2.54.0')).toBe('2.54.0');
		expect(parseGitVersion('git version 2.43.0.windows.1')).toBe('2.43.0');
		expect(parseGitVersion('nope')).toBeNull();
	});

	it('parses OpenSSH version output', () => {
		expect(parseOpenSshVersion('OpenSSH_9.6p1, OpenSSL 3.0.13')).toBe('9.6');
		expect(parseOpenSshVersion('garbage')).toBeNull();
	});
});

describe('compareVersions', () => {
	it('orders dotted numeric versions', () => {
		expect(compareVersions('2.54.0', '2.48.0')).toBe(1);
		expect(compareVersions('2.43.0', '2.48.0')).toBe(-1);
		expect(compareVersions('2.48.0', '2.48.0')).toBe(0);
		expect(compareVersions('2.48', '2.48.0')).toBe(0);
		expect(compareVersions('9.6', '8.0')).toBe(1);
	});
});

const GIT_ONLY: ToolRequirement[] = [
	{
		name: 'git',
		versionArgs: ['--version'],
		parseVersion: parseGitVersion,
		minVersion: '2.48.0',
		reason: 'worktrees',
	},
];

describe('runToolChecks', () => {
	it('passes when the version meets the minimum', async () => {
		const results = await runToolChecks(GIT_ONLY, async () => ({
			ok: true,
			output: 'git version 2.54.0',
		}));
		expect(results[0].ok).toBe(true);
		expect(results[0].found).toBe('2.54.0');
	});

	it('fails when the version is too old', async () => {
		const results = await runToolChecks(GIT_ONLY, async () => ({
			ok: true,
			output: 'git version 2.43.0',
		}));
		expect(results[0].ok).toBe(false);
		expect(results[0].message).toContain('too old');
	});

	it('fails when the binary is missing', async () => {
		const results = await runToolChecks(GIT_ONLY, async () => ({ ok: false, output: '' }));
		expect(results[0].ok).toBe(false);
		expect(results[0].message).toContain('not found');
	});

	it('passes a presence-only check (minVersion null) regardless of version', async () => {
		const presenceOnly: ToolRequirement[] = [{ ...GIT_ONLY[0], minVersion: null }];
		const results = await runToolChecks(presenceOnly, async () => ({ ok: true, output: 'x' }));
		expect(results[0].ok).toBe(true);
	});
});

describe('assertRequiredTools', () => {
	it('throws a combined message listing every failing tool', async () => {
		await expect(
			assertRequiredTools(REQUIRED_TOOLS, async (name) => ({
				ok: name !== 'git', // git missing, ssh present-but-old
				output: name === 'ssh' ? 'OpenSSH_7.4p1' : '',
			})),
		).rejects.toThrow(/git not found[\s\S]*ssh 7\.4 is too old/);
	});

	it('resolves when all tools satisfy their requirements', async () => {
		await expect(
			assertRequiredTools(REQUIRED_TOOLS, async (name) => ({
				ok: true,
				output: name === 'git' ? 'git version 2.54.0' : 'OpenSSH_9.6p1',
			})),
		).resolves.toBeUndefined();
	});

	it('skips checks when HEZO_SKIP_TOOL_CHECK is set', async () => {
		const prev = process.env.HEZO_SKIP_TOOL_CHECK;
		process.env.HEZO_SKIP_TOOL_CHECK = '1';
		try {
			await expect(
				assertRequiredTools(REQUIRED_TOOLS, async () => ({ ok: false, output: '' })),
			).resolves.toBeUndefined();
		} finally {
			if (prev === undefined) delete process.env.HEZO_SKIP_TOOL_CHECK;
			else process.env.HEZO_SKIP_TOOL_CHECK = prev;
		}
	});
});
