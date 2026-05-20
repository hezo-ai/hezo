import { createFileRoute } from '@tanstack/react-router';
import { IssueList } from '../../../../../../components/issue-list';
import { useProject } from '../../../../../../hooks/use-projects';

function ProjectIssueListPage() {
	const { teamId, projectId } = Route.useParams();
	const { data: project } = useProject(teamId, projectId);

	if (!project) return null;

	return <IssueList teamId={teamId} projectId={project.id} />;
}

export const Route = createFileRoute('/teams/$teamId/projects/$projectId/issues/')({
	component: ProjectIssueListPage,
});
