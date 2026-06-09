import { createFileRoute } from '@tanstack/react-router';
import { InboxView } from '../../../../components/inbox-view';

function InboxPage() {
	const { projectId } = Route.useParams();
	return <InboxView projectSlugs={[projectId]} scope="team" />;
}

export const Route = createFileRoute('/projects/$projectId/inbox/')({
	component: InboxPage,
});
