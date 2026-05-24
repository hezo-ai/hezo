import { DEFAULT_TEAM_SLUG } from '@hezo/shared';
import { useRouterState } from '@tanstack/react-router';

export function useRouteTeamId(): string {
	return useRouterState({
		select: (state) => {
			for (let i = state.matches.length - 1; i >= 0; i--) {
				const params = state.matches[i]?.params as Record<string, unknown> | undefined;
				const id = params?.teamId;
				if (typeof id === 'string' && id) return id;
			}
			return DEFAULT_TEAM_SLUG;
		},
	});
}
