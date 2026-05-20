import { createFileRoute } from '@tanstack/react-router';
import { InboxView } from '../../../../components/inbox-view';

function InboxPage() {
	const { teamId } = Route.useParams();
	return <InboxView teamIds={[teamId]} scope="team" />;
}

export const Route = createFileRoute('/teams/$teamId/inbox/')({
	component: InboxPage,
});
