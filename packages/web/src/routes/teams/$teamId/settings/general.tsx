import { createFileRoute } from '@tanstack/react-router';
import { ExternalLink, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { RevisionsPanel } from '../../../../components/revisions-panel';
import { ApiKeysSection } from '../../../../components/settings/api-keys-section';
import { AutomationsSection } from '../../../../components/settings/automations-section';
import { BudgetSection } from '../../../../components/settings/budget-section';
import { GeneralSection } from '../../../../components/settings/general-section';
import { SectionHeader } from '../../../../components/settings/helpers';
import { McpServersSection } from '../../../../components/settings/mcp-section';
import { SecretsSection } from '../../../../components/settings/secrets-section';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { Tooltip } from '../../../../components/ui/tooltip';
import {
	usePreferenceRevisions,
	usePreferences,
	useRestorePreferenceRevision,
	useUpdatePreferences,
} from '../../../../hooks/use-preferences';
import {
	useCreateSkill,
	useDeleteSkill,
	useSkills,
	useSyncSkill,
} from '../../../../hooks/use-skills';
import { useTeam } from '../../../../hooks/use-teams';

const settingsNav = [
	{ id: 'general', label: 'General' },
	{ id: 'automations', label: 'Automations' },
	{ id: 'secrets', label: 'Secrets vault' },
	{ id: 'api-keys', label: 'API keys' },
	{ id: 'mcp', label: 'MCP servers' },
	{ id: 'budget', label: 'Budget' },
	{ id: 'preferences', label: 'Preferences' },
	{ id: 'skills', label: 'Skills' },
	{ id: 'skill-file', label: 'Skill file' },
];

function SettingsPage() {
	const { teamId } = Route.useParams();
	const { data: team } = useTeam(teamId);
	const [activeSection, setActiveSection] = useState('general');

	function scrollTo(id: string) {
		setActiveSection(id);
		document.getElementById(`settings-${id}`)?.scrollIntoView({ behavior: 'smooth' });
	}

	return (
		<div className="flex flex-col gap-4 md:grid md:grid-cols-[160px_1fr] md:gap-6">
			<nav className="flex flex-col gap-0.5 sticky top-0">
				{settingsNav.map((item) => (
					<button
						key={item.id}
						type="button"
						onClick={() => scrollTo(item.id)}
						className={`text-left text-[13px] px-3 py-1.5 rounded-radius-md transition-colors cursor-pointer ${
							activeSection === item.id
								? 'text-text font-medium bg-bg-subtle'
								: 'text-text-muted hover:text-text hover:bg-bg-subtle'
						}`}
					>
						{item.label}
					</button>
				))}
			</nav>

			<div className="space-y-8">
				<div id="settings-general">
					<GeneralSection team={team} />
				</div>
				<div id="settings-automations">
					<AutomationsSection teamId={teamId} team={team} />
				</div>
				<div id="settings-secrets">
					<SecretsSection teamId={teamId} />
				</div>
				<div id="settings-api-keys">
					<ApiKeysSection teamId={teamId} />
				</div>
				<div id="settings-mcp">
					<McpServersSection teamId={teamId} />
				</div>
				<div id="settings-budget">
					<BudgetSection teamId={teamId} />
				</div>
				<div id="settings-preferences">
					<PreferencesSection teamId={teamId} />
				</div>
				<div id="settings-skills">
					<SkillsSection teamId={teamId} />
				</div>
				<div id="settings-skill-file">
					<SkillFileSection />
				</div>
			</div>
		</div>
	);
}

function PreferencesSection({ teamId }: { teamId: string }) {
	const { data: prefs } = usePreferences(teamId);
	const { data: revisions } = usePreferenceRevisions(teamId);
	const updatePrefs = useUpdatePreferences(teamId);
	const restorePrefs = useRestorePreferenceRevision(teamId);
	const [content, setContent] = useState('');
	const [editing, setEditing] = useState(false);

	useEffect(() => {
		if (prefs?.content) setContent(prefs.content);
	}, [prefs]);

	async function handleSave() {
		await updatePrefs.mutateAsync({ content });
		setEditing(false);
	}

	return (
		<section>
			<div className="flex items-center justify-between mb-4">
				<SectionHeader title="Preferences" desc="Custom instructions for all agents." />
				{!editing && (
					<Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
						Edit
					</Button>
				)}
			</div>
			{editing ? (
				<div className="flex flex-col gap-2">
					<textarea
						value={content}
						onChange={(e) => setContent(e.target.value)}
						className="w-full rounded-radius-md border border-border bg-bg px-3 py-2 text-[13px] text-text outline-none focus:border-border-hover min-h-[120px] resize-y font-mono leading-relaxed"
					/>
					<div className="flex justify-end gap-2">
						<Button variant="secondary" size="sm" onClick={() => setEditing(false)}>
							Cancel
						</Button>
						<Button size="sm" onClick={handleSave} disabled={updatePrefs.isPending}>
							{updatePrefs.isPending && <Loader2 className="w-3 h-3 animate-spin" />}
							Save
						</Button>
					</div>
				</div>
			) : (
				<>
					<p className="text-[13px] text-text-muted whitespace-pre-wrap">
						{prefs?.content || 'No preferences set.'}
					</p>
					{prefs && (
						<RevisionsPanel
							revisions={revisions}
							onRestore={(rev) => restorePrefs.mutateAsync(rev)}
							isRestoring={restorePrefs.isPending}
						/>
					)}
				</>
			)}
		</section>
	);
}

function SkillsSection({ teamId }: { teamId: string }) {
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

function SkillFileSection() {
	const [content, setContent] = useState<string | null>(null);
	const [showPreview, setShowPreview] = useState(false);

	useEffect(() => {
		if (showPreview && content === null) {
			fetch('/skill.md')
				.then((r) => r.text())
				.then(setContent)
				.catch(() => setContent('Failed to load skill file.'));
		}
	}, [showPreview, content]);

	return (
		<section>
			<SectionHeader title="Skill file" />
			<div className="flex gap-2 mb-2">
				<a
					href="/skill.md"
					target="_blank"
					rel="noopener noreferrer"
					className="inline-flex items-center gap-1 text-[13px] text-accent-blue-text hover:underline"
				>
					<ExternalLink className="w-3.5 h-3.5" /> Open /skill.md
				</a>
				<Button variant="secondary" size="sm" onClick={() => setShowPreview(!showPreview)}>
					{showPreview ? 'Hide' : 'Preview'}
				</Button>
			</div>
			{showPreview && content && (
				<pre className="text-xs bg-bg-subtle border border-border rounded-radius-md p-3 overflow-auto max-h-64 text-text-muted whitespace-pre-wrap">
					{content}
				</pre>
			)}
		</section>
	);
}

export const Route = createFileRoute('/teams/$teamId/settings/general')({
	component: SettingsPage,
});
