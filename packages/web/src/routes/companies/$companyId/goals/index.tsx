import { GoalStatus } from '@hezo/shared';
import { createFileRoute } from '@tanstack/react-router';
import { Plus, Target } from 'lucide-react';
import { useMemo, useState } from 'react';
import { GoalDialog } from '../../../../components/goal-dialog';
import { Badge } from '../../../../components/ui/badge';
import { Button } from '../../../../components/ui/button';
import { Card } from '../../../../components/ui/card';
import { EmptyState } from '../../../../components/ui/empty-state';
import { type GoalWithProject, useArchiveGoal, useGoals } from '../../../../hooks/use-goals';

function GoalsPage() {
	const { companyId } = Route.useParams();
	const { data: goals, isLoading } = useGoals(companyId);
	const [createOpen, setCreateOpen] = useState(false);
	const [editGoal, setEditGoal] = useState<GoalWithProject | undefined>(undefined);
	const archive = useArchiveGoal(companyId);

	const grouped = useMemo(() => {
		const map: Record<string, GoalWithProject[]> = {
			[GoalStatus.Active]: [],
			[GoalStatus.Achieved]: [],
			[GoalStatus.Archived]: [],
		};
		for (const g of goals ?? []) {
			map[g.status]?.push(g);
		}
		return map;
	}, [goals]);

	return (
		<div className="max-w-[900px] mx-auto w-full px-4 sm:px-6 lg:px-8 py-6">
			<div className="flex items-center justify-between mb-5">
				<h1 className="text-[22px] font-medium">Goals</h1>
				<Button onClick={() => setCreateOpen(true)}>
					<Plus className="w-4 h-4" />
					New goal
				</Button>
			</div>

			{isLoading ? (
				<div className="text-text-muted text-[13px] py-8 text-center">Loading...</div>
			) : (goals?.length ?? 0) === 0 ? (
				<EmptyState
					icon={<Target className="w-10 h-10" />}
					title="No goals yet"
					description="Create a goal so the CEO can keep plans aligned with what the board wants."
				/>
			) : (
				<div className="flex flex-col gap-6">
					<GoalSection
						title="Active"
						goals={grouped[GoalStatus.Active]}
						onEdit={setEditGoal}
						onArchive={(id) => archive.mutate(id)}
					/>
					<GoalSection title="Achieved" goals={grouped[GoalStatus.Achieved]} onEdit={setEditGoal} />
					<GoalSection title="Archived" goals={grouped[GoalStatus.Archived]} onEdit={setEditGoal} />
				</div>
			)}

			<GoalDialog companyId={companyId} open={createOpen} onOpenChange={setCreateOpen} />
			<GoalDialog
				companyId={companyId}
				goal={editGoal}
				open={editGoal !== undefined}
				onOpenChange={(v) => {
					if (!v) setEditGoal(undefined);
				}}
			/>
		</div>
	);
}

function GoalSection({
	title,
	goals,
	onEdit,
	onArchive,
}: {
	title: string;
	goals: GoalWithProject[];
	onEdit: (goal: GoalWithProject) => void;
	onArchive?: (id: string) => void;
}) {
	if (goals.length === 0) return null;
	return (
		<section>
			<h2 className="text-xs font-medium uppercase tracking-wider text-text-muted mb-2">
				{title} ({goals.length})
			</h2>
			<div className="flex flex-col gap-2">
				{goals.map((g) => (
					<Card key={g.id} className="flex flex-col gap-2">
						<div className="flex items-start justify-between gap-3">
							<div className="min-w-0 flex-1">
								<h3 className="text-[15px] font-medium text-text">{g.title}</h3>
								<div className="flex items-center gap-2 mt-1">
									<Badge color="neutral">
										{g.project_name ? `Project: ${g.project_name}` : 'Company-wide'}
									</Badge>
								</div>
							</div>
							<div className="flex items-center gap-2 flex-shrink-0">
								<Button variant="secondary" size="sm" onClick={() => onEdit(g)}>
									Edit
								</Button>
								{onArchive && (
									<Button variant="ghost" size="sm" onClick={() => onArchive(g.id)}>
										Archive
									</Button>
								)}
							</div>
						</div>
						{g.description && (
							<p className="text-sm text-text-muted whitespace-pre-wrap">{g.description}</p>
						)}
					</Card>
				))}
			</div>
		</section>
	);
}

export const Route = createFileRoute('/companies/$companyId/goals/')({
	component: GoalsPage,
});
