import { createFileRoute, Link } from '@tanstack/react-router';
import { Building2, Plus } from 'lucide-react';
import { Avatar, avatarColorFromString } from '../../components/ui/avatar';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { useTeams } from '../../hooks/use-teams';

function getInitials(name: string): string {
	const words = name.split(/\s+/);
	if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
	return name.slice(0, 2).toUpperCase();
}

function TeamListPage() {
	const { data: teams, isLoading } = useTeams();

	if (isLoading) {
		return (
			<div className="px-4 py-4 md:px-6 md:py-5 lg:px-8 lg:py-6 text-text-muted">Loading...</div>
		);
	}

	if (teams?.length === 0) {
		return (
			<div className="flex flex-col items-center justify-center h-[70vh] gap-6">
				<Building2 className="w-16 h-16 text-text-muted" />
				<div className="text-center">
					<h1 className="text-2xl font-semibold mb-2">Welcome to Hezo</h1>
					<p className="text-text-muted">Create your first team to get started.</p>
				</div>
				<Link to="/teams/new">
					<Button>
						<Plus className="w-4 h-4" />
						Create Team
					</Button>
				</Link>
			</div>
		);
	}

	return (
		<div className="max-w-[900px] mx-auto w-full px-4 py-4 md:px-6 md:py-5 lg:px-8 lg:py-6">
			<div className="flex items-center justify-between mb-5">
				<h1 className="text-[22px] font-medium">Teams</h1>
				<Link to="/teams/new">
					<Button>
						<Plus className="w-4 h-4" />
						New team
					</Button>
				</Link>
			</div>

			<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
				{teams?.map((team) => (
					<Link key={team.id} to="/teams/$teamId" params={{ teamId: team.slug }}>
						<Card className="cursor-pointer">
							<div className="flex items-start gap-3">
								<Avatar
									initials={getInitials(team.name)}
									color={avatarColorFromString(team.name)}
								/>
								<div className="flex flex-col gap-1 min-w-0">
									<h2 className="text-[15px] font-medium text-text truncate">{team.name}</h2>
									{team.description && (
										<p className="text-xs text-text-muted line-clamp-2">{team.description}</p>
									)}
									<div className="flex gap-3 text-xs text-text-muted mt-1">
										<span>{team.agent_count} agents</span>
										<span>{team.open_issue_count} issues</span>
									</div>
								</div>
							</div>
						</Card>
					</Link>
				))}
			</div>
		</div>
	);
}

export const Route = createFileRoute('/teams/')({
	component: TeamListPage,
});
