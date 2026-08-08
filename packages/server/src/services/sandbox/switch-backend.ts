/**
 * Switching the instance from one container backend to another, at runtime.
 *
 * The order here is the whole design, and it is not the obvious one. Destroying
 * containers comes **before** the swap, because after it their ids belong to a
 * backend nothing will ever ask again: the pool, the orphan sweep and every
 * lifecycle call go through the current engine, so a container left behind on
 * the outgoing backend is unreachable by anything that could clean it up. On a
 * paid provider that is a bill with no surface in the product.
 *
 * And the preflight comes before *both*, because a switch that fails halfway is
 * worse than one that does not start: the operator would have lost every running
 * container and gained a backend that cannot be reached. Validate the credential
 * first, destroy only once the destination is known good.
 *
 * In-flight runs die with their containers, through the same container-death
 * path a crash takes, and are reported on each project's Container page. That is
 * a deliberate choice the confirmation dialog states up front rather than a
 * consequence discovered afterwards - and it is why the route reports the counts
 * before the operator commits.
 */

import { type SandboxBackend, sandboxBackendNeedsApiKey } from '@hezo/shared';
import type { MasterKeyManager } from '../../crypto/master-key';
import type { Db } from '../../db/database';
import { logger } from '../../logger';
import { getOrCreateInstanceId } from '../telemetry';
import {
	setStoredDaytonaApiUrl,
	setStoredSandboxBackend,
	storeDaytonaApiKey,
} from './backend-store';
import { SandboxBackendError } from './errors';
import type { SandboxBackendHolder } from './holder';
import { INSTANCE_LABEL } from './labels';
import { openSandboxBackend } from './open';
import type { ContainerEngine } from './types';

const log = logger.child('sandbox-switch');

/**
 * The containers **this instance** owns on the current backend, or none when the
 * backend cannot answer.
 *
 * Scoped on `hezo.instance`, which is the only label that names an owner. It
 * used to query the bare key `hezo.project`, and on Daytona a bare key has no
 * server-side equivalent at all - the adapter falls back to listing *every*
 * sandbox in the account and filtering on the key's presence, which every Hezo
 * container everywhere carries. Switching backends therefore destroyed another
 * instance's live sandboxes, which is precisely what labelling by instance
 * exists to prevent.
 *
 * The tolerance is the point, and it is needed on both call sites: an operator
 * whose backend is unreachable - a dead provider key, a stopped daemon, a
 * deferred open that failed - must still be able to load the Containers page
 * and switch away from it. A backend that cannot be listed has containers
 * nothing can do anything about either way.
 *
 * try/catch rather than `.catch()` because a pending engine throws
 * **synchronously**, so a rejection handler on the returned promise never runs.
 */
async function listOwnedContainers(
	engine: ContainerEngine,
	instanceId: string,
): Promise<Array<{ Id: string }>> {
	try {
		return await engine.listContainersByLabel(`${INSTANCE_LABEL}=${instanceId}`);
	} catch (e) {
		log.error(`could not list containers on the current backend: ${(e as Error).message}`);
		return [];
	}
}

export interface SwitchImpact {
	/** Containers that will be destroyed. */
	containers: number;
	/** Agent runs that will die with them. */
	activeRuns: number;
}

/**
 * What a switch would cost right now, so the operator confirms against real
 * numbers rather than a generic warning.
 */
export async function describeSwitchImpact(
	db: Db,
	engine: ContainerEngine,
	dataDir: string,
): Promise<SwitchImpact> {
	const instanceId = await getOrCreateInstanceId(db, dataDir);
	const [owned, runs] = await Promise.all([
		// Wrapped rather than `.catch()`-ed for the same reason as `destroyAll`: a
		// pending engine (deferred open that failed) throws synchronously, and this
		// runs on every load of the Containers page - so the throw escaping here
		// took out the very page the operator needs in order to switch away.
		listOwnedContainers(engine, instanceId),
		db.query<{ n: number }>(
			`SELECT COUNT(*)::int AS n FROM heartbeat_runs WHERE status IN ('queued', 'running')`,
		),
	]);
	return { containers: owned.length, activeRuns: runs.rows[0]?.n ?? 0 };
}

