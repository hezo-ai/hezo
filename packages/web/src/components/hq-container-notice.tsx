import { Link } from '@tanstack/react-router';
import { AlertTriangle, ArrowRight, Loader2 } from 'lucide-react';
import type { ContainerHealth } from '../hooks/use-container-health';

/**
 * Shared waiting/blocked panel shown wherever a feature depends on the HQ
 * container being up — the CEO chat, the create-project flow and the home
 * welcome card. Mirrors the container health states (rebuilding / provisioning /
 * stopped / error) and always offers a way through to the container itself.
 *
 * It takes no project slug: the diagnostics it points at live on the global
 * Containers page now, where HQ's container is listed as itself with its own
 * log. It used to link to the project's container page, which this change
 * reduced to per-project settings - so "View container" led somewhere that shows
 * no container.
 */
export function HqContainerNotice({
	health,
	description,
}: {
	health: Exclude<ContainerHealth, { kind: 'healthy' }>;
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
				to="/settings/containers"
				params={{}}
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
			return 'The HQ container is asleep - it starts automatically when needed';
		case 'error':
			return 'The HQ container has an error';
	}
}
