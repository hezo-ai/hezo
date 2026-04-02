import * as Dialog from '@radix-ui/react-dialog';
import { createFileRoute, Link } from '@tanstack/react-router';
import { FolderKanban, Loader2, Plus } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '../../../../components/ui/badge';
import { Button } from '../../../../components/ui/button';
import { EmptyState } from '../../../../components/ui/empty-state';
import { Input } from '../../../../components/ui/input';
import { Textarea } from '../../../../components/ui/textarea';
import { useCreateProject, useProjects } from '../../../../hooks/use-projects';

function ProjectListPage() {
	const { companyId } = Route.useParams();
	const { data: projects, isLoading } = useProjects(companyId);
	const [createOpen, setCreateOpen] = useState(false);

	if (isLoading)
		return <div className="text-text-muted text-[13px] py-8 text-center">Loading...</div>;

	return (
		<div>
			<div className="flex items-center justify-end mb-4">
				<Button onClick={() => setCreateOpen(true)}>
					<Plus className="w-4 h-4" /> New project
				</Button>
			</div>

			{projects?.length === 0 ? (
				<EmptyState
					icon={<FolderKanban className="w-10 h-10" />}
					title="No projects yet"
					description="Create a project to organize issues and repos."
				/>
			) : (
				<div className="flex flex-col gap-2.5">
					{projects?.map((p) => (
						<Link
							key={p.id}
							to="/companies/$companyId/projects/$projectId"
							params={{ companyId, projectId: p.id }}
						>
							<div className="border border-border rounded-radius-lg p-4 bg-bg transition-[border-color] duration-150 hover:border-border-hover cursor-pointer">
								<div className="flex items-center justify-between mb-1">
									<h3 className="text-[15px] font-medium">{p.name}</h3>
									<div className="flex gap-1.5">
										{p.container_status && <ContainerStatusBadge status={p.container_status} />}
									</div>
								</div>
								{p.goal && (
									<p className="text-[13px] text-text-muted leading-relaxed mb-2 line-clamp-2">
										{p.goal}
									</p>
								)}
								<div className="flex items-center gap-3 text-xs text-text-muted">
									<span>{p.open_issue_count} issues</span>
									<span>{p.repo_count} repos</span>
								</div>
							</div>
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
				<Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md rounded-radius-lg border border-border bg-bg-elevated p-6 shadow-2xl">
					<Dialog.Title className="text-base font-medium mb-4">Create Project</Dialog.Title>
					<form onSubmit={handleSubmit} className="flex flex-col gap-4">
						<Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
						<Textarea
							label="Goal"
							value={goal}
							onChange={(e) => setGoal(e.target.value)}
							placeholder="Optional"
						/>
						<div className="flex justify-end gap-2 mt-2">
							<Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
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

function ContainerStatusBadge({ status }: { status: string }) {
	const config: Record<string, { color: string; label: string }> = {
		creating: { color: 'warning', label: 'Provisioning' },
		running: { color: 'success', label: 'Running' },
		stopped: { color: 'neutral', label: 'Stopped' },
		error: { color: 'danger', label: 'Error' },
	};
	const { color, label } = config[status] ?? { color: 'neutral', label: status };
	return <Badge color={color as 'neutral'}>{label}</Badge>;
}

export const Route = createFileRoute('/companies/$companyId/projects/')({
	component: ProjectListPage,
});
