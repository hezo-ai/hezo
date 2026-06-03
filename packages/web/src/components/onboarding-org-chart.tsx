import type { OrgNode } from '../hooks/use-org-chart';
import { useOrgChart } from '../hooks/use-org-chart';
import { OrgChartTree } from './org-chart-tree';

export function OnboardingOrgChart({ teamId }: { teamId: string }) {
	const { data: orgChart, isLoading } = useOrgChart(teamId);

	if (isLoading) {
		return (
			<p
				className="text-sm text-text-muted py-4 text-center"
				data-testid="onboarding-org-chart-loading"
			>
				Loading team structure…
			</p>
		);
	}

	const roots = orgChart?.admin.children ?? [];
	if (roots.length === 0) {
		return (
			<p className="text-sm text-text-muted" data-testid="onboarding-org-chart-empty">
				Your team will appear here once agents are hired.
			</p>
		);
	}

	return (
		<div data-testid="onboarding-org-chart">
			<p className="text-xs font-medium uppercase tracking-wide text-text-muted mb-3">
				Reporting structure
			</p>
			<OrgChartTree
				roots={roots}
				mode="onboarding"
				hint="Tap or hover a role to read what they do on the team."
				testId="onboarding-org-chart-tree"
			/>
		</div>
	);
}
