import { createFileRoute } from '@tanstack/react-router';
import { InboxView } from '../../../components/inbox-view';
import { useTeams } from '../../../hooks/use-teams';

function GlobalInboxPage() {
	const { data: teams } = useTeams();
	const teamIds = (teams ?? []).map((t) => t.slug);
	return (
		<div className="px-4 py-4 md:px-6 md:py-5 lg:px-8 lg:py-6">
			<InboxView teamIds={teamIds} scope="global" />
		</div>
	);
}

export const Route = createFileRoute('/home/inbox/')({
	component: GlobalInboxPage,
});
