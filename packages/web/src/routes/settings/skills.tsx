import { createFileRoute } from '@tanstack/react-router';
import {
	ChevronDown,
	ExternalLink,
	Eye,
	History,
	Loader2,
	Pencil,
	Plus,
	RefreshCw,
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
	useDefaultSkillStatus,
	useDeleteInstanceSkill,
	useInstallDefaultSkills,
	useInstallRegistrySkill,
	useInstanceSkill,
	useInstanceSkillRevisions,
	useInstanceSkills,
	useRefreshDefaultSkills,
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
import { Trans, useI18n } from '../../lib/i18n';

// Scope sentinel: create against / re-scope to "all projects" (a global skill,
// project_id null). Any other option value is a concrete project id.
const ALL_PROJECTS = 'all';

function InstanceSkillsPage() {
	const { t, plural } = useI18n();
	const { data: me } = useMe();
	const { data: skillPages, hasNextPage, isFetchingNextPage, fetchNextPage } = useInstanceSkills();
	const skills = useMemo(() => skillPages?.pages.flatMap((p) => p.data) ?? [], [skillPages]);
	const { projects } = useAllVisibleProjects();
	const createSkill = useCreateInstanceSkill();
	const updateSkill = useUpdateInstanceSkill();
	const deleteSkill = useDeleteInstanceSkill();
	const { data: defaultsData } = useDefaultSkillStatus(!!me?.is_superuser);
	const installDefaults = useInstallDefaultSkills();
	const refreshDefaults = useRefreshDefaultSkills();
	const missingDefaults = defaultsData?.missing ?? [];
	const outdatedDefaults = defaultsData?.outdated ?? [];
	// Split by whether the operator edited the installed copy: refreshing a clean
	// skill restores what Hezo ships, refreshing an edited one discards their
	// work, so the two never share a confirmation.
	const cleanOutdated = outdatedDefaults.filter((o) => !o.locally_edited);
	const editedOutdated = outdatedDefaults.filter((o) => o.locally_edited);

	const [showForm, setShowForm] = useState(false);
	const [showSearch, setShowSearch] = useState(false);
	const [confirmDefaults, setConfirmDefaults] = useState(false);
	const [confirmRefresh, setConfirmRefresh] = useState(false);
	const [confirmRefreshEdited, setConfirmRefreshEdited] = useState(false);
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
			{ value: ALL_PROJECTS, label: t('settings.skills.allProjects') },
			...projects.map((p) => ({ value: p.id, label: p.name, description: p.teamName })),
		],
		[projects, t],
	);
	const createScopeName =
		createScope === ALL_PROJECTS
			? null
			: (projects.find((p) => p.id === createScope)?.name ?? t('settings.skills.thisProject'));

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
			setError(t('settings.skills.error.required'));
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
			setError(err instanceof Error ? err.message : t('settings.skills.error.save'));
		}
	}

	const content_ =
		me && !me.is_superuser ? (
			<p className="text-[13px] text-text-2">{t('settings.skills.noAccess')}</p>
		) : (
			<>
				<div className="flex items-start justify-between gap-3 mb-4">
					<div>
						<div className="flex items-center gap-1.5">
							<h1 className="text-[22px] font-medium">{t('settings.skills')}</h1>
							<InfoTooltip
								label={t('settings.skills.about.label')}
								content={t('settings.skills.about.content')}
								data-testid="skills-info"
							/>
						</div>
						<p className="text-[13px] text-text-2 mt-1 max-w-[680px]">
							{t('settings.skills.intro')}
						</p>
					</div>
					<div className="flex flex-wrap items-center justify-end gap-2 sm:shrink-0">
						{missingDefaults.length > 0 && (
							<Button
								size="sm"
								onClick={() => setConfirmDefaults(true)}
								data-testid="add-default-skills"
							>
								<Sparkles className="w-3 h-3" />{' '}
								{t('settings.skills.defaults.add', { count: missingDefaults.length })}
							</Button>
						)}
						{cleanOutdated.length > 0 && (
							<Button
								variant="secondary"
								size="sm"
								onClick={() => setConfirmRefresh(true)}
								data-testid="refresh-default-skills"
							>
								<RefreshCw className="w-3 h-3" />{' '}
								{t('settings.skills.defaults.update', { count: cleanOutdated.length })}
							</Button>
						)}
						{editedOutdated.length > 0 && (
							<Button
								variant="secondary"
								size="sm"
								onClick={() => setConfirmRefreshEdited(true)}
								data-testid="refresh-edited-default-skills"
							>
								<RefreshCw className="w-3 h-3" />{' '}
								{t('settings.skills.defaults.updateEdited', { count: editedOutdated.length })}
							</Button>
						)}
						<Button
							variant="secondary"
							size="sm"
							onClick={() => setShowSearch((s) => !s)}
							data-testid="toggle-search"
						>
							<Search className="w-3 h-3" /> {t('settings.skills.registry.title')}
						</Button>
						<Button
							variant="secondary"
							size="sm"
							onClick={() => (showForm ? resetForm() : openCreate())}
						>
							<Plus className="w-3 h-3" /> {t('settings.skills.add')}
						</Button>
					</div>
				</div>

				{showSearch && <RegistrySearch onClose={() => setShowSearch(false)} />}

				{showForm && (
					<InPlaceForm
						title={
							editingId
								? t('settings.skills.form.edit')
								: createScope === ALL_PROJECTS
									? t('settings.skills.form.addGlobal')
									: t('settings.skills.form.addScoped', { project: createScopeName ?? '' })
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
										aria-label={t('settings.skills.revisionHistory')}
									>
										<History className="w-3.5 h-3.5" />
										<span className="hidden sm:inline">{t('settings.skills.history')}</span>
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
										{viewingRevision.content || t('settings.skills.emptyRevision')}
									</MarkdownProse>
								</div>
							</>
						) : (
							<>
								<div className="flex flex-col sm:flex-row gap-2">
									<Input
										placeholder={t('settings.skills.field.name')}
										value={name}
										onChange={(e) => setName(e.target.value)}
										required
										wrapperClassName="flex-1"
									/>
									<Input
										placeholder={t('settings.skills.field.tags')}
										value={tags}
										onChange={(e) => setTags(e.target.value)}
										wrapperClassName="flex-1"
									/>
								</div>
								<Input
									placeholder={t('settings.skills.field.description')}
									value={description}
									onChange={(e) => setDescription(e.target.value)}
								/>
								{/* Scope is chosen at create time; existing skills re-scope via the
						    per-row drop-down (a skill's slug is namespaced per scope). */}
								{!editingId && (
									<div className="flex flex-wrap items-center gap-2">
										<span className="text-[13px] text-text-2">{t('settings.skills.scope')}</span>
										<SearchableSelect
											options={scopeOptions}
											value={createScope}
											onChange={setCreateScope}
											searchPlaceholder={t('settings.skills.searchProjects')}
											emptyLabel={t('settings.skills.noProjects')}
											testId="create-scope-select"
										/>
									</div>
								)}
								<MarkdownEditor
									label={t('settings.skills.field.content')}
									labelClassName="text-[13px] text-text-2"
									ariaLabel={t('settings.skills.field.contentAria')}
									placeholder={t('settings.skills.field.contentPlaceholder')}
									value={content}
									onChange={setContent}
									required
									rows={10}
									className="font-mono"
									previewClassName="min-h-[200px]"
									previewTestId="skill-content-preview"
									emptyPreviewText={t('settings.skills.emptyPreview')}
								/>
								{error && <p className="text-[13px] text-danger">{error}</p>}
								<div className="flex gap-2">
									<Button
										type="submit"
										size="sm"
										disabled={createSkill.isPending || updateSkill.isPending}
									>
										{editingId ? t('settings.skills.saveChanges') : t('settings.skills.addSkill')}
									</Button>
									<Button type="button" variant="secondary" size="sm" onClick={resetForm}>
										{t('common.cancel')}
									</Button>
								</div>
							</>
						)}
					</InPlaceForm>
				)}

				<RevisionHistoryDialog
					open={historyOpen}
					onOpenChange={setHistoryOpen}
					label={editingSkill?.name ?? t('settings.skills.fallbackLabel')}
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
					<p className="text-[13px] text-text-2">{t('settings.skills.empty')}</p>
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
									if (confirm(t('settings.skills.confirmDelete', { name: s.name })))
										deleteSkill.mutate(s.id);
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
				title={plural('settings.skills.defaults.confirmTitle', missingDefaults.length)}
				confirmLabel={t('settings.skills.defaults.confirmLabel')}
				description={
					<>
						{t('settings.skills.defaults.confirmBody')}
						<span className="mt-2 block font-medium text-text-1" data-testid="default-skill-names">
							{missingDefaults.map((m) => m.name).join(', ')}
						</span>
					</>
				}
				onConfirm={async () => {
					await installDefaults.mutateAsync(undefined);
				}}
			/>
			<ConfirmDialog
				open={confirmRefresh}
				onOpenChange={setConfirmRefresh}
				title={plural('settings.skills.refresh.confirmTitle', cleanOutdated.length)}
				confirmLabel={t('settings.skills.refresh.confirmLabel')}
				description={
					<>
						{t('settings.skills.refresh.confirmBody')}
						<span className="mt-2 block font-medium text-text-1" data-testid="refresh-skill-names">
							{cleanOutdated.map((o) => o.name).join(', ')}
						</span>
					</>
				}
				onConfirm={async () => {
					await refreshDefaults.mutateAsync(cleanOutdated.map((o) => o.slug));
				}}
			/>
			<ConfirmDialog
				open={confirmRefreshEdited}
				onOpenChange={setConfirmRefreshEdited}
				title={plural('settings.skills.refresh.editedTitle', editedOutdated.length)}
				confirmLabel={t('settings.skills.refresh.editedConfirmLabel')}
				variant="danger"
				description={
					<>
						{t('settings.skills.refresh.editedBody')}
						<span
							className="mt-2 block font-medium text-text-1"
							data-testid="refresh-edited-skill-names"
						>
							{editedOutdated.map((o) => o.name).join(', ')}
						</span>
					</>
				}
				onConfirm={async () => {
					await refreshDefaults.mutateAsync(editedOutdated.map((o) => o.slug));
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
	const { t } = useI18n();
	const updateScope = useUpdateInstanceSkillScope();
	const [rowError, setRowError] = useState<string | null>(null);

	const scopeLabel = skill.project_id
		? (skill.project_name ?? t('settings.skills.row.project'))
		: t('settings.skills.allProjects');
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
					setRowError(e instanceof Error ? e.message : t('settings.skills.error.scope')),
			},
		);
	};

	const scopeTrigger = (
		<button
			type="button"
			data-testid="instance-skill-scope"
			aria-label={t('settings.skills.row.scopeAria', { scope: scopeLabel })}
			disabled={updateScope.isPending}
			className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full h-5 pl-2 pr-1.5 text-[11.5px] font-medium outline-none cursor-pointer transition-opacity hover:opacity-80 focus:ring-1 focus:ring-border-strong disabled:opacity-50 ${scopeTone}`}
		>
			{updateScope.isPending ? t('settings.skills.saving') : scopeLabel}
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
						<Badge color="neutral">{t('settings.skills.builtIn')}</Badge>
					) : (
						<SearchableSelect
							options={scopeOptions}
							value={scopeValue}
							onChange={changeScope}
							trigger={scopeTrigger}
							searchPlaceholder={t('settings.skills.searchProjects')}
							emptyLabel={t('settings.skills.noProjects')}
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
					aria-label={t('settings.skills.row.view', { name: skill.name })}
					className="text-text-3 hover:text-text-1"
				>
					<Eye className="w-3.5 h-3.5" />
				</button>
				{!skill.readonly && (
					<>
						<button
							type="button"
							onClick={onEdit}
							aria-label={t('settings.skills.row.edit', { name: skill.name })}
							className="text-text-3 hover:text-text-1"
						>
							<Pencil className="w-3.5 h-3.5" />
						</button>
						<button
							type="button"
							onClick={onDelete}
							aria-label={t('settings.skills.row.delete', { name: skill.name })}
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
	const { t, plural } = useI18n();
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
		<InPlaceForm
			title={t('settings.skills.registry.title')}
			onClose={onClose}
			data-testid="registry-search-panel"
		>
			{!configured ? (
				<div className="flex flex-col gap-2">
					<p className="text-[13px] text-text-2">
						<Trans
							k="settings.skills.registry.tokenPrompt"
							vars={{ cli: <code>npx skills</code> }}
						/>
					</p>
					<div className="flex flex-col sm:flex-row gap-2">
						<Input
							type="password"
							placeholder={t('settings.skills.registry.tokenPlaceholder')}
							value={tokenInput}
							onChange={(e) => setTokenInput(e.target.value)}
							wrapperClassName="flex-1"
							aria-label={t('settings.skills.registry.tokenPlaceholder')}
						/>
						<Button
							size="sm"
							disabled={!tokenInput.trim() || setToken.isPending}
							onClick={() =>
								setToken.mutate(tokenInput.trim(), { onSuccess: () => setTokenInput('') })
							}
						>
							{t('settings.skills.registry.saveToken')}
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
							placeholder={t('settings.skills.registry.searchPlaceholder')}
							value={queryInput}
							onChange={(e) => setQueryInput(e.target.value)}
							wrapperClassName="flex-1"
							aria-label={t('settings.skills.registry.title')}
						/>
						<Button type="submit" size="sm" disabled={queryInput.trim().length < 2}>
							<Search className="w-3 h-3" /> {t('settings.skills.registry.search')}
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => setToken.mutate('')}
							title={t('settings.skills.registry.clearTokenTitle')}
						>
							{t('settings.skills.registry.clearToken')}
						</Button>
					</form>

					{search.isFetching && (
						<div className="flex items-center gap-1.5 text-[13px] text-text-2">
							<Loader2 className="w-3.5 h-3.5 animate-spin" />{' '}
							{t('settings.skills.registry.searching')}
						</div>
					)}
					{search.error && (
						<p className="text-[13px] text-danger">
							{(search.error as { message?: string }).message ??
								t('settings.skills.registry.searchFailed')}
						</p>
					)}
					{search.data?.length === 0 && !search.isFetching && submitted && (
						<p className="text-[13px] text-text-2">
							{t('settings.skills.registry.noResults', { query: submitted })}
						</p>
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
													aria-label={t('settings.skills.registry.openOn', { name: r.name })}
												>
													<ExternalLink className="w-3 h-3" />
												</a>
											)}
										</div>
										<div className="text-xs text-text-3 truncate">
											{r.source}
											{r.installs > 0 &&
												` · ${plural('settings.skills.registry.installs', r.installs, {
													count: r.installs.toLocaleString(),
												})}`}
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
										{t('settings.skills.add')}
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
