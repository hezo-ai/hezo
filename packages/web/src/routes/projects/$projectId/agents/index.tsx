import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * The team roster moved onto the Team & Budget page (its Team tab). This
 * redirect keeps every old link working - deep links, the hire form's
 * `?hire` back link - while the agent detail pages stay at
 * `/agents/$agentId` as the canonical member pages.
 */
export const Route = createFileRoute('/projects/$projectId/agents/')({
	validateSearch: (search: Record<string, unknown>): { hire?: boolean } => ({
		hire: search.hire === true || search.hire === 'true' ? true : undefined,
	}),
	beforeLoad: ({ params, search }) => {
		throw redirect({ to: '/projects/$projectId/budget/team', params, search, replace: true });
	},
});
