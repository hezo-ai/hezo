import { ContainerStatus } from '@hezo/shared';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { type Project, useProjects } from '../hooks/use-projects';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { Button } from './ui/button';

const MAX_NAMES_SHOWN = 2;

function formatUnhealthyMessage(names: string[]): string {
	const count = names.length;
	if (count === 0) return '';
	const noun = count === 1 ? 'container' : 'containers';
	if (count <= MAX_NAMES_SHOWN) {
		return `${names.join(', ')} ${noun} failed`;
	}
	const shown = names.slice(0, MAX_NAMES_SHOWN).join(', ');
	const extra = count - MAX_NAMES_SHOWN;
	const extraNoun = extra === 1 ? 'other' : 'others';
	return `${shown} + ${extra} ${extraNoun} ${noun} failed`;
}

export function ContainerStatusBanner({ companyId }: { companyId: string }) {
	const { data: projects } = useProjects(companyId);
	const [isRebuilding, setIsRebuilding] = useState(false);

	const unhealthy: Project[] =
		projects?.filter(
			(p) =>
				p.container_status === ContainerStatus.Stopped ||
				p.container_status === ContainerStatus.Error,
		) ?? [];

	if (unhealthy.length === 0) return null;

	const hasError = unhealthy.some((p) => p.container_status === ContainerStatus.Error);
	const message = formatUnhealthyMessage(unhealthy.map((p) => p.name));

	const rebuildAll = async () => {
		if (isRebuilding) return;
		setIsRebuilding(true);
		try {
			await Promise.allSettled(
				unhealthy.map((p) =>
					api.post(`/api/companies/${companyId}/projects/${p.id}/container/rebuild`, {}),
				),
			);
			queryClient.invalidateQueries({ queryKey: ['companies', companyId, 'projects'] });
		} finally {
			setIsRebuilding(false);
		}
	};

	const tone = hasError ? 'bg-red-500/10 text-red-400' : 'bg-amber-500/10 text-amber-400';

	return (
		<div
			data-testid="container-status-banner"
			className={`sticky top-0 z-40 flex items-center gap-2 px-4 py-2 text-[13px] font-medium ${tone}`}
		>
			<AlertTriangle className="w-3.5 h-3.5 shrink-0" />
			<span data-testid="container-status-banner-message" className="min-w-0 truncate">
				{message}
			</span>
			<Button
				variant="ghost"
				size="sm"
				onClick={rebuildAll}
				disabled={isRebuilding}
				className="ml-auto shrink-0"
				aria-label="Rebuild all failed containers"
			>
				{isRebuilding ? (
					<Loader2 className="w-3 h-3 animate-spin" />
				) : (
					<RefreshCw className="w-3 h-3" />
				)}
				<span className="hidden sm:inline">Rebuild all</span>
				<span className="sm:hidden">Rebuild</span>
			</Button>
		</div>
	);
}
