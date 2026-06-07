import { createFileRoute, Link } from '@tanstack/react-router';
import { Building2, Plus } from 'lucide-react';
import { useState } from 'react';
import { CreateProjectWithTeamDialog } from '../../components/create-project-with-team-dialog';
import { ProjectIntakeHomePanel } from '../../components/project-intake-home-panel';
import { Avatar, avatarColorFromString, getInitials } from '../../components/ui/avatar';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Tooltip } from '../../components/ui/tooltip';
import { useProjectIntake } from '../../hooks/use-project-intake';
import { useAllVisibleProjects } from '../../hooks/use-projects';
import { useTeams } from '../../hooks/use-teams';

function WelcomeCard({ onCreate }: { onCreate: () => void }) {
	return (
		<Card className="mb-6 p-0 overflow-hidden" data-testid="home-welcome-card">
			<div
				className="flex flex-col items-center gap-3 px-4 py-8 text-center"
				data-testid="home-welcome"
			>
				<Building2 className="w-8 h-8 text-text-muted shrink-0" />
				<div>
					<h1 className="text-base font-semibold text-text">Get started with Hezo</h1>
					<p className="text-[13px] text-text-muted mt-1 max-w-md">
						Create your first project. Each one gets its own team — spin it up from a template, or
						let the CEO scope it with you first.
					</p>
				</div>
				<Button onClick={onCreate} data-testid="home-welcome-create">
					<Plus className="w-4 h-4" />
					New project
				</Button>
			</div>
		</Card>
	);
}

function HomeProjectsSection({
	teams,
	projects,
	isLoading,
	onCreate,
}: {
	teams: NonNullable<ReturnType<typeof useTeams>['data']>;
	projects: ReturnType<typeof useAllVisibleProjects>['projects'];
	isLoading: boolean;
	onCreate: () => void;
}) {
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
				<Button variant="secondary" size="sm" onClick={onCreate}>
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
		</section>
	);
}

function HomePage() {
	const { data: teams, isLoading: teamsLoading } = useTeams();
	const { projects, isLoading: projectsLoading } = useAllVisibleProjects();
	const [createOpen, setCreateOpen] = useState(false);

	// The CEO-assisted intake lives in HQ and is instance-wide; only surface it
	// while the welcome view is showing (no user-facing projects yet).
	const noProjectsYet = !projectsLoading && projects.length === 0;
	const { data: intake } = useProjectIntake(noProjectsYet);

	if (teamsLoading) {
		return <div className="text-text-muted">Loading...</div>;
	}

	const hasProject = projects.length > 0;
	const hasIntake = !!intake;
	const showWelcome = !hasProject && !hasIntake;

	return (
		<div className="max-w-7xl mx-auto w-full">
			{showWelcome && <WelcomeCard onCreate={() => setCreateOpen(true)} />}

			{hasIntake && intake && (
				<div className="mb-6" data-testid="home-project-intake-section">
					<ProjectIntakeHomePanel intake={intake} />
				</div>
			)}

			{hasProject && (
				<HomeProjectsSection
					teams={teams ?? []}
					projects={projects}
					isLoading={projectsLoading}
					onCreate={() => setCreateOpen(true)}
				/>
			)}

			<CreateProjectWithTeamDialog open={createOpen} onOpenChange={setCreateOpen} />
		</div>
	);
}

export const Route = createFileRoute('/home/')({
	component: HomePage,
});
