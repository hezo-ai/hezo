import { createFileRoute, Outlet } from '@tanstack/react-router';
import { CompanyTabs } from '../../../components/company-tabs';
import { Breadcrumb } from '../../../components/ui/breadcrumb';
import { useCompany } from '../../../hooks/use-companies';
import { useWebSocket } from '../../../hooks/use-websocket';

function CompanyLayout() {
	const { companyId } = Route.useParams();
	const { data: company } = useCompany(companyId);
	useWebSocket(companyId);

	return (
		<div className="max-w-[900px] mx-auto w-full px-8 py-6">
			<Breadcrumb
				items={[
					{
						label: company?.name ?? '...',
						to: '/companies/$companyId/issues',
						params: { companyId },
					},
				]}
			/>
			<div className="flex items-center justify-between mb-5">
				<h1 className="text-[22px] font-medium">{company?.name ?? '...'}</h1>
			</div>
			<CompanyTabs companyId={companyId} />
			<Outlet />
		</div>
	);
}

export const Route = createFileRoute('/companies/$companyId')({
	component: CompanyLayout,
});
