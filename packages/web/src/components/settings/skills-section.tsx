import { Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useCreateSkill, useDeleteSkill, useSkills, useSyncSkill } from '../../hooks/use-skills';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Tooltip } from '../ui/tooltip';
import { SectionHeader } from './helpers';

export function SkillsSection({ teamId }: { teamId: string }) {
	const { data: skills } = useSkills(teamId);
	const createSkill = useCreateSkill(teamId);
	const syncSkill = useSyncSkill(teamId);
	const deleteSkill = useDeleteSkill(teamId);
	const [showForm, setShowForm] = useState(false);
	const [name, setName] = useState('');
	const [sourceUrl, setSourceUrl] = useState('');
	const [description, setDescription] = useState('');

	async function handleCreate(e: React.FormEvent) {
		e.preventDefault();
		await createSkill.mutateAsync({
			name: name.trim(),
			source_url: sourceUrl.trim(),
			description: description.trim() || undefined,
		});
		setName('');
		setSourceUrl('');
		setDescription('');
		setShowForm(false);
	}

	return (
		<section>
			<div className="flex items-center justify-between mb-4">
				<SectionHeader
					title="Skills"
					desc="Markdown instruction files downloaded from GitHub or URL and injected into every agent's prompt."
				/>
				<Button variant="secondary" size="sm" onClick={() => setShowForm(!showForm)}>
					<Plus className="w-3 h-3" /> Add
				</Button>
			</div>
			{showForm && (
				<form onSubmit={handleCreate} className="flex flex-col gap-2 mb-3 max-w-lg">
					<Input
						placeholder="Name (e.g. Git Best Practices)"
						value={name}
						onChange={(e) => setName(e.target.value)}
						required
					/>
					<Input
						placeholder="Source URL (GitHub blob or raw URL)"
						value={sourceUrl}
						onChange={(e) => setSourceUrl(e.target.value)}
						required
					/>
					<Input
						placeholder="Description (optional)"
						value={description}
						onChange={(e) => setDescription(e.target.value)}
					/>
					<div className="flex gap-2">
						<Button type="submit" size="sm" disabled={createSkill.isPending}>
							{createSkill.isPending && <Loader2 className="w-3 h-3 animate-spin" />}
							Download
						</Button>
						<Button type="button" variant="secondary" size="sm" onClick={() => setShowForm(false)}>
							Cancel
						</Button>
					</div>
					{createSkill.error && (
						<p className="text-[13px] text-accent-red">
							{(createSkill.error as { message: string }).message}
						</p>
					)}
				</form>
			)}
			{skills?.length === 0 ? (
				<p className="text-[13px] text-text-subtle">No skills configured.</p>
			) : (
				<div className="flex flex-col gap-1">
					{skills?.map((s) => (
						<div
							key={s.slug}
							className="flex items-center justify-between rounded-radius-md border border-border bg-bg px-3 py-2 text-[13px]"
						>
							<div className="flex flex-col gap-0.5 min-w-0 flex-1">
								<div className="flex items-center gap-2">
									<span className="font-medium">{s.name}</span>
									<span className="text-xs text-text-subtle font-mono">{s.slug}</span>
								</div>
								{s.description && <span className="text-xs text-text-subtle">{s.description}</span>}
								{s.tags?.length > 0 && (
									<div className="flex gap-1 flex-wrap">
										{s.tags.map((tag) => (
											<span key={tag} className="text-[10px] bg-bg-subtle px-1.5 py-0.5 rounded">
												{tag}
											</span>
										))}
									</div>
								)}
								{s.source_url && (
									<span className="text-xs text-text-subtle truncate">{s.source_url}</span>
								)}
							</div>
							<div className="flex items-center gap-1">
								{s.source_url && (
									<Tooltip content="Re-download">
										<button
											type="button"
											onClick={() => syncSkill.mutate(s.slug)}
											disabled={syncSkill.isPending}
											aria-label="Re-download"
											className="text-text-subtle hover:text-text p-1"
										>
											<RefreshCw className="w-3.5 h-3.5" />
										</button>
									</Tooltip>
								)}
								<Tooltip content="Delete">
									<button
										type="button"
										onClick={() => deleteSkill.mutate(s.slug)}
										aria-label="Delete"
										className="text-text-subtle hover:text-accent-red p-1"
									>
										<Trash2 className="w-3.5 h-3.5" />
									</button>
								</Tooltip>
							</div>
						</div>
					))}
				</div>
			)}
		</section>
	);
}
