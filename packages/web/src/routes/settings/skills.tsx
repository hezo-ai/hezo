import { createFileRoute } from '@tanstack/react-router';
import { ExternalLink, Loader2, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { MarkdownProse } from '../../components/markdown-prose';
import { SettingsBreadcrumb } from '../../components/settings-breadcrumb';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { InfoTooltip } from '../../components/ui/info-tooltip';
import { Input } from '../../components/ui/input';
import {
	useCreateInstanceSkill,
	useDeleteInstanceSkill,
	useInstallRegistrySkill,
	useInstanceSkill,
	useInstanceSkills,
	useRegistryTokenStatus,
	useSearchRegistrySkills,
	useSetRegistryToken,
	useUpdateInstanceSkill,
} from '../../hooks/use-instance-skills';
import { useMe } from '../../hooks/use-me';

function InstanceSkillsPage() {
	const { data: me } = useMe();
	const { data: skills = [] } = useInstanceSkills();
	const createSkill = useCreateInstanceSkill();
	const updateSkill = useUpdateInstanceSkill();
	const deleteSkill = useDeleteInstanceSkill();

	const [showForm, setShowForm] = useState(false);
	const [showSearch, setShowSearch] = useState(false);
	// `editingSlug` null = the form (when open) creates; otherwise it edits.
	const [editingSlug, setEditingSlug] = useState<string | null>(null);
	const [name, setName] = useState('');
	const [description, setDescription] = useState('');
	const [content, setContent] = useState('');
	const [contentMode, setContentMode] = useState<'edit' | 'preview'>('edit');
	const [tags, setTags] = useState('');
	const [error, setError] = useState<string | null>(null);

	// Editing needs the full row (content is omitted from the list endpoint), so
	// fetch it by slug and populate the form once it arrives.
	const { data: editingSkill } = useInstanceSkill(editingSlug);
	useEffect(() => {
		if (editingSkill && editingSkill.slug === editingSlug) {
			setName(editingSkill.name);
			setDescription(editingSkill.description ?? '');
			setContent(editingSkill.content);
			setTags((editingSkill.tags ?? []).join(', '));
		}
	}, [editingSkill, editingSlug]);

	function resetForm() {
		setShowForm(false);
		setEditingSlug(null);
		setName('');
		setDescription('');
		setContent('');
		setContentMode('edit');
		setTags('');
		setError(null);
	}

	function openCreate() {
		resetForm();
		setShowForm(true);
	}

	function openEdit(slug: string) {
		setEditingSlug(slug);
		setError(null);
		setShowForm(true);
	}

	async function handleSubmit(e: React.FormEvent) {
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
			if (editingSlug) {
				await updateSkill.mutateAsync({
					slug: editingSlug,
					name: name.trim(),
					description: description.trim(),
					content,
					tags: tagList,
				});
			} else {
				await createSkill.mutateAsync({
					name: name.trim(),
					description: description.trim() || undefined,
					content,
					tags: tagList,
				});
			}
			resetForm();
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to save skill');
		}
	}

	const content_ =
		me && !me.is_superuser ? (
			<p className="text-[13px] text-text-2">
				Instance skills are managed by the Admin. You don't have access to this page.
			</p>
		) : (
			<>
				<div className="flex items-start justify-between gap-3 mb-4">
					<div>
						<div className="flex items-center gap-1.5">
							<h1 className="text-[22px] font-medium">Skills</h1>
							<InfoTooltip
								label="About skills"
								content="Reusable, project-independent skill docs shared with every team's agents. Agents also discover new skills from skills.sh and add them here."
								data-testid="skills-info"
							/>
						</div>
						<p className="text-[13px] text-text-2 mt-1 max-w-[680px]">
							Reusable skill docs shared with every team's agents — author them here, search and add
							them from skills.sh, or let an agent fetch one while it works.
						</p>
					</div>
					<div className="flex items-center gap-2 shrink-0">
						<Button
							variant="secondary"
							size="sm"
							onClick={() => setShowSearch((s) => !s)}
							data-testid="toggle-search"
						>
							<Search className="w-3 h-3" /> Search skills.sh
						</Button>
						<Button
							variant="secondary"
							size="sm"
							onClick={() => (showForm ? resetForm() : openCreate())}
						>
							<Plus className="w-3 h-3" /> Add
						</Button>
					</div>
				</div>

				{showSearch && <RegistrySearch />}

				{showForm && (
					<form onSubmit={handleSubmit} className="flex flex-col gap-2 mb-4">
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
						<div className="flex items-center justify-between">
							<span className="text-[13px] text-text-2">Content (markdown)</span>
							<div
								role="tablist"
								aria-label="Content view mode"
								className="inline-flex rounded-md border border-border-subtle bg-surface-2 p-0.5 text-xs"
							>
								<button
									type="button"
									role="tab"
									aria-selected={contentMode === 'edit'}
									onClick={() => setContentMode('edit')}
									className={`px-2.5 py-1 rounded ${
										contentMode === 'edit'
											? 'bg-surface text-text-1 shadow-sm'
											: 'text-text-2 hover:text-text-1'
									}`}
								>
									Edit
								</button>
								<button
									type="button"
									role="tab"
									aria-selected={contentMode === 'preview'}
									onClick={() => setContentMode('preview')}
									className={`px-2.5 py-1 rounded ${
										contentMode === 'preview'
											? 'bg-surface text-text-1 shadow-sm'
											: 'text-text-2 hover:text-text-1'
									}`}
								>
									Preview
								</button>
							</div>
						</div>
						{contentMode === 'edit' ? (
							<textarea
								aria-label="Skill content"
								placeholder="Skill content (markdown)"
								value={content}
								onChange={(e) => setContent(e.target.value)}
								required
								rows={10}
								className="w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] font-mono focus:outline-none focus:ring-1 focus:ring-accent"
							/>
						) : (
							<div
								data-testid="skill-content-preview"
								className="min-h-[200px] rounded-md border border-border bg-surface-2 px-3 py-2 text-sm"
							>
								<MarkdownProse>{content || '_(nothing to preview)_'}</MarkdownProse>
							</div>
						)}
						{error && <p className="text-[13px] text-danger">{error}</p>}
						<div className="flex gap-2">
							<Button
								type="submit"
								size="sm"
								disabled={createSkill.isPending || updateSkill.isPending}
							>
								{editingSlug ? 'Save changes' : 'Add skill'}
							</Button>
							<Button type="button" variant="secondary" size="sm" onClick={resetForm}>
								Cancel
							</Button>
						</div>
					</form>
				)}

				{!skills.length ? (
					<p className="text-[13px] text-text-2">
						No instance skills yet. Add one above to share it across every team.
					</p>
				) : (
					<div className="flex flex-col gap-1">
						{skills.map((s) => (
							<div
								key={s.id}
								className="flex items-center justify-between rounded-md border border-border bg-surface px-3 py-2 text-[13px]"
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
										onClick={() => openEdit(s.slug)}
										aria-label={`Edit ${s.name}`}
										className="text-text-3 hover:text-text-1"
									>
										<Pencil className="w-3.5 h-3.5" />
									</button>
									<button
										type="button"
										onClick={() => {
											if (confirm(`Delete instance skill "${s.name}"?`)) {
												deleteSkill.mutate(s.slug);
											}
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
			</>
		);

	return (
		<div className="max-w-[900px] w-full px-4 py-4 md:px-6 md:py-5 lg:px-8 lg:py-6">
			<SettingsBreadcrumb label="Skills" />
			{content_}
		</div>
	);
}

/**
 * Search skills.sh and add a result straight into the instance catalog. The
 * registry API needs a bearer token, so this panel is gated on a configured
 * token (agents don't need it — they use the `npx skills` CLI in the container).
 */
function RegistrySearch() {
	const { data: tokenStatus } = useRegistryTokenStatus();
	const setToken = useSetRegistryToken();
	const installSkill = useInstallRegistrySkill();

	const [tokenInput, setTokenInput] = useState('');
	const [queryInput, setQueryInput] = useState('');
	const [submitted, setSubmitted] = useState('');
	const [installingId, setInstallingId] = useState<string | null>(null);

	const search = useSearchRegistrySkills(submitted);
	const configured = tokenStatus?.configured ?? false;

	async function handleInstall(id: string) {
		setInstallingId(id);
		try {
			await installSkill.mutateAsync(id);
		} finally {
			setInstallingId(null);
		}
	}

	return (
		<div className="mb-4 rounded-md border border-border bg-surface-2 p-3">
			{!configured ? (
				<div className="flex flex-col gap-2">
					<p className="text-[13px] text-text-2">
						Searching skills.sh needs a skills.sh API token. Paste one to enable search and add.
						Agents discover skills without it (via the <code>npx skills</code> CLI).
					</p>
					<div className="flex flex-col sm:flex-row gap-2">
						<Input
							type="password"
							placeholder="skills.sh API token"
							value={tokenInput}
							onChange={(e) => setTokenInput(e.target.value)}
							className="flex-1"
							aria-label="skills.sh API token"
						/>
						<Button
							size="sm"
							disabled={!tokenInput.trim() || setToken.isPending}
							onClick={() =>
								setToken.mutate(tokenInput.trim(), { onSuccess: () => setTokenInput('') })
							}
						>
							Save token
						</Button>
					</div>
				</div>
			) : (
				<div className="flex flex-col gap-2">
					<form
						className="flex gap-2"
						onSubmit={(e) => {
							e.preventDefault();
							setSubmitted(queryInput.trim());
						}}
					>
						<Input
							placeholder="Search skills.sh (e.g. react, stripe, playwright)"
							value={queryInput}
							onChange={(e) => setQueryInput(e.target.value)}
							className="flex-1"
							aria-label="Search skills.sh"
						/>
						<Button type="submit" size="sm" disabled={queryInput.trim().length < 2}>
							<Search className="w-3 h-3" /> Search
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => setToken.mutate('')}
							title="Clear the stored token"
						>
							Clear token
						</Button>
					</form>

					{search.isFetching && (
						<div className="flex items-center gap-1.5 text-[13px] text-text-2">
							<Loader2 className="w-3.5 h-3.5 animate-spin" /> Searching…
						</div>
					)}
					{search.error && (
						<p className="text-[13px] text-danger">
							{(search.error as { message?: string }).message ?? 'Search failed'}
						</p>
					)}
					{search.data?.length === 0 && !search.isFetching && submitted && (
						<p className="text-[13px] text-text-2">No results for “{submitted}”.</p>
					)}
					{search.data && search.data.length > 0 && (
						<div className="flex flex-col gap-1">
							{search.data.map((r) => (
								<div
									key={r.id}
									className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 py-2 text-[13px]"
								>
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-2">
											<span className="font-medium truncate">{r.name}</span>
											{r.url && (
												<a
													href={r.url}
													target="_blank"
													rel="noopener noreferrer"
													className="text-text-3 hover:text-text-1"
													aria-label={`Open ${r.name} on skills.sh`}
												>
													<ExternalLink className="w-3 h-3" />
												</a>
											)}
										</div>
										<div className="text-xs text-text-3 truncate">
											{r.source}
											{r.installs > 0 && ` · ${r.installs.toLocaleString()} installs`}
										</div>
									</div>
									<Button
										size="sm"
										variant="secondary"
										disabled={installSkill.isPending && installingId === r.id}
										onClick={() => handleInstall(r.id)}
									>
										{installSkill.isPending && installingId === r.id ? (
											<Loader2 className="w-3 h-3 animate-spin" />
										) : (
											<Plus className="w-3 h-3" />
										)}
										Add
									</Button>
								</div>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
}

export const Route = createFileRoute('/settings/skills')({
	component: InstanceSkillsPage,
});
