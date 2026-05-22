import { Check, ChevronDown, ChevronRight } from 'lucide-react';
import { Fragment } from 'react';
import type { OnboardingStageKey, OnboardingStageStatus } from '../hooks/use-onboarding';

const STAGES: { key: OnboardingStageKey; label: string }[] = [
	{ key: 'intake', label: 'Set up your first project' },
	{ key: 'done', label: 'Ready' },
];

function stageDotClass(status: OnboardingStageStatus): string {
	if (status === 'complete') return 'bg-accent-green border-accent-green text-white';
	if (status === 'current') return 'bg-accent border-accent text-white';
	return 'bg-surface-elevated border-border text-text-muted';
}

function stageLabelClass(status: OnboardingStageStatus): string {
	if (status === 'complete') return 'text-text';
	if (status === 'current') return 'text-text font-medium';
	return 'text-text-muted';
}

export function OnboardingProgress({
	stages,
}: {
	stages: Record<OnboardingStageKey, OnboardingStageStatus>;
}) {
	return (
		<nav
			className="border-t border-border px-4 py-3 md:px-6"
			aria-label="Team setup progress"
			data-testid="onboarding-progress"
		>
			<ol className="flex w-full flex-col items-stretch sm:flex-row sm:items-center">
				{STAGES.map((stage, index) => {
					const status = stages[stage.key];
					return (
						<Fragment key={stage.key}>
							<li
								className="flex flex-1 items-center justify-center gap-2 min-w-0 basis-0 px-1 py-1"
								data-testid={`onboarding-stage-${stage.key}`}
								data-stage-status={status}
							>
								<span
									className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold ${stageDotClass(status)}`}
									aria-hidden
								>
									{status === 'complete' ? (
										<Check className="h-3.5 w-3.5" strokeWidth={3} />
									) : (
										index + 1
									)}
								</span>
								<span
									className={`text-xs sm:text-[13px] text-center sm:text-left ${stageLabelClass(status)}`}
								>
									{stage.label}
								</span>
							</li>
							{index < STAGES.length - 1 && (
								<li
									className="flex shrink-0 items-center justify-center py-0.5 text-text-muted sm:px-3"
									aria-hidden
								>
									<ChevronDown className="h-4 w-4 sm:hidden" />
									<ChevronRight className="hidden h-4 w-4 sm:block" />
								</li>
							)}
						</Fragment>
					);
				})}
			</ol>
		</nav>
	);
}
