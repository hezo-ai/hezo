// Commit-msg guard: every commit that touches agent-facing prose must carry a
// `Prompts-Checked:` trailer acknowledging the pass against the writing register
// (AGENTS.md § Layout, in full in .dev/writing-agent-prompts.md).
//
// The mechanical half is checked by scripts/check-prompt-style.ts, which runs
// alongside this in .husky/commit-msg. What that cannot see is the half this
// trailer records: whether the change states each rule once, at the reach that
// covers its audience. Nothing detects a rule quietly restated in a second
// surface until the two copies disagree - which is exactly how qa-engineer.md
// and engineer.md ended up with opposite models of the phased-merge protocol.
//
// The classification/parsing machinery is shared with the Docs-Checked and
// Translations-Checked hooks — see scripts/commit-ack.ts. Pure functions here
// are unit-tested in packages/server/test/prompts-ack-hook.test.ts.
import { type AckRule, bearingFiles, checkAck, runAckHook, summarizeBearing } from './commit-ack';

export { effectiveMessage, isExemptCommit } from './commit-ack';

/**
 * Path prefixes whose changes carry prompt-authoring obligations: the agent
 * role docs and partials, the shipped skills, the built marketplace teams, and
 * the runtime-resolved shared guidance. Tests and docs are deliberately absent.
 */
export const PROMPT_BEARING_PATTERNS: RegExp[] = [
	/^agents\//,
	/^skills\//,
	/^marketplace\//,
	/^packages\/server\/src\/services\/template-resolver\.ts$/,
];

export const PROMPTS_ACK_RULE: AckRule = {
	trailer: 'Prompts-Checked',
	patterns: PROMPT_BEARING_PATTERNS,
	missingMessage: (bearing) =>
		`This commit touches agent-facing prose (${summarizeBearing(bearing)}) ` +
		'but has no Prompts-Checked: trailer. The pass covers the writing register ' +
		'AND the check that no rule is now stated in two surfaces.',
	emptyMessage: (value) =>
		`Prompts-Checked value "${value}" is not a meaningful acknowledgment — state what you rewrote, or why the register and the reach rule are unaffected.`,
	guidance: [
		'Every prompt commit must acknowledge the writing-register pass (.dev/writing-agent-prompts.md).',
		'Re-read what you changed against the register, confirm each rule is stated once at the',
		'reach that covers its audience, then add a trailer, e.g.:\n',
		'  Prompts-Checked: rewrote SHARED_INSTRUCTIONS § Delegation to the register; no rule added or removed',
		'  Prompts-Checked: deleted the duplicated AGENTS.md bullet from 6 sw-dev docs; the rule now lives in _partials/common/repo-work.md',
		'  Prompts-Checked: role-specific edit, no shared guidance restated and no rule duplicated',
	],
};

export function promptBearingFiles(stagedFiles: string[]): string[] {
	return bearingFiles(stagedFiles, PROMPT_BEARING_PATTERNS);
}

export function findPromptsAckValue(message: string): string | null {
	// Kept as a named export because the trailer is part of the repo's contract,
	// not an implementation detail of the generic checker.
	const match = message.match(/^Prompts-Checked:[ \t]*(.*)$/im);
	return match ? match[1].trim() : null;
}

export function checkCommitMessage(
	rawMessage: string,
	stagedFiles: string[],
): { ok: boolean; error?: string } {
	return checkAck(rawMessage, stagedFiles, PROMPTS_ACK_RULE);
}

if (import.meta.main) runAckHook(PROMPTS_ACK_RULE, 'check-prompts-ack.ts');
