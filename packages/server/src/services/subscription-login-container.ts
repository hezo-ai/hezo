import { randomBytes } from 'node:crypto';
import type { Db } from '../db/database';
import { logger } from '../logger';
import { ensureImage } from './ensure-image';
import { MANAGED_AGENT_BASE_IMAGE, resolveAgentBaseImage } from './image-registry';
import { INSTANCE_LABEL } from './sandbox/labels';
import type { ContainerEngine } from './sandbox/types';
import { getOrCreateInstanceId } from './telemetry';

const log = logger.child('subscription-login');

/**
 * The throwaway container a guided sign-in runs in.
 *
 * Deliberately **not** a pooled run container. It has no task, no project and no
 * workspace; it exists to run one vendor CLI for a couple of minutes and is
 * destroyed the moment the credential is harvested. Borrowing a pooled member
 * would put a credential-minting process inside a container an agent also runs
 * in, and would tie a sign-in to a project it has nothing to do with - the
 * credential is global.
 */

/** Marks every container this module creates, so the sweep below can find them. */
export const LOGIN_CONTAINER_LABEL = 'hezo.subscription-login';

/**
 * Nothing here rides the egress proxy, and that is not an oversight.
 *
 * The proxy exists to substitute `__HEZO_SECRET_<NAME>__` placeholders into
 * requests an agent emits. A sign-in emits none: the CLI talks to its own
 * vendor's auth host and mints a credential that does not exist yet. That host
 * is the model provider's own endpoint, which AGENTS.md already exempts from
 * MITM for exactly this reason - so a login container is the documented direct
 * case, not a new exception to it.
 *
 * Standing up a per-run proxy and tunnel to carry traffic that has nothing to
 * substitute would add a failure mode (a tunnel that cannot bind fails the run)
 * to a flow whose entire purpose is to be easier than pasting a file.
 */

export interface LoginContainer {
	containerId: string;
	/** Idempotent; safe to call from any exit path. */
	teardown: () => Promise<void>;
}

/**
 * Create and start a container for one sign-in.
 *
 * The image is the same agent-base every run uses, because the vendor CLIs are
 * baked into it - a login must run the same binary a run will later
 * authenticate with, or it could mint a credential in a shape that binary does
 * not read.
 */
export async function acquireLoginContainer(
	docker: ContainerEngine,
	db: Db,
	dataDir: string,
): Promise<LoginContainer> {
	const { image, preferPull } = resolveAgentBaseImage(MANAGED_AGENT_BASE_IMAGE);
	await ensureImage(docker, image, { preferPull });

	const instanceId = await getOrCreateInstanceId(db, dataDir);
	const name = `hezo-login-${randomBytes(6).toString('hex')}`;
	const { Id } = await docker.createContainer(name, {
		Image: image,
		Cmd: ['sleep', 'infinity'],
		Env: [],
		WorkingDir: '/workspace',
		Labels: {
			// The label's VALUE is the instance id, not a bare marker, so the sweep
			// below scopes itself in the label query rather than inspecting every
			// container it finds and reading a label off the result. Several Hezo
			// instances can share one managed-backend account.
			[LOGIN_CONTAINER_LABEL]: instanceId,
			[INSTANCE_LABEL]: instanceId,
		},
		HostConfig: {
			Init: true,
			CapDrop: ['ALL'],
		},
	});

	let torn = false;
	const teardown = async () => {
		if (torn) return;
		torn = true;
		await docker.removeContainer(Id, true).catch((e: unknown) => {
			// Not fatal: `sweepLoginContainers` collects anything left behind, and
			// the flow's outcome is already decided by the time teardown runs.
			log.warn(`could not remove login container ${Id}: ${String(e)}`);
		});
	};

	try {
		await docker.startContainer(Id);
	} catch (e) {
		await teardown();
		throw e;
	}

	return { containerId: Id, teardown };
}

/**
 * Remove login containers left behind by a process that died mid-flow.
 *
 * The registry holding a flow's teardown is in memory, so a crash or restart
 * between creating a container and harvesting its credential strands it. Scoped
 * by label **and** by instance id, so several Hezo instances sharing one managed
 * backend never sweep each other's containers.
 */
export async function sweepLoginContainers(
	docker: ContainerEngine,
	db: Db,
	dataDir: string,
): Promise<number> {
	const instanceId = await getOrCreateInstanceId(db, dataDir);
	// Scoped in the query itself - another instance's containers never come back.
	const found = await docker
		.listContainersByLabel(`${LOGIN_CONTAINER_LABEL}=${instanceId}`)
		.catch(() => [] as Array<{ Id: string; Names: string[] }>);

	let removed = 0;
	for (const { Id } of found) {
		await docker.removeContainer(Id, true).catch(() => undefined);
		removed++;
	}
	if (removed > 0) log.info(`swept ${removed} stranded sign-in container(s)`);
	return removed;
}
