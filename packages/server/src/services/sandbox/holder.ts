/**
 * The one place the *current* container engine lives, and the stable handle
 * everything else holds instead of an engine.
 *
 * The backend used to be chosen at startup and fixed for the life of the
 * process, which let every consumer capture the concrete engine: `c.set('docker')`,
 * `JobManager`'s deps, the chat manager, the process sweeper. Making it
 * switchable at runtime turns each of those captures into a hazard - a
 * reference taken before a switch keeps operating the *old* backend, so a run
 * dispatched afterwards would provision on the provider the operator just left,
 * and nothing would say so.
 *
 * So the swap does not travel. `SandboxBackendHolder.engine` is a single proxy
 * created once at startup and handed out everywhere; re-pointing the holder
 * changes what that proxy delegates to, and every existing call site follows
 * without knowing a switch happened. The alternative - threading a getter
 * through every consumer - is the same change spread across a dozen files, with
 * the one that gets missed failing silently.
 *
 * **The proxy is not a fallback mechanism.** It swaps *which* backend is
 * current; it never picks a second one because the first is unavailable. A
 * backend that cannot be reached still fails the operation, exactly as before
 * (see `SandboxBackendError`).
 */

import type { SandboxBackend } from '@hezo/shared';
import type { SandboxBackendInfo } from '../../lib/sandbox-backend-info';
import { logger } from '../../logger';
import type { ContainerEngine } from './types';

const log = logger.child('sandbox-backend');

/** The engine and the metadata that describes it, swapped together. */
interface Current {
	engine: ContainerEngine;
	info: SandboxBackendInfo;
}

export class SandboxBackendHolder {
	private current: Current;

	/**
	 * The handle every consumer keeps.
	 *
	 * Built once in the constructor rather than per access, so a consumer that
	 * stores it (all of them do) stores something that stays live. Every method
	 * reads `this.current.engine` at call time.
	 */
	readonly engine: ContainerEngine;

	constructor(initial: Current) {
		this.current = initial;
		this.engine = this.buildProxy();
	}

	get info(): SandboxBackendInfo {
		return this.current.info;
	}

	get backend(): SandboxBackend {
		return this.current.info.backend;
	}

	/**
	 * Point the holder at a different backend.
	 *
	 * Deliberately does **not** touch containers. Destroying what the outgoing
	 * backend was running is the caller's job and happens *before* this is
	 * called, because a swap that left them behind would orphan every one of
	 * them: their ids live in a database the new backend knows nothing about, and
	 * the orphan sweep only ever asks the *current* engine. On a paid provider
	 * that is an invisible bill.
	 */
	swap(next: Current): void {
		const from = this.current.info.backend;
		this.current = next;
		log.info(`Sandbox backend switched: ${from} -> ${next.info.backend} (${next.info.display})`);
	}

	/**
	 * Delegate every `ContainerEngine` member to whatever is current.
	 *
	 * Written as an explicit object rather than a `Proxy`: the compiler then
	 * checks the surface is complete, so a method added to the interface is a
	 * build error here instead of a `TypeError` the first time production calls
	 * it. That failure mode is not hypothetical - it is what adding
	 * `containerHostMemory()` did to six hand-rolled test stubs.
	 */
	private buildProxy(): ContainerEngine {
		const e = () => this.current.engine;
		return {
			ping: (...a) => e().ping(...a),
			imageExists: (...a) => e().imageExists(...a),
			inspectImage: (...a) => e().inspectImage(...a),
			removeImage: (...a) => e().removeImage(...a),
			pullImage: (...a) => e().pullImage(...a),
			inspectNetwork: (...a) => e().inspectNetwork(...a),
			createContainer: (...a) => e().createContainer(...a),
			startContainer: (...a) => e().startContainer(...a),
			stopContainer: (...a) => e().stopContainer(...a),
			removeContainer: (...a) => e().removeContainer(...a),
			inspectContainer: (...a) => e().inspectContainer(...a),
			listContainersByLabel: (...a) => e().listContainersByLabel(...a),
			findContainerByNamePrefix: (...a) => e().findContainerByNamePrefix(...a),
			containerStats: (...a) => e().containerStats(...a),
			containerLogs: (...a) => e().containerLogs(...a),
			execCreate: (...a) => e().execCreate(...a),
			openExecChannel: (...a) => e().openExecChannel(...a),
			execStart: (...a) => e().execStart(...a),
			execInspect: (...a) => e().execInspect(...a),
			killProcessesByEnvMarker: (...a) => e().killProcessesByEnvMarker(...a),
			killRunProcesses: (...a) => e().killRunProcesses(...a),
			listHezoProcesses: (...a) => e().listHezoProcesses(...a),
			killPids: (...a) => e().killPids(...a),
			diskUsedBytes: (...a) => e().diskUsedBytes(...a),
			containerHostMemory: () => e().containerHostMemory(),
			files: (...a) => e().files(...a),
		};
	}
}
