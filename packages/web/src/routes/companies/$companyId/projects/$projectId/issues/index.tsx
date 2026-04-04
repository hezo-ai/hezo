import { createFileRoute } from '@tanstack/react-router';
import { IssueList } from '../../../../../../components/issue-list';
import { useProject } from '../../../../../../hooks/use-projects';

function ProjectIssueListPage() {
	const { companyId, projectId } = Route.useParams();
	const { data: project } = useProject(companyId, projectId);

	if (!project) return null;

	return <IssueList companyId={companyId} projectId={project.id} />;
}

export const Route = createFileRoute('/companies/$companyId/projects/$projectId/issues/')({
	component: ProjectIssueListPage,
});
