import { createFileRoute } from '@tanstack/react-router';
import { IssueList } from '../../../../components/issue-list';

function IssueListPage() {
	const { companyId } = Route.useParams();
	return <IssueList companyId={companyId} />;
}

export const Route = createFileRoute('/companies/$companyId/issues/')({
	component: IssueListPage,
});
