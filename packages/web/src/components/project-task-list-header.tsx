import { ProjectTaskListPhaseBanner } from '@hezo/shared';
import { usePhaseBanner } from '../hooks/use-phase-banner';

const bannerClass =
	'mb-4 rounded-md border border-border bg-surface px-3 py-2.5 sm:px-4 text-sm text-text-1';

function OnboardingBanner() {
	return (
		<div
			data-testid="project-task-list-phase-banner-onboarding"
			className={bannerClass}
			role="status"
		>
			Please wait whilst the CEO onboards your new team members
		</div>
	);
}

export function ProjectTaskListHeader({ projectId }: { projectId: string }) {
	const { data, isLoading } = usePhaseBanner(projectId);

	if (isLoading || !data) return null;
	if (data.phase_banner !== ProjectTaskListPhaseBanner.Onboarding) return null;

	return <OnboardingBanner />;
}
