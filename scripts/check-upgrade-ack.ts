// Commit-msg guard: every commit that touches a surface an existing instance
// depends on must carry an `Upgrade-Checked:` trailer acknowledging the pass
// over in-place upgrades (AGENTS.md § Production upgrades).
//
// Nothing else in the repo can see this. Every test runs against a fresh
// instance built by the code under test, so a change that is self-consistent
// passes the whole suite while breaking every instance that upgrades onto it -
// a renamed config mechanism the old deployment still uses, a data path that
// moved, a supervisor that relaunches without the argument it now needs. The
// symptom is silence: the server starts, finds nothing where it looked, and
// presents itself as a brand-new install.
//
// The classification/parsing machinery is shared with the Docs-Checked,
// Translations-Checked and Prompts-Checked hooks — see scripts/commit-ack.ts.
// Pure functions here are unit-tested in
// packages/server/test/upgrade-ack-hook.test.ts.
import { type AckRule, bearingFiles, checkAck, runAckHook, summarizeBearing } from './commit-ack';

export { effectiveMessage, isExemptCommit } from './commit-ack';

/**
 * Path prefixes whose changes an already-running instance can be broken by:
 * how settings are resolved, where data lives and how it is read, how the
 * process starts and replaces itself, and what a deployment installs.
 *
 * Deliberately narrower than the doc-bearing list. A trailer demanded of every
 * commit is a trailer nobody reads, so ordinary feature work under
 * `services/`, `routes/` and the web package is absent: those ship with the
 * binary and carry nothing forward from the previous install.
 */
export const UPGRADE_BEARING_PATTERNS: RegExp[] = [
	/^packages\/server\/src\/config\//,
	/^packages\/server\/src\/db\//,
	/^packages\/[^/]+\/migrations\//,
	/^packages\/server\/src\/cli\.ts$/,
	/^packages\/server\/src\/index\.ts$/,
	/^packages\/server\/src\/startup\.ts$/,
	/^packages\/server\/src\/supervisor\.ts$/,
	/^packages\/server\/src\/services\/updater\.ts$/,
	/^deploy\//,
	/^docker\//,
];

export const UPGRADE_ACK_RULE: AckRule = {
	trailer: 'Upgrade-Checked',
	patterns: UPGRADE_BEARING_PATTERNS,
	missingMessage: (bearing) =>
		`This commit touches a surface existing instances depend on (${summarizeBearing(bearing)}) ` +
		'but has no Upgrade-Checked: trailer. State what happens to an instance running the ' +
		'previous release when it restarts onto this one.',
	emptyMessage: (value) =>
		`Upgrade-Checked value "${value}" is not a meaningful acknowledgment — say what an existing instance does on restart, or why nothing it holds is affected.`,
	guidance: [
		'Every commit here must acknowledge the in-place-upgrade pass (AGENTS.md § Production upgrades).',
		'Walk one running instance through the restart: it keeps its data directory, its config,',
		'its service definition and its database, and only the binary changes. Then add a trailer, e.g.:\n',
		'  Upgrade-Checked: the new key falls back to the old one when absent, so an instance that never writes a config file is unaffected',
		'  Upgrade-Checked: migration 072 backfills the column for existing rows; provision.sh rewrites the unit for hosts installed before it',
		'  Upgrade-Checked: reads nothing written by a previous release; an upgrading instance starts identically to a fresh one',
	],
};

export function upgradeBearingFiles(stagedFiles: string[]): string[] {
	return bearingFiles(stagedFiles, UPGRADE_BEARING_PATTERNS);
}

export function findUpgradeAckValue(message: string): string | null {
	// Kept as a named export because the trailer is part of the repo's contract,
	// not an implementation detail of the generic checker.
	const match = message.match(/^Upgrade-Checked:[ \t]*(.*)$/im);
	return match ? match[1].trim() : null;
}

export function checkCommitMessage(
	rawMessage: string,
	stagedFiles: string[],
): { ok: boolean; error?: string } {
	return checkAck(rawMessage, stagedFiles, UPGRADE_ACK_RULE);
}

if (import.meta.main) runAckHook(UPGRADE_ACK_RULE, 'check-upgrade-ack.ts');
