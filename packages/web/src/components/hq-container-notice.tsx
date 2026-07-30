import { Link } from '@tanstack/react-router';
import { AlertTriangle, ArrowRight, Loader2 } from 'lucide-react';
import type { ContainerHealth } from '../hooks/use-container-health';

/**
 * Shared waiting/blocked panel shown wherever a feature depends on the HQ
 * container being up — the CEO chat and the create-project flow. Mirrors the
 * container status banner's states (rebuilding / provisioning / stopped /
 * error) and always offers a link to the HQ container page for diagnostics.
 */
export function HqContainerNotice({
	health,
	slug,
	description,
}: {
	health: Exclude<ContainerHealth, { kind: 'healthy' }>;
	slug: string;
	description: string;
}) {
	const pending = health.kind === 'rebuilding' || health.kind === 'provisioning';
	const title = noticeTitle(health);

	return (
		<div
			data-testid="hq-container-notice"
			className="flex flex-col items-center gap-3 px-6 py-8 text-center"
		>
			{pending ? (
				<Loader2 className="h-6 w-6 animate-spin text-text-2" />
			) : (
				<AlertTriangle className="h-6 w-6 text-danger" />
			)}
			<div className="flex flex-col gap-1">
				<p className="text-[13px] font-medium text-text-1">{title}</p>
				<p className="text-[13px] text-text-2">{description}</p>
			</div>
			<Link
				to="/projects/$projectId/container"
				params={{ projectId: slug }}
				data-testid="hq-container-notice-link"
				className="inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:underline"
			>
				View container
				<ArrowRight className="h-3.5 w-3.5" />
			</Link>
		</div>
	);
}

function noticeTitle(health: Exclude<ContainerHealth, { kind: 'healthy' }>): string {
	switch (health.kind) {
		case 'rebuilding':
			return 'Rebuilding the HQ container…';
		case 'provisioning':
			return health.transient === 'stopping'
				? 'Stopping the HQ container…'
				: 'Starting the HQ container…';
		case 'stopped':
			return 'The HQ container is asleep — it starts automatically when needed';
		case 'error':
			return 'The HQ container has an error';
	}
}
