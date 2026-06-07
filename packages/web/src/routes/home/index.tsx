import { HQ_PROJECT_SLUG } from '@hezo/shared';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Building2, Plus } from 'lucide-react';
import { useState } from 'react';
import { CaptainHomeIntakePanel } from '../../components/captain-home-intake-panel';
import { CreateProjectWithTeamDialog } from '../../components/create-project-with-team-dialog';
import { OnboardingProgress } from '../../components/onboarding-progress';
import { OnboardingChoice } from '../../components/setup/onboarding-choice';
import { Avatar, avatarColorFromString, getInitials } from '../../components/ui/avatar';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Tooltip } from '../../components/ui/tooltip';
import { useActiveTeamSlug } from '../../hooks/use-active-team-slug';
import { type OnboardingStatus, useOnboarding } from '../../hooks/use-onboarding';
import { useOnboardingIntake } from '../../hooks/use-onboarding-intake';
import { useAllVisibleProjects } from '../../hooks/use-projects';
import { useTeams } from '../../hooks/use-teams';
import { queryClient } from '../../lib/query-client';

function WelcomeCard({
	showProgress,
	onboardingStages,
}: {
	showProgress: boolean;
	onboardingStages?: OnboardingStatus['stages'];
}) {
	return (
		<Card className="mb-4 p-0 overflow-hidden" data-testid="home-welcome-card">
			<div
				className="flex items-center justify-center gap-2.5 px-4 py-3"
				data-testid="home-welcome"
			>
				<Building2 className="w-7 h-7 text-text-muted shrink-0" />
				<h1 className="text-base font-semibold text-text">Get started with Hezo</h1>
			</div>
			{showProgress && onboardingStages && <OnboardingProgress stages={onboardingStages} />}
		</Card>
	);
}

function HomeProjectsSection({
	teams,
	projects,
	isLoading,
}: {
	teams: NonNullable<ReturnType<typeof useTeams>['data']>;
	projects: ReturnType<typeof useAllVisibleProjects>['projects'];
	isLoading: boolean;
}) {
	const [createOpen, setCreateOpen] = useState(false);
	const showTeamName = teams.length > 1;

	if (isLoading) {
		return (
			<div
				className="text-text-muted text-[13px] py-8 text-center"
				data-testid="home-projects-loading"
			>
				Loading projects...
			</div>
		);
	}

	if (projects.length === 0) {
		return null;
	}

	return (
		<section data-testid="home-projects-list">
			<div className="flex items-center justify-between mb-4">
				<h2 className="text-[18px] md:text-[22px] font-medium">Projects</h2>
				<Button variant="secondary" size="sm" onClick={() => setCreateOpen(true)}>
					<Plus className="w-4 h-4" />
					New project
				</Button>
			</div>
			<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
				{projects.map((p) => (
					<Link key={p.id} to="/projects/$projectId" params={{ projectId: p.slug }}>
						<Card className="cursor-pointer h-full">
							<div className="flex items-start gap-3">
								<Avatar initials={getInitials(p.name)} color={avatarColorFromString(p.name)} />
								<div className="flex flex-col gap-1 min-w-0 flex-1">
									<div className="flex items-center justify-between gap-2">
										<h3 className="text-[15px] font-medium text-text truncate">{p.name}</h3>
										{p.container_status && p.container_status !== 'running' && (
											<Tooltip content={`Container ${p.container_status}`}>
												<span
													role="img"
													aria-label={`Container ${p.container_status}`}
													className="w-2 h-2 rounded-full bg-accent-red shrink-0"
												/>
											</Tooltip>
										)}
									</div>
									{showTeamName && <p className="text-xs text-text-muted truncate">{p.teamName}</p>}
									{p.description && (
										<p className="text-xs text-text-muted line-clamp-2">{p.description}</p>
									)}
									<div className="flex gap-3 text-xs text-text-muted mt-1">
										<span>{p.open_task_count} tasks</span>
										<span>{p.repo_count} repos</span>
									</div>
								</div>
							</div>
						</Card>
					</Link>
				))}
			</div>
			<CreateProjectWithTeamDialog open={createOpen} onOpenChange={setCreateOpen} />
		</section>
	);
}

function HomePage() {
	const { data: teams, isLoading: teamsLoading } = useTeams();
	const primaryTeamSlug = useActiveTeamSlug();
	// Onboarding is pre-project and is run by the CEO in the single HQ project.
	const onboardingProjectId = HQ_PROJECT_SLUG;
	const { projects, isLoading: projectsLoading } = useAllVisibleProjects();
	// Only ensure/open an onboarding intake during true first-run — i.e. when no
	// visible team has a project yet. Per-project teams mean the first project may
	// land in its own team; once any project exists we must not re-open an intake
	// on the default/HQ team.
	const noProjectsYet = !projectsLoading && projects.length === 0;
	const { data: intake } = useOnboardingIntake(onboardingProjectId, noProjectsYet);
	const { data: onboarding } = useOnboarding(onboardingProjectId, true);

	if (teamsLoading) {
		return (
			<div className="px-4 py-4 md:px-6 md:py-5 lg:px-8 lg:py-6 text-text-muted">Loading...</div>
		);
	}

	const hasIntake = !!intake;
	// Onboarding is complete once any visible team has a user-facing project —
	// per-project teams mean the first project may live in its own new team, not
	// the default/HQ team (which stays CEO-only).
	const hasProject = projects.length > 0;
	const showChoice = !hasIntake && !hasProject;
	const showProgress = !!onboarding && (showChoice || hasIntake);

	return (
		<div className="max-w-7xl mx-auto w-full px-4 py-4 md:px-6 md:py-5 lg:px-8 lg:py-6">
			{showProgress && (
				<WelcomeCard showProgress={!!onboarding} onboardingStages={onboarding?.stages} />
			)}

			{showChoice && (
				<div className="mb-6" data-testid="home-onboarding-choice-section">
					<OnboardingChoice
						projectId={onboardingProjectId}
						onChosen={() => {
							queryClient.invalidateQueries({
								queryKey: ['projects', onboardingProjectId, 'onboarding'],
							});
							queryClient.invalidateQueries({
								queryKey: ['projects', onboardingProjectId, 'onboarding-intake'],
							});
							queryClient.invalidateQueries({ queryKey: ['projects'] });
						}}
					/>
				</div>
			)}

			{hasIntake && intake && (
				<div className="mb-6" data-testid="home-captain-intake-section">
					<CaptainHomeIntakePanel projectId={onboardingProjectId} intake={intake} />
				</div>
			)}

			{hasProject && (
				<HomeProjectsSection teams={teams ?? []} projects={projects} isLoading={projectsLoading} />
			)}
		</div>
	);
}

export const Route = createFileRoute('/home/')({
	component: HomePage,
});
