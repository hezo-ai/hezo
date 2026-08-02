import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * Goals moved under Progress (`/progress/goals`) so the URL matches the menu and breadcrumb.
 * This keeps the old path working for bookmarks and for links already written into comments or
 * docs; it renders nothing and only redirects.
 */
export const Route = createFileRoute('/projects/$projectId/goals/')({
	beforeLoad: ({ params }) => {
		throw redirect({
			to: '/projects/$projectId/progress/goals',
			params: { projectId: params.projectId },
			replace: true,
		});
	},
});
