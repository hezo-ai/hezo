import { createFileRoute } from '@tanstack/react-router';
import { IssueList } from '../../../../components/issue-list';

function IssueListPage() {
	const { teamId } = Route.useParams();
	return <IssueList teamId={teamId} />;
}

export const Route = createFileRoute('/teams/$teamId/issues/')({
	component: IssueListPage,
});
