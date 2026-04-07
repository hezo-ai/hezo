import { createFileRoute, Outlet } from '@tanstack/react-router';
import { useCompany } from '../../../hooks/use-companies';
import { useWebSocket } from '../../../hooks/use-websocket';

function CompanyLayout() {
	const { companyId } = Route.useParams();
	const { data: company } = useCompany(companyId);
	useWebSocket(company?.id ?? companyId, companyId);

	return (
		<div className="max-w-[1000px] mx-auto w-full px-8 py-6">
			<Outlet />
		</div>
	);
}

export const Route = createFileRoute('/companies/$companyId')({
	component: CompanyLayout,
});
