import * as Dialog from '@radix-ui/react-dialog';
import { createFileRoute, Link } from '@tanstack/react-router';
import { FolderKanban, Loader2, Plus } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '../../../../components/ui/badge';
import { Button } from '../../../../components/ui/button';
import { Card } from '../../../../components/ui/card';
import { EmptyState } from '../../../../components/ui/empty-state';
import { Input } from '../../../../components/ui/input';
import { Textarea } from '../../../../components/ui/textarea';
import { useCreateProject, useProjects } from '../../../../hooks/use-projects';

function ProjectListPage() {
	const { companyId } = Route.useParams();
	const { data: projects, isLoading } = useProjects(companyId);
	const [createOpen, setCreateOpen] = useState(false);

	if (isLoading) return <div className="p-6 text-text-muted">Loading...</div>;

	return (
		<div className="p-6">
			<div className="flex items-center justify-between mb-4">
				<h1 className="text-lg font-semibold">Projects</h1>
				<Button size="sm" onClick={() => setCreateOpen(true)}>
					<Plus className="w-4 h-4" /> New Project
				</Button>
			</div>

			{projects?.length === 0 ? (
				<EmptyState
					icon={<FolderKanban className="w-10 h-10" />}
					title="No projects yet"
					description="Create a project to organize issues and repos."
				/>
			) : (
				<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
					{projects?.map((p) => (
						<Link
							key={p.id}
							to="/companies/$companyId/projects/$projectId"
							params={{ companyId, projectId: p.id }}
						>
							<Card className="hover:border-primary/50 transition-colors cursor-pointer">
								<h3 className="font-medium text-sm mb-1">{p.name}</h3>
								{p.goal && <p className="text-xs text-text-muted line-clamp-2 mb-2">{p.goal}</p>}
								<div className="flex gap-2">
									<Badge color="blue">{p.repo_count} repos</Badge>
									<Badge color="yellow">{p.open_issue_count} issues</Badge>
								</div>
							</Card>
						</Link>
					))}
				</div>
			)}

			<CreateProjectDialog companyId={companyId} open={createOpen} onOpenChange={setCreateOpen} />
		</div>
	);
}

function CreateProjectDialog({
	companyId,
	open,
	onOpenChange,
}: {
	companyId: string;
	open: boolean;
	onOpenChange: (v: boolean) => void;
}) {
	const [name, setName] = useState('');
	const [goal, setGoal] = useState('');
	const createProject = useCreateProject(companyId);

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		await createProject.mutateAsync({ name, goal: goal || undefined });
		onOpenChange(false);
		setName('');
		setGoal('');
	}

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm" />
				<Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md rounded-xl border border-border bg-bg-subtle p-6 shadow-2xl">
					<Dialog.Title className="text-lg font-semibold mb-4">Create Project</Dialog.Title>
					<form onSubmit={handleSubmit} className="flex flex-col gap-4">
						<Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
						<Textarea
							label="Goal"
							value={goal}
							onChange={(e) => setGoal(e.target.value)}
							placeholder="Optional"
						/>
						<div className="flex justify-end gap-2 mt-2">
							<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
								Cancel
							</Button>
							<Button type="submit" disabled={!name.trim() || createProject.isPending}>
								{createProject.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
								Create
							</Button>
						</div>
					</form>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

export const Route = createFileRoute('/companies/$companyId/projects/')({
	component: ProjectListPage,
});
