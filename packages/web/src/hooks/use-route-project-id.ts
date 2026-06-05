import { useRouterState } from '@tanstack/react-router';

/**
 * The current project slug from the deepest matched route param, or null when
 * the route is not scoped to a project. Mirrors useRouteTeamId; used to switch
 * the sidebar to its project-scoped variant.
 */
export function useRouteProjectId(): string | null {
	return useRouterState({
		select: (state) => {
			for (let i = state.matches.length - 1; i >= 0; i--) {
				const params = state.matches[i]?.params as Record<string, unknown> | undefined;
				const id = params?.projectId;
				if (typeof id === 'string' && id) return id;
			}
			return null;
		},
	});
}
