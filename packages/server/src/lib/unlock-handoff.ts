import type { MasterKeyManager } from '../crypto/master-key';
import type { Db } from '../db/database';
import { logger } from '../logger';

const log = logger.child('unlock-handoff');

/**
 * IPC handoff of the in-memory unlock key across an update restart.
 *
 * The supervisor is the only process that survives an update install (the
 * worker exits with the restart sentinel; the supervisor swaps the binary and
 * respawns). So the worker pushes its unlock key up to the supervisor on every
 * unlock, the supervisor holds it **in memory only**, and the freshly spawned
 * worker asks for it back when it boots locked. A missing or stale key leaves
 * the instance locked — exactly the pre-handoff behaviour — because the reply
 * still has to pass the master-key canary check.
 *
 * The key never touches disk, argv (visible in `ps`), or the environment
 * (inherited by every child spawn — the supervisor itself spreads
 * `process.env` into the worker); it moves only over the private IPC channel
 * between the two processes. A new process starts locked by default, this
 * supervised update can restore the key through the in-memory handoff, and a
 * deliberate direct startup can instead inject it from one-shot `--master-key`
 * or `HEZO_MASTER_KEY` input. Without either input path, a crash, direct service
 * restart or reboot comes up locked.
 *
 * The wire format is JSON (`serialization: 'json'` on the spawn) and must stay
 * backward compatible: after an update the supervisor still runs the OLD
 * binary's code while the worker runs the new one.
 */

export const UNLOCK_KEY_MESSAGE_TYPE = 'hezo:unlock-key';
export const UNLOCK_KEY_REQUEST_TYPE = 'hezo:request-unlock-key';

/** Worker → supervisor at unlock time; supervisor → worker as the request reply. */
export interface UnlockKeyMessage {
	type: typeof UNLOCK_KEY_MESSAGE_TYPE;
	unlockKeyHex: string;
}

/** Worker → supervisor on a locked boot: "send me the key if you hold one". */
export interface UnlockKeyRequest {
	type: typeof UNLOCK_KEY_REQUEST_TYPE;
}

export function unlockKeyMessage(unlockKeyHex: string): UnlockKeyMessage {
	return { type: UNLOCK_KEY_MESSAGE_TYPE, unlockKeyHex };
}

export function unlockKeyRequest(): UnlockKeyRequest {
	return { type: UNLOCK_KEY_REQUEST_TYPE };
}

export function isUnlockKeyMessage(message: unknown): message is UnlockKeyMessage {
	return (
		typeof message === 'object' &&
		message !== null &&
		(message as { type?: unknown }).type === UNLOCK_KEY_MESSAGE_TYPE &&
		typeof (message as { unlockKeyHex?: unknown }).unlockKeyHex === 'string'
	);
}

export function isUnlockKeyRequest(message: unknown): message is UnlockKeyRequest {
	return (
		typeof message === 'object' &&
		message !== null &&
		(message as { type?: unknown }).type === UNLOCK_KEY_REQUEST_TYPE
	);
}

export interface SupervisorUnlockKeyStore {
	/** Route one worker IPC message: store a pushed key, or answer a request. */
	handleMessage(message: unknown, reply: (message: UnlockKeyMessage) => void): void;
}

/**
 * Supervisor-side half: holds the last key a worker pushed, for the lifetime of
 * the supervisor process, and answers request messages with it. In memory only
 * — never logged, never written anywhere.
 */
export function createSupervisorUnlockKeyStore(): SupervisorUnlockKeyStore {
	let unlockKeyHex: string | null = null;
	return {
		handleMessage(message, reply) {
			if (isUnlockKeyMessage(message)) {
				unlockKeyHex = message.unlockKeyHex;
			} else if (isUnlockKeyRequest(message) && unlockKeyHex) {
				reply(unlockKeyMessage(unlockKeyHex));
			}
		},
	};
}

/** The slice of `process` the worker half uses; injectable for tests. */
export interface IpcEndpoint {
	send?: (message: unknown) => unknown;
	on(event: 'message', listener: (message: unknown) => void): unknown;
}

/**
 * Worker-side half, called once startup has completed. No-op without an IPC
 * channel (dev `bun run`, tests, a binary launched without the supervisor).
 *
 * - Pushes the unlock key to the supervisor on every unlock — including an
 *   immediate push when the worker booted already unlocked — so the supervisor
 *   always holds the current key for the *next* update restart.
 * - On a locked boot, requests the key back and unlocks with the reply. The
 *   canary check inside `unlock()` makes a stale key harmless.
 */
export function setupWorkerUnlockHandoff(
	target: { db: Db; masterKeyManager: MasterKeyManager },
	endpoint: IpcEndpoint = process,
): void {
	const send = endpoint.send?.bind(endpoint);
	if (!send) return;

	const { db, masterKeyManager } = target;

	masterKeyManager.onUnlock(() => {
		const key = masterKeyManager.getUnlockKeyHex();
		if (key) send(unlockKeyMessage(key));
	});

	if (masterKeyManager.getState() !== 'locked') return;

	endpoint.on('message', (message) => {
		if (!isUnlockKeyMessage(message)) return;
		if (masterKeyManager.getState() !== 'locked') return;
		masterKeyManager
			.unlock(db, message.unlockKeyHex)
			.then((ok) => {
				if (ok) log.info('Unlocked with the supervisor-held key after update restart');
				else log.warn('Supervisor-held unlock key is stale; instance stays locked');
			})
			.catch((err) => log.error('Unlock with the supervisor-held key failed:', err));
	});
	send(unlockKeyRequest());
}
