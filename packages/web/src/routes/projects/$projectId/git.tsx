import { HQ_PROJECT_SLUG } from '@hezo/shared';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { GitHubSection } from '../../../components/github-section';

function GitSettingsPage() {
	const { projectId } = Route.useParams();
	return (
		<div className="space-y-8">
			<GitHubSection projectId={projectId} />
		</div>
	);
}

export const Route = createFileRoute('/projects/$projectId/git')({
	beforeLoad: ({ params }) => {
		// Internal projects (slug `internal-<teamSlug>`) have no Git settings page.
		if (params.projectId === HQ_PROJECT_SLUG) {
			throw redirect({
				to: '/projects/$projectId/tasks',
				params,
				replace: true,
			});
		}
	},
	component: GitSettingsPage,
});
