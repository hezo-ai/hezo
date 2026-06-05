import { createFileRoute } from '@tanstack/react-router';
import { InboxView } from '../../../components/inbox-view';
import { useTeams } from '../../../hooks/use-teams';

function GlobalInboxPage() {
	const { data: teams } = useTeams();
	const teamIds = (teams ?? []).map((t) => t.slug);
	return <InboxView teamIds={teamIds} scope="global" />;
}

export const Route = createFileRoute('/home/inbox/')({
	component: GlobalInboxPage,
});
