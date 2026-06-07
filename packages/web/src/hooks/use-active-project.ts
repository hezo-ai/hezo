import { useResolvedTeam } from './use-projects';
import { useRouteProjectId } from './use-route-project-id';

export interface ActiveProject {
	slug: string;
	teamSlug: string;
}

/**
 * The project whose menu should be shown: the current route's project. Every
 * project-scoped surface (tasks, agents, inbox, settings) carries the project
 * slug in the route, so this reads straight from the route and resolves the
 * backing team from the index. Null on cross-project / instance routes, which
 * render full-width.
 */
export function useActiveProject(): ActiveProject | null {
	const projectId = useRouteProjectId();
	const team = useResolvedTeam(projectId ?? undefined);
	if (!projectId) return null;
	return { slug: projectId, teamSlug: team?.teamSlug ?? '' };
}
