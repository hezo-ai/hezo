import {
	createContext,
	createElement,
	type ReactNode,
	useContext,
	useEffect,
	useState,
} from 'react';
import { useRouteProjectId } from './use-route-project-id';
import { useRouteTeamId } from './use-route-team-id';

interface ActiveProject {
	slug: string;
	teamSlug: string;
}

const ActiveProjectContext = createContext<{
	remembered: ActiveProject | null;
	remember: (p: ActiveProject) => void;
}>({ remembered: null, remember: () => {} });

/**
 * Remembers the last project the user navigated into so the persistent project
 * menu stays open across that project's team-scoped sub-pages (Agents, Inbox,
 * Settings) — which carry a teamId but no projectId in the route.
 */
export function ActiveProjectProvider({ children }: { children: ReactNode }) {
	const [remembered, setRemembered] = useState<ActiveProject | null>(null);
	return createElement(
		ActiveProjectContext.Provider,
		{ value: { remembered, remember: setRemembered } },
		children,
	);
}

/**
 * The project whose menu should be shown: the route's project when on a project
 * route, otherwise the remembered project when the current route belongs to its
 * team. Null on cross-team / instance routes, which render full-width.
 */
export function useActiveProject(): ActiveProject | null {
	const projectId = useRouteProjectId();
	const teamId = useRouteTeamId();
	const { remembered, remember } = useContext(ActiveProjectContext);

	useEffect(() => {
		if (projectId && (remembered?.slug !== projectId || remembered?.teamSlug !== teamId)) {
			remember({ slug: projectId, teamSlug: teamId });
		}
	}, [projectId, teamId, remembered, remember]);

	if (projectId) return { slug: projectId, teamSlug: teamId };
	if (remembered && remembered.teamSlug === teamId) return remembered;
	return null;
}
