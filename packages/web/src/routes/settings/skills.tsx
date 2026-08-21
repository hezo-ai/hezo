import { createFileRoute } from '@tanstack/react-router';
import {
	ChevronDown,
	ExternalLink,
	Eye,
	History,
	Loader2,
	Pencil,
	Plus,
	Search,
	Sparkles,
	Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { RevisionHistoryDialog } from '../../components/document-review/revision-history-dialog';
import { ViewingRevisionBanner } from '../../components/document-review/viewing-revision-banner';
import { InfiniteScrollSentinel } from '../../components/infinite-scroll-sentinel';
import { MarkdownEditor } from '../../components/markdown-editor';
import { MarkdownProse } from '../../components/markdown-prose';
import { SkillViewDialog } from '../../components/skill-view-dialog';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { ConfirmDialog } from '../../components/ui/confirm-dialog';
import { InPlaceForm } from '../../components/ui/in-place-form';
import { InfoTooltip } from '../../components/ui/info-tooltip';
import { Input } from '../../components/ui/input';
import {
	SearchableSelect,
	type SearchableSelectOption,
} from '../../components/ui/searchable-select';
import {
	type SkillListItem,
	useCreateInstanceSkill,
	useDeleteInstanceSkill,
	useInstallDefaultSkills,
	useInstallRegistrySkill,
	useInstanceSkill,
	useInstanceSkillRevisions,
	useInstanceSkills,
	useMissingDefaultSkills,
	useRegistryTokenStatus,
	useRestoreInstanceSkill,
	useSearchRegistrySkills,
	useSetRegistryToken,
	useUpdateInstanceSkill,
	useUpdateInstanceSkillScope,
} from '../../hooks/use-instance-skills';
import { useMe } from '../../hooks/use-me';
import { useAllVisibleProjects } from '../../hooks/use-projects';
import { buildDocVersionHistory, type DocVersionEntry } from '../../lib/doc-version-history';

// Scope sentinel: create against / re-scope to "all projects" (a global skill,
// project_id null). Any other option value is a concrete project id.
const ALL_PROJECTS = 'all';

function InstanceSkillsPage() {
	const { data: me } = useMe();
	const { data: skillPages, hasNextPage, isFetchingNextPage, fetchNextPage } = useInstanceSkills();
	const skills = useMemo(() => skillPages?.pages.flatMap((p) => p.data) ?? [], [skillPages]);
	const { projects } = useAllVisibleProjects();
	const createSkill = useCreateInstanceSkill();
	const updateSkill = useUpdateInstanceSkill();
	const deleteSkill = useDeleteInstanceSkill();
	const { data: missingData } = useMissingDefaultSkills(!!me?.is_superuser);
	const installDefaults = useInstallDefaultSkills();
	const missingDefaults = missingData?.missing ?? [];

	const [showForm, setShowForm] = useState(false);
	const [showSearch, setShowSearch] = useState(false);
	const [confirmDefaults, setConfirmDefaults] = useState(false);
	// `editingId` null = the form (when open) creates; otherwise it edits.
	const [editingId, setEditingId] = useState<string | null>(null);
	// Independently of editing, `viewingId` drives the read-only view modal.
	const [viewingId, setViewingId] = useState<string | null>(null);
	const [createScope, setCreateScope] = useState<string>(ALL_PROJECTS);
	const [name, setName] = useState('');
	const [description, setDescription] = useState('');
	const [content, setContent] = useState('');
	const [tags, setTags] = useState('');
	const [error, setError] = useState<string | null>(null);

	// Shared "All projects" + every project — drives both the create-form scope
	// picker and each row's inline re-scope dropdown.
	const scopeOptions = useMemo<SearchableSelectOption[]>(
		() => [
			{ value: ALL_PROJECTS, label: 'All projects' },
			...projects.map((p) => ({ value: p.id, label: p.name, description: p.teamName })),
		],
		[projects],
	);
	const createScopeName =
		createScope === ALL_PROJECTS
			? null
			: (projects.find((p) => p.id === createScope)?.name ?? 'this project');

	// Editing needs the full row (content is omitted from the list endpoint), so
	// fetch it by id and populate the form once it arrives.
	const { data: editingSkill } = useInstanceSkill(editingId);
	const { data: viewingSkill } = useInstanceSkill(viewingId);
	const { data: revisions } = useInstanceSkillRevisions(editingId);
	const restoreSkill = useRestoreInstanceSkill(editingId);
	const [historyOpen, setHistoryOpen] = useState(false);
	// The whole entry, not just its number — the body is rendered from it.
	const [viewingRevision, setViewingRevision] = useState<DocVersionEntry | null>(null);
	const versionEntries = useMemo(
		() => (editingSkill ? buildDocVersionHistory(editingSkill, revisions) : []),
		[editingSkill, revisions],
	);
	useEffect(() => {
		if (editingSkill && editingSkill.id === editingId) {
			setName(editingSkill.name);
			setDescription(editingSkill.description ?? '');
			setContent(editingSkill.content);
			setTags((editingSkill.tags ?? []).join(', '));
		}
	}, [editingSkill, editingId]);

	function resetForm() {
		setShowForm(false);
		setEditingId(null);
		setHistoryOpen(false);
		setViewingRevision(null);
		setCreateScope(ALL_PROJECTS);
		setName('');
		setDescription('');
		setContent('');
		setTags('');
		setError(null);
	}

	function openCreate() {
		resetForm();
		setShowForm(true);
	}

	function openEdit(id: string) {
		setEditingId(id);
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
			if (editingId) {
				await updateSkill.mutateAsync({
					id: editingId,
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
					project_id: createScope === ALL_PROJECTS ? null : createScope,
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
								content="Reusable skill docs for your agents. A skill is either global (shared with every project) or scoped to one project. Change a skill's scope with the drop-down on its row."
								data-testid="skills-info"
							/>
						</div>
						<p className="text-[13px] text-text-2 mt-1 max-w-[680px]">
							Every skill across every project. Each project's runs see its own skills plus any
							scoped to "All projects" - author them here, search skills.sh, or let an agent create
							one while it works.
						</p>
					</div>
					<div className="flex items-center gap-2 shrink-0">
						{missingDefaults.length > 0 && (
							<Button
								size="sm"
								onClick={() => setConfirmDefaults(true)}
								data-testid="add-default-skills"
							>
								<Sparkles className="w-3 h-3" /> Add default skills ({missingDefaults.length})
							</Button>
						)}
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

				{showSearch && <RegistrySearch onClose={() => setShowSearch(false)} />}

				{showForm && (
					<InPlaceForm
						title={
							editingId
								? 'Edit skill'
								: createScope === ALL_PROJECTS
									? 'Add skill (All projects)'
									: `Add skill - ${createScopeName}`
						}
						onClose={resetForm}
						onSubmit={handleSubmit}
						footer={
							/* Outside the <form> so this button never submits the editor. */
							editingId ? (
								<div className="mt-4 flex justify-end border-t border-border pt-3">
									<Button
										type="button"
										variant="ghost"
										size="sm"
										onClick={() => setHistoryOpen(true)}
										data-testid="skill-history"
										aria-label="Revision history"
									>
										<History className="w-3.5 h-3.5" />
										<span className="hidden sm:inline">History</span>
									</Button>
								</div>
							) : undefined
						}
					>
						{viewingRevision && viewingRevision.revisionNumber !== null ? (
							<>
								<ViewingRevisionBanner
									revisionNumber={viewingRevision.revisionNumber}
									timestamp={viewingRevision.timestamp}
									authorName={viewingRevision.authorName}
									onViewLatest={() => setViewingRevision(null)}
								/>
								<div
									className="min-h-[200px] rounded-md border border-border bg-surface-2 px-4 py-3"
									data-testid="skill-revision-body"
								>
									<MarkdownProse>
										{viewingRevision.content || '_(this version was empty)_'}
									</MarkdownProse>
								</div>
							</>
						) : (
							<>
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
									placeholder="Description (optional - auto-derived from content if empty)"
									value={description}
									onChange={(e) => setDescription(e.target.value)}
								/>
								{/* Scope is chosen at create time; existing skills re-scope via the
						    per-row drop-down (a skill's slug is namespaced per scope). */}
								{!editingId && (
									<div className="flex flex-wrap items-center gap-2">
										<span className="text-[13px] text-text-2">Scope</span>
										<SearchableSelect
											options={scopeOptions}
											value={createScope}
											onChange={setCreateScope}
											searchPlaceholder="Search projects…"
											emptyLabel="No projects"
											testId="create-scope-select"
										/>
									</div>
								)}
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
									<Button
										type="submit"
										size="sm"
										disabled={createSkill.isPending || updateSkill.isPending}
									>
										{editingId ? 'Save changes' : 'Add skill'}
									</Button>
									<Button type="button" variant="secondary" size="sm" onClick={resetForm}>
										Cancel
									</Button>
								</div>
							</>
						)}
					</InPlaceForm>
				)}

				<RevisionHistoryDialog
					open={historyOpen}
					onOpenChange={setHistoryOpen}
					label={editingSkill?.name ?? 'Skill'}
					entries={versionEntries}
					viewingRevision={viewingRevision?.revisionNumber ?? null}
					onView={(entry) => {
						setViewingRevision(entry.isCurrent ? null : entry);
						setHistoryOpen(false);
					}}
					onRestore={async (rev) => {
						await restoreSkill.mutateAsync(rev);
						setViewingRevision(null);
					}}
					isRestoring={restoreSkill.isPending}
				/>

				{!skills.length ? (
					<p className="text-[13px] text-text-2">
						No skills yet. Add one above - global, or scoped to a project.
					</p>
				) : (
					<div className="flex flex-col gap-1">
						{skills.map((s) => (
							<InstanceSkillRow
								key={s.id}
								skill={s}
								scopeOptions={scopeOptions}
								onView={() => setViewingId(s.id)}
								onEdit={() => openEdit(s.id)}
								onDelete={() => {
									if (confirm(`Delete skill "${s.name}"?`)) deleteSkill.mutate(s.id);
								}}
							/>
						))}
						<InfiniteScrollSentinel
							hasNextPage={hasNextPage}
							isFetchingNextPage={isFetchingNextPage}
							onLoadMore={fetchNextPage}
							testId="instance-skills"
						/>
					</div>
				)}
			</>
		);

	return (
		<div className="max-w-[900px]">
			{content_}
			<SkillViewDialog
				open={viewingId !== null}
				onOpenChange={(o) => !o && setViewingId(null)}
				skill={viewingSkill?.id === viewingId ? viewingSkill : undefined}
				fallbackName={skills.find((s) => s.id === viewingId)?.name}
			/>
			<ConfirmDialog
				open={confirmDefaults}
				onOpenChange={setConfirmDefaults}
				title={`Add ${missingDefaults.length} default skill${missingDefaults.length === 1 ? '' : 's'}?`}
				confirmLabel="Add skills"
				description={
					<>
						These recommended global skills will be added to this instance. They'll appear like any
						skill you authored - edit, delete, or re-scope them freely.
						<span className="mt-2 block font-medium text-text-1" data-testid="default-skill-names">
							{missingDefaults.map((m) => m.name).join(', ')}
						</span>
					</>
				}
				onConfirm={async () => {
					await installDefaults.mutateAsync(undefined);
				}}
			/>
		</div>
	);
}

interface InstanceSkillRowProps {
	skill: SkillListItem;
	scopeOptions: SearchableSelectOption[];
	onView: () => void;
	onEdit: () => void;
	onDelete: () => void;
}

function InstanceSkillRow({
	skill,
	scopeOptions,
	onView,
	onEdit,
	onDelete,
}: InstanceSkillRowProps) {
	const updateScope = useUpdateInstanceSkillScope();
	const [rowError, setRowError] = useState<string | null>(null);

	const scopeLabel = skill.project_id ? (skill.project_name ?? 'Project') : 'All projects';
	const scopeValue = skill.project_id ?? ALL_PROJECTS;
	const scopeTone = skill.project_id
		? 'bg-info-soft text-info-soft-fg'
		: 'bg-neutral-soft text-neutral-soft-fg';

	const changeScope = (next: string) => {
		setRowError(null);
		const nextProjectId = next === ALL_PROJECTS ? null : next;
		if (nextProjectId === (skill.project_id ?? null)) return; // no-op
		updateScope.mutate(
			{ id: skill.id, project_id: nextProjectId },
			{
				onError: (e: unknown) =>
					setRowError(e instanceof Error ? e.message : 'Failed to change scope'),
			},
		);
	};

	const scopeTrigger = (
		<button
			type="button"
			data-testid="instance-skill-scope"
			aria-label={`Scope: ${scopeLabel}. Change scope`}
			disabled={updateScope.isPending}
			className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full h-5 pl-2 pr-1.5 text-[11.5px] font-medium outline-none cursor-pointer transition-opacity hover:opacity-80 focus:ring-1 focus:ring-border-strong disabled:opacity-50 ${scopeTone}`}
		>
			{updateScope.isPending ? 'Saving…' : scopeLabel}
			<ChevronDown className="w-3 h-3 opacity-70" />
		</button>
	);

	return (
		<div
			className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 py-2 text-[13px]"
			data-testid="instance-skill-row"
		>
			<div className="flex flex-col gap-1 min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-2">
					<span className="font-medium">{skill.name}</span>
					{skill.readonly ? (
						<Badge color="neutral">Built-in</Badge>
					) : (
						<SearchableSelect
							options={scopeOptions}
							value={scopeValue}
							onChange={changeScope}
							trigger={scopeTrigger}
							searchPlaceholder="Search projects…"
							emptyLabel="No projects"
							testId="instance-skill-scope-select"
						/>
					)}
					{skill.tags?.map((t) => (
						<Badge key={t} color="neutral">
							{t}
						</Badge>
					))}
				</div>
				{skill.description && (
					<span className="text-xs text-text-3 truncate">{skill.description}</span>
				)}
			</div>
			<span className="flex items-center gap-2 shrink-0">
				{rowError && <span className="text-xs text-danger">{rowError}</span>}
				<button
					type="button"
					onClick={onView}
					aria-label={`View ${skill.name}`}
					className="text-text-3 hover:text-text-1"
				>
					<Eye className="w-3.5 h-3.5" />
				</button>
				{!skill.readonly && (
					<>
						<button
							type="button"
							onClick={onEdit}
							aria-label={`Edit ${skill.name}`}
							className="text-text-3 hover:text-text-1"
						>
							<Pencil className="w-3.5 h-3.5" />
						</button>
						<button
							type="button"
							onClick={onDelete}
							aria-label={`Delete ${skill.name}`}
							className="text-text-3 hover:text-danger"
						>
							<Trash2 className="w-3.5 h-3.5" />
						</button>
					</>
				)}
			</span>
		</div>
	);
}

/**
 * Search skills.sh and add a result straight into the instance catalog. The
 * registry API needs a bearer token, so this panel is gated on a configured
 * token (agents don't need it — they use the `npx skills` CLI in the container).
 */
function RegistrySearch({ onClose }: { onClose: () => void }) {
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
		<InPlaceForm title="Search skills.sh" onClose={onClose} data-testid="registry-search-panel">
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
		</InPlaceForm>
	);
}

export const Route = createFileRoute('/settings/skills')({
	component: InstanceSkillsPage,
});
