import { Loader2 } from 'lucide-react';
import { type OnboardingStatus, useConfirmProjectStart } from '../hooks/use-onboarding';
import { CaptainAvatar, captainChatBubbleMinHClass } from './captain-avatar';
import { OnboardingOrgChart } from './onboarding-org-chart';
import { Button } from './ui/button';
import { Card } from './ui/card';

const captainChatMetaIndentClass = 'pl-[calc(2.625rem+0.625rem)]';

export function OnboardingStartPanel({
	teamId,
	onboarding,
}: {
	teamId: string;
	onboarding: OnboardingStatus;
}) {
	const confirmStart = useConfirmProjectStart(teamId);
	const project = onboarding.primary_project;
	const canConfirm = !!project && onboarding.stages.start_project === 'current';

	return (
		<Card className="p-4 md:p-6" data-testid="onboarding-start-panel">
			<div className="flex flex-col gap-1 mb-5" data-testid="onboarding-start-captain-message">
				<span className={`text-[11px] font-medium text-text-muted ${captainChatMetaIndentClass}`}>
					Captain
				</span>
				<div className="flex gap-2.5 items-start">
					<CaptainAvatar size="chat" className="mt-0.5" />
					<div
						className={`flex-1 min-w-0 rounded-radius-md rounded-bl-sm bg-bg-subtle border border-border px-3 py-2.5 ${captainChatBubbleMinHClass} text-[13px] md:text-sm text-text leading-relaxed`}
					>
						<p>
							Your team is ready and the project plan is in place. Review everything below—when
							you&apos;re happy, hit <span className="font-medium">Start project</span> and
							I&apos;ll kick off execution.
						</p>
					</div>
				</div>
			</div>

			{!project ? (
				<p className="text-sm text-text-muted">
					Your first project will appear here once the Captain creates it during requirements
					gathering.
				</p>
			) : (
				<div className="space-y-5">
					<section>
						<h3 className="text-xs font-medium uppercase tracking-wide text-text-muted mb-2">
							Project
						</h3>
						<p className="text-[15px] font-medium text-text">{project.name}</p>
						{project.description && (
							<p className="text-sm text-text-muted mt-1 line-clamp-3">{project.description}</p>
						)}
					</section>

					<section>
						<OnboardingOrgChart teamId={teamId} />
					</section>

					{onboarding.goals.length > 0 && (
						<section>
							<h3 className="text-xs font-medium uppercase tracking-wide text-text-muted mb-2">
								Goals
							</h3>
							<ul className="space-y-1">
								{onboarding.goals.map((g) => (
									<li key={g.id} className="text-sm text-text">
										{g.title}
									</li>
								))}
							</ul>
						</section>
					)}
				</div>
			)}

			<div className="mt-6 flex flex-col sm:flex-row sm:items-center gap-3">
				<Button
					onClick={() => confirmStart.mutate()}
					disabled={!canConfirm || confirmStart.isPending}
					data-testid="onboarding-confirm-start"
				>
					{confirmStart.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
					Start project
				</Button>
				{confirmStart.isError && (
					<p className="text-sm text-accent-red">
						{(confirmStart.error as Error).message || 'Could not start project'}
					</p>
				)}
			</div>
		</Card>
	);
}
