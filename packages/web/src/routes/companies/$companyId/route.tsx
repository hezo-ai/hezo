import { createFileRoute, Outlet } from '@tanstack/react-router';
import { AiProviderSetupModal } from '../../../components/ai-provider-setup-modal';
import { ContainerStatusBanner } from '../../../components/container-status-banner';
import { useCompany } from '../../../hooks/use-companies';
import { useWebSocket } from '../../../hooks/use-websocket';

function CompanyLayout() {
	const { companyId } = Route.useParams();
	const { data: company } = useCompany(companyId);
	useWebSocket(company?.id ?? companyId, companyId);

	return (
		<div className="flex flex-col">
			<ContainerStatusBanner companyId={companyId} />
			<div className="max-w-[1000px] mx-auto w-full px-8 py-6">
				<AiProviderSetupModal companyId={companyId} />
				<Outlet />
			</div>
		</div>
	);
}

export const Route = createFileRoute('/companies/$companyId')({
	component: CompanyLayout,
});
