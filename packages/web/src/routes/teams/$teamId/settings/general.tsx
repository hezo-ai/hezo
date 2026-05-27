import { createFileRoute } from '@tanstack/react-router';
import { Copy, ExternalLink, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { RevisionsPanel } from '../../../../components/revisions-panel';
import { AutomationsSection } from '../../../../components/settings/automations-section';
import { GeneralSection } from '../../../../components/settings/general-section';
import { SectionHeader } from '../../../../components/settings/helpers';
import { SecretsSection } from '../../../../components/settings/secrets-section';
import { Badge } from '../../../../components/ui/badge';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { Tooltip } from '../../../../components/ui/tooltip';
import { useApiKeys, useCreateApiKey, useDeleteApiKey } from '../../../../hooks/use-api-keys';
import { useCosts } from '../../../../hooks/use-costs';
import {
	useCreateMcpConnection,
	useDeleteMcpConnection,
	useMcpConnections,
} from '../../../../hooks/use-mcp-connections';
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

function ApiKeysSection({ teamId }: { teamId: string }) {
	const { data: apiKeys } = useApiKeys(teamId);
	const createKey = useCreateApiKey(teamId);
	const deleteKey = useDeleteApiKey(teamId);
	const [showForm, setShowForm] = useState(false);
	const [name, setName] = useState('');
	const [newKey, setNewKey] = useState<string | null>(null);

	async function handleCreate(e: React.FormEvent) {
		e.preventDefault();
		const result = await createKey.mutateAsync({ name });
		setNewKey(result.key ?? null);
		setName('');
		setShowForm(false);
	}

	return (
		<section>
			<div className="flex items-center justify-between mb-4">
				<SectionHeader title="API keys" />
				<Button variant="secondary" size="sm" onClick={() => setShowForm(!showForm)}>
					<Plus className="w-3 h-3" /> Create
				</Button>
			</div>
			{newKey && (
				<div className="border border-accent-green rounded-radius-md bg-accent-green-bg p-3 mb-3">
					<p className="text-xs text-accent-green-text font-medium mb-1">
						New API key created — copy it now, it won't be shown again:
					</p>
					<div className="flex items-center gap-2">
						<code className="text-xs font-mono break-all flex-1">{newKey}</code>
						<Button
							variant="secondary"
							size="sm"
							onClick={() => navigator.clipboard.writeText(newKey)}
						>
							<Copy className="w-3 h-3" />
						</Button>
					</div>
					<Button variant="secondary" size="sm" className="mt-2" onClick={() => setNewKey(null)}>
						Dismiss
					</Button>
				</div>
			)}
			{showForm && (
				<form onSubmit={handleCreate} className="flex flex-col sm:flex-row gap-2 mb-3">
					<Input
						placeholder="Key name"
						value={name}
						onChange={(e) => setName(e.target.value)}
						required
						className="flex-1"
					/>
					<Button type="submit" size="sm" disabled={createKey.isPending}>
						Create
					</Button>
				</form>
			)}
			{apiKeys?.length === 0 ? (
				<p className="text-[13px] text-text-subtle">No API keys.</p>
			) : (
				<div className="flex flex-col gap-1">
					{apiKeys?.map((k) => (
						<div
							key={k.id}
							className="flex items-center justify-between rounded-radius-md border border-border bg-bg px-3 py-2 text-[13px]"
						>
							<div className="flex items-center gap-2">
								<span className="font-medium">{k.name}</span>
								<span className="text-xs text-text-subtle font-mono">hezo_{k.prefix}...</span>
							</div>
							<button
								type="button"
								onClick={() => deleteKey.mutate(k.id)}
								className="text-text-subtle hover:text-accent-red"
							>
								<Trash2 className="w-3.5 h-3.5" />
							</button>
						</div>
					))}
				</div>
			)}
		</section>
	);
}

function BudgetSection({ teamId }: { teamId: string }) {
	const { data: costs } = useCosts(teamId, { group_by: 'agent' });
	return (
		<section>
			<SectionHeader title="Budget" desc="Spending overview across agents." />
			{costs?.summary?.length === 0 ? (
				<p className="text-[13px] text-text-subtle">No spend recorded.</p>
			) : (
				<div className="flex flex-col gap-1">
					{costs?.summary?.map((s) => (
						<div
							key={s.label}
							className="flex items-center justify-between rounded-radius-md border border-border bg-bg px-3 py-2 text-[13px]"
						>
							<span>{s.label}</span>
							<span className="font-mono">${(s.total_cents / 100).toFixed(2)}</span>
						</div>
					))}
					<div className="flex items-center justify-between px-3 py-2 text-[13px] font-medium border-t border-border mt-1 pt-2">
						<span>Total</span>
						<span className="font-mono">${((costs?.total_cents ?? 0) / 100).toFixed(2)}</span>
					</div>
				</div>
			)}
		</section>
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

function McpServersSection({ teamId }: { teamId: string }) {
	const { data: connections = [] } = useMcpConnections(teamId);
	const createConn = useCreateMcpConnection(teamId);
	const deleteConn = useDeleteMcpConnection(teamId);
	const [showAdd, setShowAdd] = useState(false);
	const [kind, setKind] = useState<'saas' | 'local'>('saas');
	const [name, setName] = useState('');
	const [url, setUrl] = useState('');
	const [headersJson, setHeadersJson] = useState('');
	const [command, setCommand] = useState('');
	const [argsText, setArgsText] = useState('');
	const [envJson, setEnvJson] = useState('');

	function reset() {
		setName('');
		setUrl('');
		setHeadersJson('');
		setCommand('');
		setArgsText('');
		setEnvJson('');
		setKind('saas');
		setShowAdd(false);
	}

	async function handleAdd(e: React.FormEvent) {
		e.preventDefault();
		if (!name.trim()) return;
		const config: Record<string, unknown> = {};
		if (kind === 'saas') {
			if (!url.trim()) return;
			config.url = url.trim();
			if (headersJson.trim()) {
				try {
					config.headers = JSON.parse(headersJson);
				} catch {
					alert('Headers must be valid JSON');
					return;
				}
			}
		} else {
			if (!command.trim()) return;
			config.command = command.trim();
			const args = argsText
				.split(/\s+/)
				.map((s) => s.trim())
				.filter(Boolean);
			if (args.length > 0) config.args = args;
			if (envJson.trim()) {
				try {
					config.env = JSON.parse(envJson);
				} catch {
					alert('Env must be valid JSON');
					return;
				}
			}
		}
		await createConn.mutateAsync({ name: name.trim(), kind, config });
		reset();
	}

	return (
		<section>
			<SectionHeader
				title="MCP servers"
				desc="Model Context Protocol servers available to every agent run in this team. Header values may include __HEZO_SECRET_<NAME>__ placeholders, substituted by the egress proxy at request time."
			/>
			{connections.length === 0 && !showAdd && (
				<p className="text-[13px] text-text-muted mb-2">No MCP servers configured.</p>
			)}
			<div className="space-y-2 mb-3">
				{connections.map((conn) => {
					const config = conn.config as { url?: string; command?: string };
					const target = conn.kind === 'saas' ? config.url : config.command;
					return (
						<div
							key={conn.id}
							className="border border-border rounded-radius-md p-3 flex items-center gap-3 bg-bg-subtle"
						>
							<Badge color={conn.kind === 'saas' ? 'blue' : 'gray'}>{conn.kind}</Badge>
							<div className="flex-1 min-w-0">
								<span className="text-[13px] font-medium">{conn.name}</span>
								<span className="text-xs text-text-muted block font-mono truncate">{target}</span>
							</div>
							{conn.install_status !== 'installed' && (
								<Badge color={conn.install_status === 'failed' ? 'danger' : 'warning'}>
									{conn.install_status}
								</Badge>
							)}
							<Button variant="danger-text" size="sm" onClick={() => deleteConn.mutate(conn.id)}>
								<Trash2 className="w-3 h-3" />
							</Button>
						</div>
					);
				})}
			</div>
			{showAdd ? (
				<form onSubmit={handleAdd} className="space-y-2 border border-border rounded-radius-md p-3">
					<div className="flex gap-2">
						<label className="flex items-center gap-1 text-[13px]">
							<input type="radio" checked={kind === 'saas'} onChange={() => setKind('saas')} /> SaaS
							HTTP
						</label>
						<label className="flex items-center gap-1 text-[13px]">
							<input type="radio" checked={kind === 'local'} onChange={() => setKind('local')} />{' '}
							Local stdio
						</label>
					</div>
					<Input
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="Server name (e.g. exa)"
					/>
					{kind === 'saas' ? (
						<>
							<Input
								value={url}
								onChange={(e) => setUrl(e.target.value)}
								placeholder="URL (e.g. https://mcp.exa.ai/mcp)"
							/>
							<Input
								value={headersJson}
								onChange={(e) => setHeadersJson(e.target.value)}
								placeholder='Headers JSON (e.g. {"x-api-key":"__HEZO_SECRET_EXA_KEY__"})'
							/>
						</>
					) : (
						<>
							<Input
								value={command}
								onChange={(e) => setCommand(e.target.value)}
								placeholder="Command (e.g. /workspace/.hezo/mcp/fs/node_modules/.bin/server-filesystem)"
							/>
							<Input
								value={argsText}
								onChange={(e) => setArgsText(e.target.value)}
								placeholder="Args (space-separated)"
							/>
							<Input
								value={envJson}
								onChange={(e) => setEnvJson(e.target.value)}
								placeholder='Env JSON (optional, e.g. {"FOO":"bar"})'
							/>
						</>
					)}
					<div className="flex gap-2">
						<Button type="submit" size="sm" disabled={createConn.isPending}>
							Add
						</Button>
						<Button type="button" variant="secondary" size="sm" onClick={reset}>
							Cancel
						</Button>
					</div>
				</form>
			) : (
				<Button variant="secondary" size="sm" onClick={() => setShowAdd(true)}>
					<Plus className="w-3 h-3" /> Add MCP Server
				</Button>
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
