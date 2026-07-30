// Commit-msg guard: every commit that touches a string-bearing surface must
// carry a `Translations-Checked:` trailer acknowledging the translation-cascade
// pass (AGENTS.md § Translations).
//
// The web app renders in twelve languages from hand-authored catalogs under
// packages/web/src/lib/i18n/catalog/. `en.json` is the source of truth, so a
// new or reworded English string is only half a change: the other eleven
// catalogs need the same key, translated. The failure mode is omission — a key
// added to en.json and copy-pasted unchanged into the rest, which renders
// English inside an otherwise translated screen. `i18n-catalog.test.ts` catches
// the mechanical half (missing keys, values left identical to English); this
// trailer is the record that the judgement half happened.
//
// Machinery is shared with the Docs-Checked hook — see scripts/commit-ack.ts.
// Pure functions here are unit-tested in
// packages/server/test/translations-ack-hook.test.ts.
import { type AckRule, bearingFiles, checkAck, runAckHook, summarizeBearing } from './commit-ack';

/**
 * Path prefixes whose changes can add or reword a user-facing string.
 *
 * `packages/web/src/` covers both the components that call `t()` and the
 * catalogs themselves; `packages/shared/src/` covers the English label maps
 * (TASK_STATUS_LABELS and friends) that the catalogs fall back to. The server
 * is absent on purpose: it renders no operator-facing UI copy, and its
 * agent-facing prose is English by policy.
 */
export const STRING_BEARING_PATTERNS: RegExp[] = [
	/^packages\/web\/src\//,
	/^packages\/shared\/src\//,
];

export const TRANSLATIONS_ACK_RULE: AckRule = {
	trailer: 'Translations-Checked',
	patterns: STRING_BEARING_PATTERNS,
	missingMessage: (bearing) =>
		`This commit touches string-bearing code (${summarizeBearing(bearing)}) ` +
		'but has no Translations-Checked: trailer. A new or reworded English string has to ' +
		'cascade into all eleven non-English catalogs under packages/web/src/lib/i18n/catalog/.',
	emptyMessage: (value) =>
		`Translations-Checked value "${value}" is not a meaningful acknowledgment — state which keys you translated, or why no string changed.`,
	guidance: [
		'Every string change must cascade to all twelve catalogs (AGENTS.md § Translations).',
		'Add or reword the key in en.json, translate it into the other eleven, then record',
		'what you did, e.g.:\n',
		'  Translations-Checked: added settings.locale.* to all 12 catalogs',
		'  Translations-Checked: reworded onboarding.language.subtitle; retranslated in all 11 non-English catalogs',
		'  Translations-Checked: no user-facing strings added or changed; catalogs untouched',
	],
};

export function stringBearingFiles(stagedFiles: string[]): string[] {
	return bearingFiles(stagedFiles, STRING_BEARING_PATTERNS);
}

export function findTranslationsAckValue(message: string): string | null {
	const match = message.match(/^Translations-Checked:[ \t]*(.*)$/im);
	return match ? match[1].trim() : null;
}

export function checkCommitMessage(
	rawMessage: string,
	stagedFiles: string[],
): { ok: boolean; error?: string } {
	return checkAck(rawMessage, stagedFiles, TRANSLATIONS_ACK_RULE);
}

if (import.meta.main) runAckHook(TRANSLATIONS_ACK_RULE, 'check-translations-ack.ts');
