import { createFileRoute } from '@tanstack/react-router';
import { InboxView } from '../../../../components/inbox-view';

function InboxPage() {
	const { companyId } = Route.useParams();
	return <InboxView companyIds={[companyId]} scope="company" />;
}

export const Route = createFileRoute('/companies/$companyId/inbox/')({
	component: InboxPage,
});
