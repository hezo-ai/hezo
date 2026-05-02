import { createFileRoute } from '@tanstack/react-router';
import { InboxView } from '../../components/inbox-view';
import { useCompanies } from '../../hooks/use-companies';

function GlobalInboxPage() {
	const { data: companies, isLoading } = useCompanies();

	if (isLoading) {
		return (
			<div className="px-4 py-4 md:px-6 md:py-5 lg:px-8 lg:py-6 text-text-muted">Loading...</div>
		);
	}

	const companyIds = companies?.map((c) => c.slug) ?? [];

	return (
		<div className="max-w-[900px] mx-auto w-full px-4 py-4 md:px-6 md:py-5 lg:px-8 lg:py-6">
			<InboxView companyIds={companyIds} scope="global" />
		</div>
	);
}

export const Route = createFileRoute('/inbox/')({
	component: GlobalInboxPage,
});
