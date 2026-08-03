import { Link } from '@tanstack/react-router';
import { AlertTriangle } from 'lucide-react';
import { useCallback } from 'react';
import { useContainerHealth } from '../hooks/use-container-health';
import { useProjectMeta } from '../hooks/use-projects';

const BANNER_OUTER = 'sticky top-0 z-40 bg-surface';
const BANNER_INNER = 'flex items-center gap-2 px-4 py-2 text-[13px] font-medium';

/**
 * The one container state worth interrupting a project page for.
 *
 * **Errors only.** This used to also announce provisioning and base-image
 * builds, from a time when a project had exactly one container whose bring-up
 * was an event. A project now gets a container whenever a run needs one, so
 * "provisioning" is the ordinary case - a banner for it fires on almost every
 * page, several times an hour, telling an operator about something they did not
 * ask for and cannot act on. An *error* is different: it is the state that does
 * not resolve on its own.
 *
 * There is no inline fix any more either. Rebuild replaced a project's whole
 * fleet, which stopped meaning anything once there were several containers; the
 * banner points at the global Containers page, where the failed container is
 * addressed as itself and can be removed.
 */
export function ContainerStatusBanner({ projectId }: { projectId: string }) {
	const project = useProjectMeta(projectId);
	const health = useContainerHealth(project);

	const bannerRef = useCallback((node: HTMLDivElement | null) => {
		if (!node) return;
		const root = document.documentElement;
		const observer = new ResizeObserver(([entry]) => {
			root.style.setProperty('--container-banner-h', `${entry?.contentRect.height ?? 0}px`);
		});
		observer.observe(node);
		return () => {
			observer.disconnect();
			root.style.setProperty('--container-banner-h', '0px');
		};
	}, []);

	if (!project || health?.kind !== 'error') return null;

	const message = `${project.name} container hit an error`;

	return (
		<div ref={bannerRef} className={BANNER_OUTER}>
			<Link
				to="/settings/containers"
				params={{}}
				data-testid="container-status-banner"
				aria-label={`${message}. View containers`}
				className={`${BANNER_INNER} bg-danger/10 text-danger transition-colors hover:bg-danger/20`}
			>
				<AlertTriangle className="w-3.5 h-3.5 shrink-0" />
				<span data-testid="container-status-banner-message" className="min-w-0 truncate">
					{message}
				</span>
				<span className="ml-auto shrink-0 hidden sm:inline opacity-80">View containers</span>
			</Link>
		</div>
	);
}
