import { createFileRoute, Outlet } from '@tanstack/react-router';
import { Sidebar } from '../../../components/sidebar';
import { useCompany } from '../../../hooks/use-companies';

function CompanyLayout() {
	const { companyId } = Route.useParams();
	const { data: company } = useCompany(companyId);

	return (
		<div className="flex flex-1 overflow-hidden">
			<aside className="w-52 border-r border-border bg-bg-subtle shrink-0 overflow-y-auto">
				{company && (
					<div className="px-4 pt-3 pb-1">
						<h2 className="text-sm font-semibold text-text truncate">{company.name}</h2>
						<p className="text-xs text-text-subtle truncate">{company.issue_prefix}</p>
					</div>
				)}
				<Sidebar companyId={companyId} />
			</aside>
			<main className="flex-1 overflow-auto">
				<Outlet />
			</main>
		</div>
	);
}

export const Route = createFileRoute('/companies/$companyId')({
	component: CompanyLayout,
});
