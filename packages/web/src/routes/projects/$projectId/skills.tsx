import { createFileRoute, Link } from '@tanstack/react-router';
import { BookOpen, ExternalLink, Eye, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { MarkdownEditor } from '../../../components/markdown-editor';
import { RevisionsPanel } from '../../../components/revisions-panel';
import { SkillViewDialog } from '../../../components/skill-view-dialog';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { InPlaceForm } from '../../../components/ui/in-place-form';
import { Input } from '../../../components/ui/input';
import {
	useDeleteProjectSkill,
	useProjectSkill,
	useProjectSkillRevisions,
	useProjectSkills,
	useRestoreProjectSkill,
	useUpdateProjectSkill,
} from '../../../hooks/use-project-skills';

export const Route = createFileRoute('/projects/$projectId/skills')({
	component: ProjectSkillsPage,
});

function ProjectSkillsPage() {
	const { projectId } = Route.useParams();
	const { data: skills = [] } = useProjectSkills(projectId);
	const updateSkill = useUpdateProjectSkill(projectId);
	const deleteSkill = useDeleteProjectSkill(projectId);

	const [editingId, setEditingId] = useState<string | null>(null);
	// Independently of editing, `viewingId` drives the read-only view modal.
	const [viewingId, setViewingId] = useState<string | null>(null);
	const [name, setName] = useState('');
	const [description, setDescription] = useState('');
	const [content, setContent] = useState('');
	const [tags, setTags] = useState('');
	const [error, setError] = useState<string | null>(null);

	const { data: editingSkill } = useProjectSkill(projectId, editingId);
	const { data: viewingSkill } = useProjectSkill(projectId, viewingId);
	const { data: revisions } = useProjectSkillRevisions(projectId, editingId);
	const restoreSkill = useRestoreProjectSkill(projectId, editingId);
	useEffect(() => {
		if (editingSkill && editingSkill.id === editingId) {
			setName(editingSkill.name);
			setDescription(editingSkill.description ?? '');
			setContent(editingSkill.content);
			setTags((editingSkill.tags ?? []).join(', '));
		}
	}, [editingSkill, editingId]);

	function resetForm() {
		setEditingId(null);
		setName('');
		setDescription('');
		setContent('');
		setTags('');
		setError(null);
	}

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		if (!name.trim() || !content.trim() || !editingId) {
			setError('Name and content are required.');
			return;
		}
		const tagList = tags
			.split(/[\s,]+/)
			.map((t) => t.trim())
			.filter(Boolean);
		try {
			await updateSkill.mutateAsync({
				id: editingId,
				name: name.trim(),
				description: description.trim(),
				content,
				tags: tagList,
			});
			resetForm();
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to save skill');
		}
	}

	const projectSkills = skills.filter((s) => s.project_id !== null);
	const globalSkills = skills.filter((s) => s.project_id === null);

	return (
		<div className="space-y-6 max-w-4xl">
			<header>
				<h1 className="text-xl font-semibold flex items-center gap-2">
					<BookOpen className="size-5" />
					Skills
				</h1>
				<p className="text-sm text-text-3 mt-1">
					Reusable skill docs for this project's agents. These are scoped to this project — edit or
					remove them here. Global skills are shown below for reference and are managed on the{' '}
					<Link to="/settings/skills" className="underline hover:text-text-1">
						global Skills page
					</Link>
					.
				</p>
			</header>

			{editingId && (
				<InPlaceForm
					title="Edit skill"
					onClose={resetForm}
					onSubmit={handleSubmit}
					footer={
						<RevisionsPanel
							revisions={revisions}
							onRestore={(revisionNumber) => restoreSkill.mutateAsync(revisionNumber)}
							isRestoring={restoreSkill.isPending}
						/>
					}
				>
					<div className="flex flex-col sm:flex-row gap-2">
						<Input
							placeholder="Name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							required
							className="flex-1"
						/>
						<Input
							placeholder="Tags (comma-separated, optional)"
							value={tags}
							onChange={(e) => setTags(e.target.value)}
							className="flex-1"
						/>
					</div>
					<Input
						placeholder="Description (optional — auto-derived from content if empty)"
						value={description}
						onChange={(e) => setDescription(e.target.value)}
					/>
					<MarkdownEditor
						label="Content (markdown)"
						labelClassName="text-[13px] text-text-2"
						ariaLabel="Skill content"
						placeholder="Skill content (markdown)"
						value={content}
						onChange={setContent}
						required
						rows={10}
						className="font-mono"
						previewClassName="min-h-[200px]"
						previewTestId="skill-content-preview"
						emptyPreviewText="_(nothing to preview)_"
					/>
					{error && <p className="text-[13px] text-danger">{error}</p>}
					<div className="flex gap-2">
						<Button type="submit" size="sm" disabled={updateSkill.isPending}>
							Save changes
						</Button>
						<Button type="button" variant="secondary" size="sm" onClick={resetForm}>
							Cancel
						</Button>
					</div>
				</InPlaceForm>
			)}

			<section className="space-y-2">
				<h2 className="text-[13px] font-medium text-text-2">This project</h2>
				{projectSkills.length === 0 ? (
					<p className="text-[13px] text-text-3">
						No project-scoped skills yet. Agents create these while they work (choosing project
						scope), or an admin can scope one here from the global Skills page.
					</p>
				) : (
					<div className="flex flex-col gap-1" data-testid="project-skills-list">
						{projectSkills.map((s) => (
							<div
								key={s.id}
								className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 py-2 text-[13px]"
								data-testid="project-skill-row"
							>
								<div className="flex items-center gap-2 min-w-0 flex-1">
									<span className="font-medium">{s.name}</span>
									{s.tags?.map((t) => (
										<Badge key={t} color="neutral">
											{t}
										</Badge>
									))}
									{s.description && (
										<span className="text-xs text-text-3 truncate">{s.description}</span>
									)}
								</div>
								<span className="flex items-center gap-2 shrink-0">
									<button
										type="button"
										onClick={() => setViewingId(s.id)}
										aria-label={`View ${s.name}`}
										className="text-text-3 hover:text-text-1"
									>
										<Eye className="w-3.5 h-3.5" />
									</button>
									<button
										type="button"
										onClick={() => {
											setEditingId(s.id);
											setError(null);
										}}
										aria-label={`Edit ${s.name}`}
										className="text-text-3 hover:text-text-1"
									>
										<Pencil className="w-3.5 h-3.5" />
									</button>
									<button
										type="button"
										onClick={() => {
											if (confirm(`Delete skill "${s.name}"?`)) deleteSkill.mutate(s.id);
										}}
										aria-label={`Delete ${s.name}`}
										className="text-text-3 hover:text-danger"
									>
										<Trash2 className="w-3.5 h-3.5" />
									</button>
								</span>
							</div>
						))}
					</div>
				)}
			</section>

			{globalSkills.length > 0 && (
				<section className="space-y-2">
					<h2 className="text-[13px] font-medium text-text-2">Global (all projects)</h2>
					<div className="flex flex-col gap-1" data-testid="global-skills-list">
						{globalSkills.map((s) => (
							<div
								key={s.id}
								className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 py-2 text-[13px]"
								data-testid="global-skill-row"
							>
								<div className="flex items-center gap-2 min-w-0 flex-1">
									<span className="font-medium">{s.name}</span>
									<Badge color="neutral">Global</Badge>
									{s.tags?.map((t) => (
										<Badge key={t} color="neutral">
											{t}
										</Badge>
									))}
									{s.description && (
										<span className="text-xs text-text-3 truncate">{s.description}</span>
									)}
								</div>
								<span className="flex items-center gap-3 shrink-0">
									<button
										type="button"
										onClick={() => setViewingId(s.id)}
										aria-label={`View ${s.name}`}
										className="text-text-3 hover:text-text-1"
									>
										<Eye className="w-3.5 h-3.5" />
									</button>
									<Link
										to="/settings/skills"
										className="flex items-center gap-1 text-xs text-text-3 hover:text-text-1"
										data-testid="global-skill-manage-link"
									>
										Manage <ExternalLink className="w-3 h-3" />
									</Link>
								</span>
							</div>
						))}
					</div>
				</section>
			)}

			{skills.length === 0 && (
				<div className="flex items-center gap-2 text-[13px] text-text-3">
					<Plus className="w-3.5 h-3.5" />
					No skills available to this project yet.
				</div>
			)}

			<SkillViewDialog
				open={viewingId !== null}
				onOpenChange={(o) => !o && setViewingId(null)}
				skill={viewingSkill?.id === viewingId ? viewingSkill : undefined}
				fallbackName={skills.find((s) => s.id === viewingId)?.name}
			/>
		</div>
	);
}
