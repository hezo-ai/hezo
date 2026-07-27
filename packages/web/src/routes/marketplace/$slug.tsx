import * as Dialog from '@radix-ui/react-dialog';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { ChevronRight, Loader2, Store } from 'lucide-react';
import { useState } from 'react';
import { CreateProjectWithTeamDialog } from '../../components/create-project-with-team-dialog';
import { marketplaceRosterRows, TeamRosterTable } from '../../components/team-roster-table';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { DialogContent } from '../../components/ui/dialog';
import { useAddMarketplaceTeam, useMarketplaceTeam } from '../../hooks/use-marketplace';
import { useAllVisibleProjects } from '../../hooks/use-projects';
import { toast } from '../../hooks/use-toast';

function MarketplaceTeamDetail() {
	const { slug } = Route.useParams();
	const { data: team, isLoading } = useMarketplaceTeam(slug);
	const [launchOpen, setLaunchOpen] = useState(false);
	const [addOpen, setAddOpen] = useState(false);

	return (
		<div className="max-w-[900px] mx-auto p-4 sm:p-6 lg:p-8" data-testid="marketplace-detail">
			<nav className="flex items-center gap-1 text-[13px] text-text-2 mb-4" aria-label="Breadcrumb">
				<Link to="/marketplace" className="hover:text-text-1 flex items-center gap-1">
					<Store className="w-3.5 h-3.5" /> Marketplace
				</Link>
				<ChevronRight className="w-3.5 h-3.5" />
				<span className="text-text-1">{team?.name ?? slug}</span>
			</nav>

			{isLoading ? (
				<div className="flex items-center gap-2 text-text-2 text-[13px] py-8">
					<Loader2 className="w-4 h-4 animate-spin" /> Loading…
				</div>
			) : !team ? (
				<p className="text-text-2 text-[13px]">This team is not in the marketplace.</p>
			) : (
				<>
					<div className="flex items-start justify-between gap-3 flex-wrap mb-2">
						<div>
							<div className="flex items-center gap-2">
								<h1 className="text-xl font-semibold">{team.name}</h1>
								<Badge color="neutral">v{team.version}</Badge>
							</div>
							<p className="text-[13px] text-text-2 mt-1 max-w-[600px]">{team.description}</p>
						</div>
						<div className="flex gap-2">
							<Button onClick={() => setLaunchOpen(true)} data-testid="marketplace-launch">
								Launch new project
							</Button>
							<Button
								variant="secondary"
								onClick={() => setAddOpen(true)}
								data-testid="marketplace-add-existing"
							>
								Add to a project
							</Button>
						</div>
					</div>

					<section className="mt-6">
						<h2 className="text-[15px] font-medium mb-2">
							Roster ({team.roster.length + 1} roles)
						</h2>
						<TeamRosterTable rows={marketplaceRosterRows(team)} testId="marketplace-roster" />
					</section>

					{team.changelog.length > 0 && (
						<section className="mt-8">
							<h2 className="text-[15px] font-medium mb-2">Changelog</h2>
							<ul className="space-y-1.5">
								{team.changelog.map((c) => (
									<li key={c.version} className="text-[13px] text-text-2">
										<span className="font-medium text-text-1">v{c.version}</span>
										{c.notes ? ` — ${c.notes}` : ''}
									</li>
								))}
							</ul>
						</section>
					)}

					<CreateProjectWithTeamDialog
						open={launchOpen}
						onOpenChange={setLaunchOpen}
						initialMarketplaceSlug={slug}
					/>
					<AddToProjectDialog
						open={addOpen}
						onOpenChange={setAddOpen}
						slug={slug}
						teamName={team.name}
					/>
				</>
			)}
		</div>
	);
}

function AddToProjectDialog({
	open,
	onOpenChange,
	slug,
	teamName,
}: {
	open: boolean;
	onOpenChange: (v: boolean) => void;
	slug: string;
	teamName: string;
}) {
	const { projects } = useAllVisibleProjects();
	const [projectId, setProjectId] = useState('');
	const selected = projects.find((p) => p.slug === projectId);
	const add = useAddMarketplaceTeam(selected?.slug ?? '');
	const navigate = useNavigate();
	const canSubmit = projectId.length > 0 && !add.isPending;

	async function submit() {
		if (!selected) return;
		const res = await add.mutateAsync(slug);
		onOpenChange(false);
		setProjectId('');
		const href = `/projects/${selected.slug}/tasks/${res.task_identifier.toLowerCase()}`;
		toast.success(`The CEO is adding the ${teamName} team to ${selected.name}.`, {
			link: {
				label: 'View task',
				href,
				onNavigate: () =>
					navigate({
						to: '/projects/$projectId/tasks/$taskId',
						params: { projectId: selected.slug, taskId: res.task_identifier.toLowerCase() },
					}),
			},
		});
	}

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<DialogContent size="md">
				<Dialog.Title className="text-base font-medium mb-1">
					Add the {teamName} team to a project
				</Dialog.Title>
				<Dialog.Description className="text-[13px] text-text-2 mb-4">
					The CEO opens a task in the project to hire this team's roles and reconcile the roster. If
					the project already has these roles, it updates them to this version instead.
				</Dialog.Description>
				<label className="flex flex-col gap-1 text-[13px] font-medium text-text-1">
					Project
					<select
						value={projectId}
						onChange={(e) => setProjectId(e.target.value)}
						data-testid="add-to-project-select"
						className="border border-border rounded-md px-3 py-2 text-[13px] bg-surface text-text-1"
					>
						<option value="">Choose a project…</option>
						{projects.map((p) => (
							<option key={p.slug} value={p.slug}>
								{p.name}
							</option>
						))}
					</select>
				</label>
				{add.error && (
					<p className="text-[13px] text-danger mt-2">
						{(add.error as { message?: string }).message || 'Failed to add team'}
					</p>
				)}
				<div className="flex justify-end gap-2 mt-4">
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button onClick={submit} disabled={!canSubmit} data-testid="add-to-project-submit">
						{add.isPending ? 'Starting…' : 'Add team'}
					</Button>
				</div>
			</DialogContent>
		</Dialog.Root>
	);
}

export const Route = createFileRoute('/marketplace/$slug')({
	component: MarketplaceTeamDetail,
});
