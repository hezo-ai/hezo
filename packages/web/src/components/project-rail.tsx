import { Link, useParams } from '@tanstack/react-router';
import { FolderKanban, Home, Plus } from 'lucide-react';
import { useState } from 'react';
import { useCreateProject, useProjects } from '../hooks/use-projects';
import { Avatar, avatarColorFromString } from './ui/avatar';

function getInitials(name: string): string {
	const words = name.split(/\s+/);
	if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
	return name.slice(0, 2).toUpperCase();
}

export function ProjectRail({ companyId }: { companyId: string }) {
	const { data: projects } = useProjects(companyId);
	const params = useParams({ strict: false });
	const activeProjectId = (params as Record<string, string>).projectId;
	const [creating, setCreating] = useState(false);
	const [newName, setNewName] = useState('');
	const createProject = useCreateProject(companyId);

	async function handleCreate(e: React.FormEvent) {
		e.preventDefault();
		if (!newName.trim()) return;
		await createProject.mutateAsync({ name: newName.trim() });
		setNewName('');
		setCreating(false);
	}

	return (
		<aside className="w-[60px] shrink-0 border-r border-border bg-bg-subtle flex flex-col items-center py-3 gap-2 overflow-y-auto">
			<Link
				to="/companies"
				className="flex items-center justify-center w-[36px] h-[36px] rounded-full text-text-muted hover:text-text hover:bg-bg-muted/40 transition-colors mb-1"
				title="All companies"
			>
				<Home className="w-4 h-4" />
			</Link>

			{projects?.length === 0 && !creating && (
				<div className="flex items-center justify-center w-[36px] h-[36px] text-text-subtle opacity-40">
					<FolderKanban className="w-4 h-4" />
				</div>
			)}

			{projects?.map((project) => {
				const isActive = project.slug === activeProjectId;
				return (
					<Link
						key={project.id}
						to="/companies/$companyId/projects/$projectId"
						params={{ companyId, projectId: project.slug }}
						className={`relative group ${isActive ? '' : 'opacity-60 hover:opacity-100'} transition-opacity`}
						title={project.name}
					>
						{isActive && (
							<span className="absolute -left-[10px] top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r-full bg-primary" />
						)}
						<Avatar
							initials={getInitials(project.name)}
							size="md"
							color={avatarColorFromString(project.name)}
							className={isActive ? 'ring-2 ring-primary ring-offset-2 ring-offset-bg-subtle' : ''}
						/>
					</Link>
				);
			})}

			{creating ? (
				<form onSubmit={handleCreate} className="flex flex-col items-center gap-1">
					<input
						type="text"
						value={newName}
						onChange={(e) => setNewName(e.target.value)}
						placeholder="Name"
						className="w-[52px] text-[10px] px-1 py-0.5 rounded border border-border bg-bg text-text text-center"
						ref={(el) => el?.focus()}
						onBlur={() => {
							if (!newName.trim()) setCreating(false);
						}}
						onKeyDown={(e) => {
							if (e.key === 'Escape') setCreating(false);
						}}
					/>
				</form>
			) : (
				<button
					type="button"
					onClick={() => setCreating(true)}
					className="mt-1 w-[36px] h-[36px] rounded-full border border-dashed border-border-hover flex items-center justify-center text-text-subtle hover:text-text hover:border-text-muted transition-colors cursor-pointer"
					title="New project"
				>
					<Plus className="w-4 h-4" />
				</button>
			)}
		</aside>
	);
}
