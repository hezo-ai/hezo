/**
 * Startup preflight: verify the external command-line tools the server shells
 * out to are present and new enough. These are easy to get wrong in a fresh
 * environment (container image, dev box, CI) and the failures are otherwise
 * cryptic and deferred — e.g. an old git silently lacks
 * `git worktree add --relative-paths`, so per-task agent worktrees only break
 * the first time an agent runs, far from the root cause.
 *
 * Checked once at boot. Set HEZO_SKIP_TOOL_CHECK=1 to bypass (escape hatch for
 * unusual environments), mirroring HEZO_SKIP_DOCKER.
 */
import { execFile } from 'node:child_process';
import { logger } from '../logger';

const log = logger.child('preflight');

export interface ToolRequirement {
	/** Executable name, as invoked. */
	name: string;
	/** Args that print version info. */
	versionArgs: string[];
	/**
	 * Extract a dotted version (e.g. "2.54.0") from the tool's version output.
	 * Receives stdout + stderr concatenated (some tools print to stderr).
	 * Return null if no version could be parsed.
	 */
	parseVersion: (output: string) => string | null;
	/** Minimum acceptable version (inclusive), or null to only check presence. */
	minVersion: string | null;
	/** Human-readable reason this tool/version is needed. */
	reason: string;
}

export interface ToolCheckResult {
	name: string;
	ok: boolean;
	/** Detected version, or null if missing/unparseable. */
	found: string | null;
	minVersion: string | null;
	message: string;
}

/** Parse "git version 2.54.0" / "git version 2.43.0.windows.1". */
export function parseGitVersion(output: string): string | null {
	return output.match(/git version (\d+\.\d+(?:\.\d+)?)/)?.[1] ?? null;
}

/** Parse "OpenSSH_9.6p1, OpenSSL ..." (ssh-keygen prints this to stderr via -V-less help on some builds; ssh -V is the reliable source). */
export function parseOpenSshVersion(output: string): string | null {
	return output.match(/OpenSSH_(\d+\.\d+)/)?.[1] ?? null;
}

export const REQUIRED_TOOLS: ToolRequirement[] = [
	{
		name: 'git',
		versionArgs: ['--version'],
		parseVersion: parseGitVersion,
		// `git worktree add --relative-paths` (used for container-portable
		// per-task worktrees) was introduced in git 2.48.
		minVersion: '2.48.0',
		reason: 'container-portable agent worktrees (git worktree --relative-paths)',
	},
	{
		name: 'ssh',
		versionArgs: ['-V'],
		parseVersion: parseOpenSshVersion,
		// `ssh-keygen -Y sign` (commit signing + SSH git auth) needs OpenSSH 8.0+.
		minVersion: '8.0',
		reason: 'SSH git operations and commit signing (ssh-keygen -Y sign)',
	},
];

/** Compare dotted numeric versions. Returns -1, 0, or 1. Missing parts are 0. */
export function compareVersions(a: string, b: string): number {
	const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
	const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
	const len = Math.max(pa.length, pb.length);
	for (let i = 0; i < len; i++) {
		const da = pa[i] ?? 0;
		const db = pb[i] ?? 0;
		if (da !== db) return da < db ? -1 : 1;
	}
	return 0;
}

type ToolRunner = (name: string, args: string[]) => Promise<{ ok: boolean; output: string }>;

const defaultRunner: ToolRunner = (name, args) =>
	new Promise((resolve) => {
		execFile(name, args, { timeout: 5000 }, (error, stdout, stderr) => {
			const output = `${stdout ?? ''}${stderr ?? ''}`;
			// ENOENT => binary not on PATH. Other non-zero exits may still print a
			// usable version banner (some tools exit non-zero for -V/-h), so only
			// treat a missing binary as a hard "not runnable".
			const missing = !!error && (error as NodeJS.ErrnoException).code === 'ENOENT';
			resolve({ ok: !missing, output });
		});
	});

/** Run all tool checks. Pure aside from the injected runner (default shells out). */
export async function runToolChecks(
	tools: ToolRequirement[] = REQUIRED_TOOLS,
	runner: ToolRunner = defaultRunner,
): Promise<ToolCheckResult[]> {
	return Promise.all(
		tools.map(async (tool) => {
			const { ok: runnable, output } = await runner(tool.name, tool.versionArgs);
			if (!runnable) {
				return {
					name: tool.name,
					ok: false,
					found: null,
					minVersion: tool.minVersion,
					message: `${tool.name} not found on PATH — required for ${tool.reason}`,
				};
			}

			const found = tool.parseVersion(output);
			if (tool.minVersion === null) {
				return {
					name: tool.name,
					ok: true,
					found,
					minVersion: null,
					message: `${tool.name} present`,
				};
			}

			if (!found) {
				return {
					name: tool.name,
					ok: false,
					found: null,
					minVersion: tool.minVersion,
					message: `${tool.name} version could not be determined (need >= ${tool.minVersion} for ${tool.reason})`,
				};
			}

			const ok = compareVersions(found, tool.minVersion) >= 0;
			return {
				name: tool.name,
				ok,
				found,
				minVersion: tool.minVersion,
				message: ok
					? `${tool.name} ${found} (>= ${tool.minVersion})`
					: `${tool.name} ${found} is too old — need >= ${tool.minVersion} for ${tool.reason}`,
			};
		}),
	);
}

/**
 * Run the preflight tool checks at startup. Logs each result; throws with a
 * combined message if any required tool is missing or too old. Bypassed when
 * HEZO_SKIP_TOOL_CHECK is set.
 */
export async function assertRequiredTools(
	tools: ToolRequirement[] = REQUIRED_TOOLS,
	runner: ToolRunner = defaultRunner,
): Promise<void> {
	if (process.env.HEZO_SKIP_TOOL_CHECK) {
		log.warn('HEZO_SKIP_TOOL_CHECK set — skipping required-tool version checks');
		return;
	}

	const results = await runToolChecks(tools, runner);
	const failures = results.filter((r) => !r.ok);

	for (const r of results) {
		if (r.ok) log.info(r.message);
		else log.error(r.message);
	}

	if (failures.length > 0) {
		throw new Error(
			`Required tool check failed:\n${failures.map((f) => `  - ${f.message}`).join('\n')}\n` +
				'Install/upgrade the tools above, or set HEZO_SKIP_TOOL_CHECK=1 to bypass.',
		);
	}
}
