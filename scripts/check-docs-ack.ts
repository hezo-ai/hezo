// Commit-msg guard: every commit that touches a doc-bearing surface must carry
// a `Docs-Checked:` trailer acknowledging the docs-alignment pass (AGENTS.md
// § Keeping docs in sync with code). Hand-written prose (docs/**, READMEs,
// .dev/architecture.md) has no drift test, so the acknowledgment is the record
// that a human or agent actually re-read the affected pages — a commit without
// it is rejected by .husky/commit-msg.
//
// Pure functions here are unit-tested in packages/server/test/docs-ack-hook.test.ts
// (same pattern as scripts/coverage — no DB/DOM needed).
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Path prefixes whose changes carry documentation obligations. Tests, CI
 * config, and the docs themselves are deliberately absent: a docs-only or
 * test-only commit needs no acknowledgment.
 */
export const DOC_BEARING_PATTERNS: RegExp[] = [
	/^packages\/[^/]+\/src\//,
	/^packages\/[^/]+\/migrations\//,
	/^agents\//,
	/^skills\//,
	/^docker\//,
	/^deploy\//,
	/^marketplace\//,
	/^scripts\//,
];

/** Trailer values that name-check the rule without actually acknowledging anything. */
const BARE_VALUES = new Set([
	'yes',
	'y',
	'no',
	'n',
	'true',
	'ok',
	'done',
	'checked',
	'n/a',
	'na',
	'none',
	'-',
]);

const MIN_ACK_LENGTH = 10;

export function docBearingFiles(stagedFiles: string[]): string[] {
	return stagedFiles.filter((f) => DOC_BEARING_PATTERNS.some((p) => p.test(f)));
}

/** Strip git comment lines and everything below a scissors marker. */
export function effectiveMessage(rawMessage: string): string {
	const scissors = rawMessage.indexOf('------------------------ >8 ------------------------');
	const body = scissors === -1 ? rawMessage : rawMessage.slice(0, scissors);
	return body
		.split('\n')
		.filter((line) => !line.startsWith('#'))
		.join('\n')
		.trim();
}

/** Commits git itself generates (or that get squashed away) are exempt. */
export function isExemptCommit(message: string): boolean {
	return /^(Merge |Revert |fixup!|squash!|amend!)/.test(message);
}

export function findDocsAckValue(message: string): string | null {
	const match = message.match(/^Docs-Checked:[ \t]*(.*)$/im);
	return match ? match[1].trim() : null;
}

export function checkCommitMessage(
	rawMessage: string,
	stagedFiles: string[],
): { ok: boolean; error?: string } {
	const message = effectiveMessage(rawMessage);
	if (message.length === 0 || isExemptCommit(message)) return { ok: true };

	const bearing = docBearingFiles(stagedFiles);
	if (bearing.length === 0) return { ok: true };

	const value = findDocsAckValue(message);
	if (value === null) {
		return {
			ok: false,
			error:
				`This commit touches doc-bearing code (${bearing[0]}${bearing.length > 1 ? ` and ${bearing.length - 1} more` : ''}) ` +
				'but has no Docs-Checked: trailer.',
		};
	}
	if (value.length < MIN_ACK_LENGTH || BARE_VALUES.has(value.toLowerCase())) {
		return {
			ok: false,
			error: `Docs-Checked value "${value}" is not a meaningful acknowledgment — state which docs you updated or verified, or why none apply.`,
		};
	}
	return { ok: true };
}

function main(): void {
	const msgFile = process.argv[2];
	if (!msgFile) {
		console.error('usage: bun scripts/check-docs-ack.ts <commit-msg-file>');
		process.exit(2);
	}
	const rawMessage = readFileSync(msgFile, 'utf8');
	const staged = execSync('git diff --cached --name-only', { encoding: 'utf8' })
		.split('\n')
		.filter(Boolean);

	const result = checkCommitMessage(rawMessage, staged);
	if (!result.ok) {
		console.error(`\ncommit rejected: ${result.error}\n`);
		console.error(
			'Every code commit must acknowledge the docs-alignment pass (AGENTS.md § Keeping docs in sync with code).',
		);
		console.error('Re-read the docs pages describing what you changed, then add a trailer, e.g.:\n');
		console.error('  Docs-Checked: updated docs/reference/cli.md for the new --foo flag');
		console.error(
			'  Docs-Checked: verified docs/concepts/tasks.md still matches; no other doc surface affected',
		);
		console.error('  Docs-Checked: internal refactor, no user-visible behaviour or documented surface changed\n');
		process.exit(1);
	}
}

if (import.meta.main) main();
