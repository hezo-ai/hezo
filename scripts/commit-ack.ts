// Shared machinery for the commit-msg acknowledgment hooks.
//
// Two rules ride on the same mechanism: `Docs-Checked:` (AGENTS.md § Keeping
// docs in sync with code) and `Translations-Checked:` (§ Translations). Both
// answer the same shape of question — "this commit staged files under paths
// that carry an obligation; did you discharge it?" — so the classification,
// message parsing, and CLI plumbing live here once and each rule contributes
// only its trailer name, its bearing paths, and its guidance text.
//
// Pure functions here are unit-tested in packages/server/test/docs-ack-hook.test.ts
// and translations-ack-hook.test.ts (same pattern as scripts/coverage — no
// DB/DOM needed).
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Trailer values that name-check a rule without actually acknowledging anything. */
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

export interface AckRule {
	/** Trailer key, without the colon (e.g. `Docs-Checked`). */
	trailer: string;
	/** Path prefixes whose changes carry this rule's obligation. */
	patterns: RegExp[];
	/** Rejection text for a commit that staged bearing files with no trailer. */
	missingMessage: (bearing: string[]) => string;
	/** Rejection text for a trailer present but not a real acknowledgment. */
	emptyMessage: (value: string) => string;
	/** Printed under the rejection: what the pass is, and example trailers. */
	guidance: string[];
}

export function bearingFiles(stagedFiles: string[], patterns: RegExp[]): string[] {
	return stagedFiles.filter((f) => patterns.some((p) => p.test(f)));
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

export function findAckValue(message: string, trailer: string): string | null {
	const match = message.match(new RegExp(`^${trailer}:[ \\t]*(.*)$`, 'im'));
	return match ? match[1].trim() : null;
}

/** True when the value is a rubber stamp rather than a record of a real pass. */
export function isBareAck(value: string): boolean {
	return value.length < MIN_ACK_LENGTH || BARE_VALUES.has(value.toLowerCase());
}

export function checkAck(
	rawMessage: string,
	stagedFiles: string[],
	rule: AckRule,
): { ok: boolean; error?: string } {
	const message = effectiveMessage(rawMessage);
	if (message.length === 0 || isExemptCommit(message)) return { ok: true };

	const bearing = bearingFiles(stagedFiles, rule.patterns);
	if (bearing.length === 0) return { ok: true };

	const value = findAckValue(message, rule.trailer);
	if (value === null) return { ok: false, error: rule.missingMessage(bearing) };
	if (isBareAck(value)) return { ok: false, error: rule.emptyMessage(value) };
	return { ok: true };
}

/** Render `foo.ts and 3 more` for a rejection message. */
export function summarizeBearing(bearing: string[]): string {
	return `${bearing[0]}${bearing.length > 1 ? ` and ${bearing.length - 1} more` : ''}`;
}

/** CLI entrypoint shared by every ack hook: read the message, check, exit. */
export function runAckHook(rule: AckRule, scriptName: string): void {
	const msgFile = process.argv[2];
	if (!msgFile) {
		console.error(`usage: bun scripts/${scriptName} <commit-msg-file>`);
		process.exit(2);
	}
	const rawMessage = readFileSync(msgFile, 'utf8');
	const staged = execSync('git diff --cached --name-only', { encoding: 'utf8' })
		.split('\n')
		.filter(Boolean);

	const result = checkAck(rawMessage, staged, rule);
	if (!result.ok) {
		console.error(`\ncommit rejected: ${result.error}\n`);
		for (const line of rule.guidance) console.error(line);
		console.error('');
		process.exit(1);
	}
}
