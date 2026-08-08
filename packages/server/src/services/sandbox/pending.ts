/**
 * The engine an instance holds while its backend cannot be opened yet.
 *
 * An instance comes back **locked** after every restart - the master key is
 * memory-only, which is what makes encryption at rest mean anything - so a
 * provider credential that lives only in the encrypted vault is unreadable at
 * the moment the backend would otherwise be opened. Two non-options bracket
 * this: failing the boot would mean a managed backend cannot survive a restart
 * at all (the operator would have to pass the master key on the command line
 * every time, which is the one thing we never ask for), and opening local
 * Docker instead would be exactly the silent fallback this directory exists to
 * prevent. So the holder starts on this, and the unlock swaps in the real
 * engine.
 *
 * Nothing legitimate reaches it. Everything that drives the engine - the job
 * manager, the chat manager, the HQ warm-up, the orphan sweep - already starts
 * on that same unlock, because a locked instance cannot run an agent whichever
 * backend it is on. A call that does arrive is a bug, and it gets a named,
 * actionable error rather than a `TypeError` on an undefined method.
 */

import { SandboxBackendError } from './errors';
import type { ContainerEngine } from './types';

/**
 * An engine whose every operation reports {@link SandboxBackendError}.
 *
 * Built as a `Proxy`, where {@link SandboxBackendHolder} deliberately
 * hand-writes its delegation. The reasoning inverts rather than conflicts: the
 * holder spells out every member so that adding one to `ContainerEngine`
 * becomes a build error there instead of a `TypeError` in production, whereas
 * this engine's entire contract is "every member throws" - a trap answers a
 * member added tomorrow correctly and for free, while a hand-written copy would
 * silently stop covering it.
 */
export function createPendingEngine(message: string): ContainerEngine {
	return new Proxy({} as ContainerEngine, {
		get(target, prop, receiver) {
			// Answer probes from the plain-object target rather than with undefined:
			// suppressing `toString`/`valueOf` outright leaves the value impossible to
			// coerce, so `String(engine)` traded the misleading error for a
			// `TypeError` instead of behaving like the ordinary object it stands in for.
			if (typeof prop !== 'string' || PROBE_KEYS.has(prop)) {
				return Reflect.get(target, prop, receiver);
			}
			return () => {
				throw new SandboxBackendError(message);
			};
		},
	});
}

/**
 * How a *runtime* inspects a value rather than how our code calls one: awaiting
 * it, coercing it to a string, serializing it, logging it. Throwing on these
 * would surface the backend error from somewhere entirely unrelated - a
 * `log.info` of the engine would raise "the instance is locked" - so they answer
 * undefined and let the inspection proceed.
 *
 * Everything else throws, deliberately including members added to
 * `ContainerEngine` after this was written: this list is the JavaScript object
 * protocol, which is closed, so it cannot drift as our interface grows.
 * (Symbol keys - `Symbol.toPrimitive`, `Symbol.toStringTag`, Node's
 * `util.inspect.custom` - are excluded wholesale by the type check above.)
 */
const PROBE_KEYS = new Set(['then', 'toString', 'valueOf', 'toJSON', 'constructor', 'inspect']);

/** Why the backend is not open yet, phrased as something the operator can act on. */
export function pendingUnlockMessage(display: string): string {
	return (
		`The container backend (${display}) is configured but not connected yet: its API key is ` +
		'in the encrypted vault, and the instance is locked.\n' +
		'Unlock the instance to finish connecting. Agent runs do not start while locked, so ' +
		'nothing is waiting on this.'
	);
}
