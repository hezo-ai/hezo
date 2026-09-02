#!/usr/bin/env bun
/**
 * Compute the next release version + changelog from the Conventional-Commit
 * history since the previous tag. The git/IO shell around the pure release
 * logic in `@hezo/server`'s release module.
 *
 * Modes:
 *   --dry-run         print the computed version and changelog body; mutate nothing.
 *   --apply           write package.json versions + prepend CHANGELOG.md, and
 *                     (when run in CI) emit `version`/`changelog` to $GITHUB_OUTPUT.
 *   --notes <version> print an already-written CHANGELOG.md section and exit.
 *
 * The release runs as a PR flow: release.yml prepares the bump on a release
 * branch and opens a PR; release-publish.yml tags + publishes the GitHub Release
 * when that PR merges. This script stays side-effect-light and locally runnable.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import {
	applyOverride,
	computeBump,
	extractReleaseNotes,
	nextVersion,
	type ParsedCommit,
	parseCommit,
	type ReleaseType,
	renderChangelog,
} from '../packages/server/src/release/index.js';

const ROOT = resolve(import.meta.dir, '..');
// Every workspace package carries the release version. One left out here keeps
// whatever version it was created at, through every release that follows.
const PACKAGE_PATHS = ['packages/shared', 'packages/server', 'packages/ui', 'packages/web'].map(
	(p) => resolve(ROOT, p, 'package.json'),
);
const CHANGELOG_PATH = resolve(ROOT, 'CHANGELOG.md');
const SEMVER_TAG_RE = /^\d+\.\d+\.\d+$/;
// NUL field separator and RS record separator — robust against multiline bodies.
// Git expands the `%x00`/`%x1e` placeholders to the raw bytes in its output; the
// literal bytes can't be passed in spawn args, so the format string uses the
// placeholders while we split the output on the actual control characters.
const FIELD = '\x00';
const RECORD = '\x1e';
const LOG_FORMAT = '--format=%h%x00%s%x00%b%x1e';

function sh(cmd: string[]): string {
	const proc = Bun.spawnSync(cmd, { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
	if (proc.exitCode !== 0) {
		const stderr = proc.stderr.toString().trim();
		throw new Error(`Command failed (${cmd.join(' ')}): ${stderr}`);
	}
	return proc.stdout.toString();
}

/** Latest plain-semver tag (no `v` prefix, no pre-release), or null. */
function previousTag(): string | null {
	const out = sh(['git', 'tag', '--list', '--sort=-v:refname']);
	for (const line of out.split('\n')) {
		const tag = line.trim();
		if (SEMVER_TAG_RE.test(tag)) {
			return tag;
		}
	}
	return null;
}

function collectCommits(prev: string | null): ParsedCommit[] {
	const range = prev ? `${prev}..HEAD` : 'HEAD';
	const out = sh(['git', 'log', range, '--no-merges', LOG_FORMAT]);
	return out
		.split(RECORD)
		.map((r) => r.replace(/^\n/, ''))
		.filter((r) => r.trim().length > 0)
		.map((record) => {
			const [hash, subject, body = ''] = record.split(FIELD);
			return parseCommit({ hash: hash.trim(), subject, body });
		})
		.filter((c) => !(c.type === 'chore' && c.scope === 'release'));
}

function repoUrl(): string | undefined {
	const { GITHUB_SERVER_URL, GITHUB_REPOSITORY } = process.env;
	if (GITHUB_SERVER_URL && GITHUB_REPOSITORY) {
		return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}`;
	}
	try {
		const remote = sh(['git', 'remote', 'get-url', 'origin']).trim();
		const m = /github\.com[:/](.+?)(?:\.git)?$/.exec(remote);
		return m ? `https://github.com/${m[1]}` : undefined;
	} catch {
		return undefined;
	}
}