/**
 * Destroy every container the outgoing backend is running, and forget them.
 *
 * Asked of the **engine** by label rather than read from the database, so a
 * container the database lost track of goes too - which is exactly the state a
 * crash mid-provision leaves behind, and the last moment anything will be able
 * to see it.
 */
async function destroyAll(db: Db, engine: ContainerEngine, dataDir: string): Promise<number> {
	// Tolerates a backend that cannot be listed, which is exactly the state an
	// operator switching away from a broken backend is in.
	const owned = await listOwnedContainers(engine, await getOrCreateInstanceId(db, dataDir));
	let destroyed = 0;
	for (const c of owned) {
		try {
			await engine.removeContainer(c.Id, true);
			destroyed += 1;
		} catch (e) {
			log.error(`could not destroy ${c.Id} while switching backends: ${(e as Error).message}`);
		}
	}
	// The records go regardless of whether each destroy succeeded: they name
	// containers on a backend this instance is about to stop talking to, so
	// keeping them would leave the pool handing out ids that resolve to nothing.
	await db.query('DELETE FROM container_pool_members');
	await db.query(
		`UPDATE projects SET container_id = NULL, container_status = NULL
		  WHERE container_id IS NOT NULL OR container_status IS NOT NULL`,
	);
	return destroyed;
}

export interface SwitchRequest {
	backend: SandboxBackend;
	/** Required when switching *to* a provider that has no stored credential. */
	daytonaApiKey?: string;
	daytonaApiUrl?: string;
}

export interface SwitchResult {
	containersDestroyed: number;
	backend: SandboxBackend;
}

/**
 * Preflight the destination, tear down the outgoing backend, then swap.
 *
 * Throws {@link SandboxBackendError} when the destination cannot be reached or
 * is missing a credential - before anything has been destroyed, so a failed
 * switch is a no-op rather than a half-migrated instance.
 */
export async function switchSandboxBackend(
	db: Db,
	masterKeyManager: MasterKeyManager,
	holder: SandboxBackendHolder,
	req: SwitchRequest,
	resolveExistingKey: () => Promise<string | null>,
	dataDir: string,
): Promise<SwitchResult> {
	// Asked of the destination's *kind*, not its name: every remote backend is
	// reached with an account credential, and the local daemon needs none.
	const apiKey = sandboxBackendNeedsApiKey(req.backend)
		? ((req.daytonaApiKey?.trim() || (await resolveExistingKey())) ?? undefined)
		: undefined;

	// Opening the destination *is* the preflight - `openSandboxBackend` pings and
	// retries, and throws a named error when it cannot connect. Reusing it rather
	// than writing a second reachability check keeps one definition of "this
	// backend is usable".
	const opened = await openSandboxBackend({
		backend: req.backend,
		daytonaApiKey: apiKey,
		daytonaApiUrl: req.daytonaApiUrl?.trim() || undefined,
	});

	if (holder.backend === req.backend) {
		// Same backend, new credential or endpoint: rotate without destroying
		// anything. Tearing down a fleet the operator did not ask to move would be
		// a surprise, and the containers are still valid.
		if (req.daytonaApiKey?.trim()) {
			await storeDaytonaApiKey(db, masterKeyManager, req.daytonaApiKey.trim());
		}
		if (req.daytonaApiUrl !== undefined) await setStoredDaytonaApiUrl(db, req.daytonaApiUrl.trim());
		await holder.swap(opened);
		return { containersDestroyed: 0, backend: req.backend };
	}

	const containersDestroyed = await destroyAll(db, holder.engine, dataDir);

	if (req.daytonaApiKey?.trim()) {
		await storeDaytonaApiKey(db, masterKeyManager, req.daytonaApiKey.trim());
	}
	if (req.daytonaApiUrl !== undefined) await setStoredDaytonaApiUrl(db, req.daytonaApiUrl.trim());
	await setStoredSandboxBackend(db, req.backend);

	// The swap prepares the incoming backend's host state, which a switch never
	// did: an instance that booted on a managed provider and moved to the local
	// daemon reached it with no extracted build context, no bundled-image prune
	// and no bind-mount probe - all of which only ever ran at startup, for
	// whichever backend happened to be selected then.
	await holder.swap(opened);
	log.info(`switched to ${req.backend}, destroying ${containersDestroyed} container(s) on the way`);
	return { containersDestroyed, backend: req.backend };
}

export { SandboxBackendError };
