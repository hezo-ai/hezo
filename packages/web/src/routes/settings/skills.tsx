import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import {
	useCreateInstanceSkill,
	useDeleteInstanceSkill,
	useInstanceSkills,
} from '../../hooks/use-instance-skills';
import { useMe } from '../../hooks/use-me';

function InstanceSkillsPage() {
	const { data: me } = useMe();
	const { data: skills = [] } = useInstanceSkills();
	const createSkill = useCreateInstanceSkill();
	const deleteSkill = useDeleteInstanceSkill();

	const [showForm, setShowForm] = useState(false);
	const [name, setName] = useState('');
	const [description, setDescription] = useState('');
	const [content, setContent] = useState('');
	const [tags, setTags] = useState('');
	const [error, setError] = useState<string | null>(null);

	async function handleCreate(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		if (!name.trim() || !content.trim()) {
			setError('Name and content are required.');
			return;
		}
		const tagList = tags
			.split(/[\s,]+/)
			.map((t) => t.trim())
			.filter(Boolean);
		try {
			await createSkill.mutateAsync({
				name: name.trim(),
				description: description.trim() || undefined,
				content,
				tags: tagList,
			});
			setName('');
			setDescription('');
			setContent('');
			setTags('');
			setShowForm(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to create skill');
		}
	}

	const content_ =
		me && !me.is_superuser ? (
			<p className="text-[13px] text-text-muted">
				Instance skills are managed by the Admin. You don't have access to this page.
			</p>
		) : (
			<>
				<div className="flex items-start justify-between gap-3 mb-4">
					<div>
						<h1 className="text-[22px] font-medium">Instance skills</h1>
						<p className="text-[13px] text-text-muted mt-1 max-w-[680px]">
							Reusable skill docs shared with every team's agents. A team-scoped skill with the same
							slug overrides the instance one for that team.
						</p>
					</div>
					<Button variant="secondary" size="sm" onClick={() => setShowForm((s) => !s)}>
						<Plus className="w-3 h-3" /> Add
					</Button>
				</div>

				{showForm && (
					<form onSubmit={handleCreate} className="flex flex-col gap-2 mb-4">
						<div className="flex flex-col sm:flex-row gap-2">
							<Input
								placeholder="Name (e.g. Commit conventions)"
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
						<textarea
							placeholder="Skill content (markdown)"
							value={content}
							onChange={(e) => setContent(e.target.value)}
							required
							rows={8}
							className="w-full rounded-radius-md border border-border bg-bg px-3 py-2 text-[13px] font-mono focus:outline-none focus:ring-1 focus:ring-accent"
						/>
						{error && <p className="text-[13px] text-accent-red">{error}</p>}
						<div className="flex gap-2">
							<Button type="submit" size="sm" disabled={createSkill.isPending}>
								Add skill
							</Button>
							<Button
								type="button"
								variant="secondary"
								size="sm"
								onClick={() => {
									setShowForm(false);
									setError(null);
								}}
							>
								Cancel
							</Button>
						</div>
					</form>
				)}

				{!skills.length ? (
					<p className="text-[13px] text-text-muted">
						No instance skills yet. Add one above to share it across every team.
					</p>
				) : (
					<div className="flex flex-col gap-1">
						{skills.map((s) => (
							<div
								key={s.id}
								className="flex items-center justify-between rounded-radius-md border border-border bg-bg px-3 py-2 text-[13px]"
							>
								<div className="flex items-center gap-2 min-w-0 flex-1">
									<span className="font-medium">{s.name}</span>
									{s.tags?.map((t) => (
										<Badge key={t} color="neutral">
											{t}
										</Badge>
									))}
									{s.description && (
										<span className="text-xs text-text-subtle truncate">{s.description}</span>
									)}
								</div>
								<button
									type="button"
									onClick={() => {
										if (confirm(`Delete instance skill "${s.name}"?`)) {
											deleteSkill.mutate(s.slug);
										}
									}}
									aria-label="Delete"
									className="text-text-subtle hover:text-accent-red"
								>
									<Trash2 className="w-3.5 h-3.5" />
								</button>
							</div>
						))}
					</div>
				)}
			</>
		);

	return (
		<div className="max-w-[900px] mx-auto w-full px-4 py-4 md:px-6 md:py-5 lg:px-8 lg:py-6">
			<div className="flex items-center gap-3 mb-6">
				<Link
					to="/settings"
					className="text-text-muted hover:text-text inline-flex items-center gap-1 text-[13px]"
				>
					<ArrowLeft className="w-3.5 h-3.5" /> Settings
				</Link>
			</div>
			{content_}
		</div>
	);
}

export const Route = createFileRoute('/settings/skills')({
	component: InstanceSkillsPage,
});
