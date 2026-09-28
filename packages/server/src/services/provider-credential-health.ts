/**
 * What happens to a stored credential after a run died on the provider refusing
 * it.
 *
 * Without this a rejected credential keeps its `verified` badge forever: the run
 * fails `Permanent` and says so in its own log, but nothing writes that back to
 * the row, and selection filters on `status = 'verified'`. So the next run picks
 * the same dead credential, takes a container, and fails identically - once per
 * dispatch, indefinitely, with the settings page showing green throughout.
 *
 * Kept out of `ai-provider-keys.ts` (which owns the row and must not know how to
 * reach a provider) and out of `provider-catalog.ts` (which asks providers and
 * must not know there is a database). This is the join between them, and the one
 * place that decides a stored credential is dead.
 */

import {
	type AiAuthMethod,
	type AiProvider,
	type AllowancePace,
	allowancePace,
	englishCount,
	type ProviderAllowance,
} from '@hezo/shared';
import type { MasterKeyManager } from '../crypto/master-key';
import type { Db } from '../db/database';
import {
	casMarkAiProviderInvalid,
	clearUsageHold,
	readActiveUsageHold,
	readOrClaimUsageHold,
	recordUsageHold,
} from './ai-provider-keys';
import { probeProvesCredentialDead, probeProviderCatalog } from './provider-catalog';
import { releaseUsageHeldWakeups } from './wakeup';

/**
 * What became of the credential a refused run was using.
 *
 * `not_proven` is the common and deliberate outcome, not a failure: it says the
 * provider did not confirm the credential is dead, so the row is left exactly as
 * it was.
 */
export type CredentialCondemnation = 'condemned' | 'not_proven' | 'superseded';

export interface CondemnableCredential {
	configId: string;
	/** The value the run actually ran on - what the write below compares against. */
	value: string;
	authMethod: AiAuthMethod;
	baseUrl: string | null;
}

/**
 * Ask the provider whether the credential a failed run used is dead, and mark it
 * `invalid` if so.
 *
 * **The run's own error is the trigger, never the proof.** A run is classified
 * `auth` by matching its terminal message, and that match includes a bare `401` -
 * which an agent's own tool call against some unrelated API can produce just as
 * easily as a refused model request. Condemning an instance-wide credential on
 * that reading would let one agent's failed `curl` disable every team's runs. So
 * the verdict comes from asking the provider directly, on a request Hezo built,
 * and nothing else is allowed to write `invalid` here.
 *
 * Never throws: a run has already ended by the time this is called, and its
 * outcome does not change on whether the follow-up probe could be made.
 */
export async function condemnRejectedProviderCredential(
	db: Db,
	masterKeyManager: MasterKeyManager,
	provider: AiProvider,
	credential: CondemnableCredential,
): Promise<CredentialCondemnation> {
	const probe = await probeProviderCatalog(
		provider,
		credential.value,
		credential.baseUrl,
		credential.authMethod,
	);
	if (!probeProvesCredentialDead(probe)) return 'not_proven';

	// The compare inside is what keeps a slow run from condemning a credential the
	// operator replaced while it was still running - see `casMarkAiProviderInvalid`.
	const wrote = await casMarkAiProviderInvalid(
		db,
		masterKeyManager,
		credential.configId,
		credential.value,
	);
	if (wrote) return 'condemned';

	// It did not write, which covers both "an earlier run already condemned this"
	// and "the row now holds a different credential". Neither needs a notice and
	// neither is an error - the row already says what it should, or it is about a
	// credential this run never touched.
	return 'superseded';
}

/**
 * How long a credential is held when the provider refused it for a spent usage
 * allowance without saying when the allowance resets.
 */
export const USAGE_HOLD_UNSTATED_MIN = 30;

/**
 * The shortest hold. Without a floor, a stated reset that is already past - clock
 * skew, or a provider still refusing after its own reset time - releases every
 * held wakeup at once to be refused again at dispatch rate.
 */
export const USAGE_HOLD_FLOOR_MIN = 5;

/**
 * How long the one run testing a lapsed hold has to reach the provider before
 * another run may test it. Covers the lock wait, the container claim and the repo
 * sync that come before the provider call.
 */
export const USAGE_HOLD_PROBE_MIN = 10;

const MINUTE_MS = 60_000;

