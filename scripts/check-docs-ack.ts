// Commit-msg guard: every commit that touches a doc-bearing surface must carry
// a `Docs-Checked:` trailer acknowledging the docs-alignment pass (AGENTS.md
// § Commit gates). Hand-written prose (docs/**, READMEs,
// and the internal `.dev/` docs — architecture.md and the design notes) has no
// drift test, so the acknowledgment is the record that a human or agent
// actually re-read the affected pages — a commit without it is rejected by
// .husky/commit-msg. The pass covers BOTH audiences: the user-facing docs/
// tree and the internal `.dev/` docs (an architecture-altering change must
// update .dev/architecture.md in the same PR).
//
// The classification/parsing machinery is shared with the Translations-Checked
// hook — see scripts/commit-ack.ts. Pure functions here are unit-tested in
// packages/server/test/docs-ack-hook.test.ts.
import { type AckRule, bearingFiles, checkAck, runAckHook, summarizeBearing } from './commit-ack';

export { effectiveMessage, isExemptCommit } from './commit-ack';

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

export const DOCS_ACK_RULE: AckRule = {
	trailer: 'Docs-Checked',
	patterns: DOC_BEARING_PATTERNS,
	missingMessage: (bearing) =>
		`This commit touches doc-bearing code (${summarizeBearing(bearing)}) ` +
		'but has no Docs-Checked: trailer. The docs pass covers docs/**, the READMEs, ' +
		'AND the internal .dev/ docs (.dev/architecture.md for anything architecture-altering).',
	emptyMessage: (value) =>
		`Docs-Checked value "${value}" is not a meaningful acknowledgment — state which docs you updated or verified, or why none apply.`,
	guidance: [
		'Every code commit must acknowledge the docs-alignment pass (AGENTS.md § Commit gates).',
		'Re-read the doc pages describing what you changed — the user-facing docs/ tree AND the',
		'internal .dev/ docs (.dev/architecture.md must be updated in the same PR for any',
		'architecture-altering change) — then add a trailer, e.g.:\n',
		'  Docs-Checked: updated docs/reference/cli.md for the new --foo flag',
		'  Docs-Checked: updated .dev/architecture.md § Agent execution for the new run phase',
		'  Docs-Checked: verified docs/concepts/tasks.md and .dev/architecture.md still match; no other doc surface affected',
		'  Docs-Checked: internal refactor, no user-visible behaviour or documented surface changed',
	],
};

export function docBearingFiles(stagedFiles: string[]): string[] {
	return bearingFiles(stagedFiles, DOC_BEARING_PATTERNS);
}

export function findDocsAckValue(message: string): string | null {
	// Kept as a named export because the docs rule's trailer is part of the
	// repo's contract, not an implementation detail of the generic checker.
	const match = message.match(/^Docs-Checked:[ \t]*(.*)$/im);
	return match ? match[1].trim() : null;
}

export function checkCommitMessage(
	rawMessage: string,
	stagedFiles: string[],
): { ok: boolean; error?: string } {
	return checkAck(rawMessage, stagedFiles, DOCS_ACK_RULE);
}

if (import.meta.main) runAckHook(DOCS_ACK_RULE, 'check-docs-ack.ts');
