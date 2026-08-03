import { Hono } from 'hono';
import type { Db } from '../db/database';
import { buildContainerDeps } from '../lib/container-deps';
import { err, ok } from '../lib/response';
import { getDefaultRamCapPerContainerGb } from '../lib/system-meta';
import type { Env } from '../lib/types';
import { requireSuperuser } from '../middleware/auth';
import { destroyContainer } from '../services/containers';
import {
	type ContainerListing,
	getContainerListing,
	listAllContainers,
} from '../services/sandbox/pool-db';

/**
 * The containers an instance is running, listed and removed globally.
 *
 * **Global rather than per-project, because that is what a container is now.** A
 * project holds as many containers as it has concurrent runs, and
 * `projects.container_id` names only the newest of them - so a per-project view
 * could only ever describe one container, without being able to say which. The
 * question an operator actually has ("what is running, whose is it, is anything
 * stuck") is instance-wide, and so is the answer.
 *
 * **Superuser-only.** This crosses every project on the instance, so a board
 * user scoped to one team must not reach it - the per-team gate that protects
 * `/api/projects/:projectId/...` has nothing to check here. Same gate as the
 * settings page it backs.
 *
 * There is no start, stop or rebuild. Rebuild meant "replace this project's
 * containers", which stopped meaning anything once there were several; a
 * container that has wedged is one container, and removing it is the fix. The
 * pool provisions a replacement on the next run that needs one, which is the
 * path every container already takes.
 */
export function buildContainerRoutes(): Hono<Env> {
	const routes = new Hono<Env>();

	routes.get('/containers', async (c) => {
		const denied = requireSuperuser(c);
		if (denied) return denied;
		const db = c.get('db');
		return ok(c, await listAllContainers(db, await getDefaultRamCapPerContainerGb(db)));
	});

	routes.get('/containers/:containerId', async (c) => {
		const denied = requireSuperuser(c);
		if (denied) return denied;
		const container = await loadContainer(c.get('db'), c.req.param('containerId'));
		if (!container) return err(c, 'NOT_FOUND', 'Container not found', 404);
		return ok(c, container);
	});

	routes.delete('/containers/:containerId', async (c) => {
		const denied = requireSuperuser(c);
		if (denied) return denied;
		const db = c.get('db');
		const containerId = c.req.param('containerId');

		// Resolved through the listing rather than trusting the path param: it is
		// what proves this instance owns the container at all, and it carries the
		// project the teardown has to be scoped to.
		const container = await loadContainer(db, containerId);
		if (!container) return err(c, 'NOT_FOUND', 'Container not found', 404);

		const team = await db.query<{ team_id: string }>('SELECT team_id FROM projects WHERE id = $1', [
			container.project_id,
		]);
		const teamId = team.rows[0]?.team_id;
		if (!teamId) return err(c, 'NOT_FOUND', 'Container not found', 404);

		// Awaited rather than backgrounded: the client refetches the list the moment
		// this responds, and a removal still in flight would hand back the very row
		// it just deleted. Tearing down one container is a couple of engine calls,
		// not the minutes a provision takes.
		await destroyContainer(
			buildContainerDeps(c),
			container.project_id,
			container.project_slug,
			teamId,
			containerId,
		);
		return ok(c, { container_id: containerId, removed: true });
	});

	return routes;
}

/** One container, with the instance default resolved so callers state it once. */
async function loadContainer(db: Db, containerId: string): Promise<ContainerListing | null> {
	return getContainerListing(db, await getDefaultRamCapPerContainerGb(db), containerId);
}