/**
 * A spent usage allowance belongs to the credential, not to one run or one
 * wakeup. Holding the credential is what stops every agent and task on it from
 * each claiming a container to learn the same thing: the hold is read with the
 * credential row before a run is created, so a held run costs a query, not a
 * container.
 *
 * Returns the hold time and whether this refusal started the hold, so a person is
 * told once per outage rather than once per refused run.
 */
export async function holdCredentialForUsageLimit(
	db: Db,
	configId: string,
	statedResetAt: Date | undefined,
	now = new Date(),
): Promise<{ until: Date; started: boolean }> {
	const stated = statedResetAt?.getTime() ?? now.getTime() + USAGE_HOLD_UNSTATED_MIN * MINUTE_MS;
	const until = new Date(Math.max(stated, now.getTime() + USAGE_HOLD_FLOOR_MIN * MINUTE_MS));
	const started = await recordUsageHold(db, configId, until);
	return { until, started };
}

/**
 * The time a run on this credential must wait until, or null when it may run now.
 *
 * `seen` is the hold read with the credential row, so a credential with no hold
 * costs no query here. A hold still in force holds the run. A lapsed hold lets
 * exactly one run through to test whether the allowance has reset: that run moves
 * the hold forward by the probe window, so the other runs reading the same lapsed
 * value wait behind it instead of all being refused together.
 */
export async function usageHoldWait(
	db: Db,
	configId: string,
	seen: Date | null,
): Promise<Date | null> {
	if (!seen) return null;
	const hold = await readOrClaimUsageHold(db, configId, USAGE_HOLD_PROBE_MIN);
	if (hold.claimed || hold.until === null) return null;
	if (hold.active) return hold.until;
	// Lapsed, but another run claimed the probe between the read and the move.
	return readActiveUsageHold(db, configId);
}

/**
 * Lift a credential's hold because a run on it got a turn, and let the work held
 * behind it dispatch. Writes nothing when no hold stands.
 */
export async function liftUsageHold(db: Db, configId: string): Promise<boolean> {
	if (!(await clearUsageHold(db, configId))) return false;
	await releaseUsageHeldWakeups(db, configId);
	return true;
}

/** A hold time as an operator reads it: minute precision, in UTC. */
export function formatUsageHold(until: Date): string {
	return `${until.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** Why a run on a held credential did not start, as its run record states it. */
export function describeUsageHold(until: Date): string {
	return `The provider subscription's usage limit is spent until ${formatUsageHold(until)}`;
}

/**
 * The longest a wakeup held for pacing waits before it checks the pace again.
 *
 * The line itself says when work may resume, but three things can move that time
 * earlier: the provider resetting the window, the operator resetting it by hand,
 * and the operator raising the daily share. Rechecking on this interval picks
 * each up without a release path of its own, at the cost of one credential read
 * per held wakeup per interval - no container, no run row.
 */
export const ALLOWANCE_PACE_RECHECK_MIN = 30;

/**
 * Where a credential stands against its pace line, and the time a run on it must
 * wait until, or null when it may run now.
 *
 * `allowance` and `dailySharePercent` are the values read with the credential row,
 * so a credential never reported costs nothing here.
 */
export function allowancePaceWait(
	allowance: ProviderAllowance | null,
	dailySharePercent: number | null,
	now = new Date(),
): { pace: AllowancePace; until: Date } | null {
	const pace = allowancePace(allowance, dailySharePercent, now);
	if (!pace?.holdUntil) return null;
	const recheck = now.getTime() + ALLOWANCE_PACE_RECHECK_MIN * MINUTE_MS;
	return { pace, until: new Date(Math.min(pace.holdUntil.getTime(), recheck)) };
}

/** A percent as an operator reads it: whole numbers, one decimal below ten. */
function formatPercent(value: number): string {
	return value < 10 ? value.toFixed(1) : englishCount(Math.round(value));
}

/** Why a run on a credential ahead of its pace did not start, as its run record states it. */
export function describeAllowancePace(pace: AllowancePace): string {
	return (
		`This credential has used ${formatPercent(pace.usedPercent)}% of its provider's usage window, ` +
		`ahead of the ${formatPercent(pace.limitPercent)}% its pace allows by now ` +
		`(${formatPercent(pace.dailySharePercent)}% a day). Agent work waits until ` +
		`${formatUsageHold(pace.holdUntil ?? pace.resetsAt)}; a person's Run now still runs`
	);
}
