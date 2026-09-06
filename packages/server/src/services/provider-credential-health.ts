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

import type { AiAuthMethod, AiProvider } from '@hezo/shared';
import type { MasterKeyManager } from '../crypto/master-key';
import type { Db } from '../db/database';
import { casMarkAiProviderInvalid } from './ai-provider-keys';
import { probeProvesCredentialDead, probeProviderCatalog } from './provider-catalog';

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
