import { createFileRoute } from '@tanstack/react-router';
import { InboxView } from '../../components/inbox-view';
import { useCompanies } from '../../hooks/use-companies';

function GlobalInboxPage() {
	const { data: companies, isLoading } = useCompanies();

	if (isLoading) {
		return <div className="p-8 text-text-muted">Loading...</div>;
	}

	const companyIds = companies?.map((c) => c.slug) ?? [];

	return (
		<div className="max-w-[900px] mx-auto w-full px-8 py-6">
			<InboxView companyIds={companyIds} scope="global" />
		</div>
	);
}

export const Route = createFileRoute('/inbox/')({
	component: GlobalInboxPage,
});
