import { createFileRoute, Link } from '@tanstack/react-router';
import { Building2, Plus } from 'lucide-react';
import { useState } from 'react';
import { CaptainHomeIntakePanel } from '../../components/captain-home-intake-panel';
import { CreateProjectDialog } from '../../components/create-project-dialog';
import { OnboardingProgress } from '../../components/onboarding-progress';
import { OnboardingStartPanel } from '../../components/onboarding-start-panel';
import { Avatar, avatarColorFromString } from '../../components/ui/avatar';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { useHireTeamIntake } from '../../hooks/use-hire-team-intake';
import { type OnboardingStatus, useOnboarding } from '../../hooks/use-onboarding';
import { useAllVisibleProjects } from '../../hooks/use-projects';
import { useRailTeamId } from '../../hooks/use-rail-team-id';
import { useRequirementsIntake } from '../../hooks/use-requirements-intake';
import { useTeams } from '../../hooks/use-teams';

function getInitials(name: string): string {
	const words = name.split(/\s+/).filter(Boolean);
	if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
	return name.slice(0, 2).toUpperCase();
}

function WelcomeCard({
	showCreateTeam,
	showProgress,
	onboardingStages,
}: {
	showCreateTeam: boolean;
	showProgress: boolean;
	onboardingStages?: OnboardingStatus['stages'];
}) {
	if (!showCreateTeam) {
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

	return (
		<div
			className="flex flex-col items-center text-center gap-4 py-10 md:py-14 mb-4"
			data-testid="home-welcome"
		>
			<Building2 className="w-12 h-12 md:w-16 md:h-16 text-text-muted" />
			<div>
				<h1 className="text-xl md:text-2xl font-semibold mb-2">Get started with Hezo</h1>
				<p className="text-[13px] md:text-sm text-text-muted max-w-md">
					Configure an AI provider in Settings, then open your team workspace.
				</p>
			</div>
			<Link to="/settings/ai-providers">
				<Button>Configure AI provider</Button>
			</Link>
		</div>
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
	const primaryTeamSlug = teams[0]?.slug ?? '';

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
					<Link
						key={p.id}
						to="/teams/$teamId/projects/$projectId"
						params={{ teamId: p.teamSlug, projectId: p.slug }}
					>
						<Card className="cursor-pointer h-full">
							<div className="flex items-start gap-3">
								<Avatar initials={getInitials(p.name)} color={avatarColorFromString(p.name)} />
								<div className="flex flex-col gap-1 min-w-0 flex-1">
									<div className="flex items-center justify-between gap-2">
										<h3 className="text-[15px] font-medium text-text truncate">{p.name}</h3>
										{p.container_status && p.container_status !== 'running' && (
											<span
												role="img"
												title={`Container ${p.container_status}`}
												aria-label={`Container ${p.container_status}`}
												className="w-2 h-2 rounded-full bg-accent-red shrink-0"
											/>
										)}
									</div>
									{showTeamName && <p className="text-xs text-text-muted truncate">{p.teamName}</p>}
									{p.description && (
										<p className="text-xs text-text-muted line-clamp-2">{p.description}</p>
									)}
									<div className="flex gap-3 text-xs text-text-muted mt-1">
										<span>{p.open_issue_count} issues</span>
										<span>{p.repo_count} repos</span>
									</div>
								</div>
							</div>
						</Card>
					</Link>
				))}
			</div>
			{primaryTeamSlug && (
				<CreateProjectDialog
					teamId={primaryTeamSlug}
					open={createOpen}
					onOpenChange={setCreateOpen}
				/>
			)}
		</section>
	);
}

function HomePage() {
	const { data: teams, isLoading: teamsLoading } = useTeams();
	const hasTeams = (teams?.length ?? 0) > 0;
	const primaryTeamSlug = useRailTeamId() ?? '';
	const { projects, isLoading: projectsLoading } = useAllVisibleProjects(teams);
	const noUserProjects = !projectsLoading && projects.length === 0;
	const intakeQueryEnabled = hasTeams && (noUserProjects || !projectsLoading);
	const {
		data: requirementsIntake,
		isLoading: requirementsLoading,
		isError: requirementsError,
	} = useRequirementsIntake(primaryTeamSlug, intakeQueryEnabled, { ensure: noUserProjects });
	const {
		data: hireTeamIntake,
		isLoading: hireTeamLoading,
		isError: hireTeamError,
	} = useHireTeamIntake(primaryTeamSlug, hasTeams && !projectsLoading);
	const { data: onboarding } = useOnboarding(primaryTeamSlug, hasTeams);

	if (teamsLoading) {
		return (
			<div className="px-4 py-4 md:px-6 md:py-5 lg:px-8 lg:py-6 text-text-muted">Loading...</div>
		);
	}

	if (!hasTeams) {
		return (
			<div className="flex flex-col items-center justify-center min-h-[70vh] px-4">
				<WelcomeCard showCreateTeam showProgress={false} />
			</div>
		);
	}

	const showRequirementsPanel =
		hasTeams &&
		(noUserProjects
			? requirementsLoading || !!requirementsIntake || requirementsError
			: !!requirementsIntake);
	const showHireTeamPanel = hasTeams && (hireTeamLoading || !!hireTeamIntake || hireTeamError);
	const showCaptainSection = showRequirementsPanel || showHireTeamPanel;

	const activeIntake = hireTeamIntake
		? { ...hireTeamIntake, kind: 'hire-team' as const }
		: requirementsIntake
			? { ...requirementsIntake, kind: 'requirements' as const }
			: null;
	const captainPanelLoading =
		(showHireTeamPanel && hireTeamLoading) ||
		(showRequirementsPanel && !hireTeamIntake && requirementsLoading);

	const showWelcomeCard = onboarding?.show_welcome ?? true;
	const showStartProjectPanel =
		onboarding?.stages.start_project === 'current' && !showCaptainSection;
	const onboardingComplete = onboarding?.stages.start_project === 'complete';

	return (
		<div className="max-w-7xl mx-auto w-full px-4 py-4 md:px-6 md:py-5 lg:px-8 lg:py-6">
			{showWelcomeCard && (
				<WelcomeCard
					showCreateTeam={false}
					showProgress={!!onboarding}
					onboardingStages={onboarding?.stages}
				/>
			)}

			{showCaptainSection && (
				<div className="mb-6" data-testid="home-captain-intake-section">
					{captainPanelLoading && (
						<div className="text-text-muted text-[13px] py-8 text-center">Loading…</div>
					)}
					{!captainPanelLoading && activeIntake && (
						<CaptainHomeIntakePanel teamId={primaryTeamSlug} intake={activeIntake} />
					)}
					{!captainPanelLoading &&
						!activeIntake &&
						(requirementsError || hireTeamError) &&
						(noUserProjects || hireTeamError) && (
							<Card className="border-dashed bg-transparent p-6 text-center text-sm text-text-muted">
								Could not load the Captain conversation. Try refreshing the page.
							</Card>
						)}
				</div>
			)}

			{showStartProjectPanel && onboarding && (
				<div className="mb-6">
					<OnboardingStartPanel teamId={primaryTeamSlug} onboarding={onboarding} />
				</div>
			)}

			{onboardingComplete && (
				<HomeProjectsSection teams={teams ?? []} projects={projects} isLoading={projectsLoading} />
			)}
		</div>
	);
}

export const Route = createFileRoute('/home/')({
	component: HomePage,
});
