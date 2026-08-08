import { createFileRoute, redirect } from '@tanstack/react-router';

/** Redirect stub for the pre-nesting goal URL — see `goals/index.tsx`. */
export const Route = createFileRoute('/projects/$projectId/goals/$goalId')({
	beforeLoad: ({ params }) => {
		throw redirect({
			to: '/projects/$projectId/progress/goals/$goalId',
			params: { projectId: params.projectId, goalId: params.goalId },
			replace: true,
		});
	},
});
