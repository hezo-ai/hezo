import { describe, expect, it } from 'vitest';
import { loadAgentRoles } from '../src/db/agent-roles';

/**
 * Guard: a shipped role prompt must not write a project-doc filename in
 * backticks.
 *
 * `SHARED_INSTRUCTIONS` tells every agent that backticks mark things that are
 * NOT Hezo entities - "repo file paths, package names, shell commands, code
 * identifiers" - and that a doc is written bare so it links. The shipped prompts
 * were doing the opposite: `brand-voice.md`, `portfolio.md`, `design.md` and
 * others appeared backticked in the very sentences telling an agent to author
 * them, which reads as an instruction to write a file to the repo. That is the
 * mental model behind agents reaching for the Write/Edit tools on a doc that
 * lives in the database, and the server then warns them for the backticks it
 * taught them to use.
 *
 * The allowlist is genuine repo files, where backticks are correct. Every entry
 * is a claim that the file really is a path on disk - do not add one to quiet a
 * failure.
 */
const REPO_FILES = new Set(['AGENTS.md', 'README.md', 'CHANGELOG.md', 'CLAUDE.md']);

const BACKTICKED_MD = /`([A-Za-z0-9._/-]+\.md)`/g;

describe('shipped role prompts reference project docs bare, not in backticks', () => {
	it('no role doc backticks a project-doc filename', async () => {
		const roles = await loadAgentRoles();
		const offenders: Array<{ path: string; filename: string; line: number }> = [];

		for (const [path, content] of Object.entries(roles)) {
			content.split('\n').forEach((line, i) => {
				for (const m of line.matchAll(BACKTICKED_MD)) {
					const filename = m[1];
					if (REPO_FILES.has(filename)) continue;
					// A path with a folder is a repo path, not a doc handle.
					if (filename.includes('/')) continue;
					offenders.push({ path, filename, line: i + 1 });
				}
			});
		}

		expect(
			offenders,
			`These shipped role prompts wrap a project-doc filename in backticks, which renders it as inert code instead of a link and models it to the agent as a repo file path. Write each bare: ${JSON.stringify(
				offenders,
				null,
				2,
			)}`,
		).toEqual([]);
	});
});