function bumpPackageVersions(version: string): void {
	for (const path of PACKAGE_PATHS) {
		const text = readFileSync(path, 'utf8');
		const updated = text.replace(/("version":\s*)"[^"]*"/, `$1"${version}"`);
		writeFileSync(path, updated);
	}
}

function prependChangelog(body: string): void {
	const header = '# Changelog\n';
	const existing = existsSync(CHANGELOG_PATH) ? readFileSync(CHANGELOG_PATH, 'utf8') : '';
	const previousEntries = existing.replace(/^# Changelog\n+/, '');
	const next = `${header}\n${body.trim()}\n${previousEntries ? `\n${previousEntries.trimStart()}` : ''}`;
	writeFileSync(CHANGELOG_PATH, next.endsWith('\n') ? next : `${next}\n`);
}

function emitGithubOutput(version: string, changelog: string): void {
	const out = process.env.GITHUB_OUTPUT;
	if (!out) {
		return;
	}
	const block = `version=${version}\nchangelog<<HEZO_EOF\n${changelog}\nHEZO_EOF\n`;
	writeFileSync(out, block, { flag: 'a' });
}

const program = new Command()
	.name('release')
	.description('Compute the next release version and changelog from conventional commits')
	.option('--release-type <type>', 'version bump: auto | major | minor | patch', 'auto')
	.option('--dry-run', 'print the version and changelog without writing anything')
	.option('--apply', 'write package.json versions, prepend CHANGELOG.md, emit $GITHUB_OUTPUT')
	.option('--notes <version>', 'print the CHANGELOG.md section for a version and exit')
	.parse();

const opts = program.opts<{
	releaseType: string;
	dryRun?: boolean;
	apply?: boolean;
	notes?: string;
}>();

// --notes is a standalone read of an already-written CHANGELOG.md (used by the
// publish workflow to build the GitHub Release body); it ignores git history.
if (opts.notes) {
	if (!existsSync(CHANGELOG_PATH)) {
		console.error('CHANGELOG.md not found');
		process.exit(1);
	}
	const notes = extractReleaseNotes(readFileSync(CHANGELOG_PATH, 'utf8'), opts.notes);
	if (notes === null) {
		console.error(`No CHANGELOG.md section found for version ${opts.notes}`);
		process.exit(1);
	}
	console.log(notes);
	process.exit(0);
}

const overrideRaw = opts.releaseType;
if (!['auto', 'major', 'minor', 'patch'].includes(overrideRaw)) {
	console.error(`Invalid --release-type: ${overrideRaw} (expected auto|major|minor|patch)`);
	process.exit(1);
}
const override = overrideRaw as ReleaseType;

try {
	sh(['git', 'fetch', '--tags', '--force']);
} catch (e) {
	console.warn(`Warning: could not fetch tags: ${(e as Error).message}`);
}

const prev = previousTag();
const commits = collectCommits(prev);
const auto = computeBump(commits);
let bump = applyOverride(auto, override);

// A manual release dispatch should always cut a release. When nothing
// releasable is detected (e.g. only chore(release) commits since the last tag),
// fall back to a patch bump rather than aborting.
if (bump === 'none') {
	console.warn(
		`No releasable commits since ${prev ?? 'the start of history'}; defaulting to a patch release.`,
	);
	bump = 'patch';
}

const base = prev ?? '0.0.0';
const version = nextVersion(base, bump);
const date = new Date().toISOString().slice(0, 10);
const changelog = renderChangelog({
	version,
	date,
	commits,
	previousTag: prev,
	repoUrl: repoUrl(),
});

if (opts.apply) {
	bumpPackageVersions(version);
	prependChangelog(changelog);
	emitGithubOutput(version, changelog);
	console.log(`Prepared release ${version} (bump: ${bump}, previous: ${prev ?? 'none'}).`);
} else {
	// Default + --dry-run: print only.
	console.log(`version: ${version} (bump: ${bump}, previous: ${prev ?? 'none'})\n`);
	console.log(changelog);
}
