import { createFileRoute, Outlet, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { ContainerStatusBanner } from '../../../components/container-status-banner';
import { useCompany } from '../../../hooks/use-companies';
import { useWebSocket } from '../../../hooks/use-websocket';

function CompanyLayout() {
	const { companyId } = Route.useParams();
	const { data: company, error } = useCompany(companyId);
	const navigate = useNavigate();

	useEffect(() => {
		if (error && (error as { status?: number }).status === 404) {
			navigate({ to: '/companies', replace: true });
		}
	}, [error, navigate]);

	useWebSocket(company?.id, companyId);

	return (
		<div className="flex flex-col">
			<ContainerStatusBanner companyId={companyId} />
			<div className="max-w-[1000px] mx-auto w-full px-4 py-4 md:px-6 md:py-5 lg:px-8 lg:py-6">
				<Outlet />
			</div>
		</div>
	);
}

export const Route = createFileRoute('/companies/$companyId')({
	component: CompanyLayout,
});
