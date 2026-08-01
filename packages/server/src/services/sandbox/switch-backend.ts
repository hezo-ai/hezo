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

import { SandboxBackend } from '@hezo/shared';
import type { MasterKeyManager } from '../../crypto/master-key';
import type { Db } from '../../db/database';
import { logger } from '../../logger';
import {
	setStoredDaytonaApiUrl,
	setStoredSandboxBackend,
	storeDaytonaApiKey,
} from './backend-store';
import { SandboxBackendError } from './errors';
import type { SandboxBackendHolder } from './holder';
import { openSandboxBackend } from './open';
import type { ContainerEngine } from './types';

const log = logger.child('sandbox-switch');

/** Every container Hezo owns carries this, whichever backend created it. */
const HEZO_OWNED_LABEL = 'hezo.project';

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
export async function describeSwitchImpact(db: Db, engine: ContainerEngine): Promise<SwitchImpact> {
	const [owned, runs] = await Promise.all([
		engine.listContainersByLabel(HEZO_OWNED_LABEL).catch(() => []),
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
async function destroyAll(db: Db, engine: ContainerEngine): Promise<number> {
	const owned = await engine.listContainersByLabel(HEZO_OWNED_LABEL).catch((e) => {
		// If the outgoing backend cannot even be listed there is nothing to be
		// done about its containers, and blocking the switch would strand the
		// operator on a backend that is already broken. Loud, then continue.
		log.error(`could not list containers on the outgoing backend: ${(e as Error).message}`);
		return [] as Array<{ Id: string }>;
	});
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
): Promise<SwitchResult> {
	const apiKey =
		req.backend === SandboxBackend.Daytona
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
		holder.swap(opened);
		return { containersDestroyed: 0, backend: req.backend };
	}

	const containersDestroyed = await destroyAll(db, holder.engine);

	if (req.daytonaApiKey?.trim()) {
		await storeDaytonaApiKey(db, masterKeyManager, req.daytonaApiKey.trim());
	}
	if (req.daytonaApiUrl !== undefined) await setStoredDaytonaApiUrl(db, req.daytonaApiUrl.trim());
	await setStoredSandboxBackend(db, req.backend);

	holder.swap(opened);
	log.info(`switched to ${req.backend}, destroying ${containersDestroyed} container(s) on the way`);
	return { containersDestroyed, backend: req.backend };
}

export { SandboxBackendError };
