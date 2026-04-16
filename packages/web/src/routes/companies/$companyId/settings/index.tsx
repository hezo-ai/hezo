import { createFileRoute, Link } from '@tanstack/react-router';
import { Copy, ExternalLink, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '../../../../components/ui/badge';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { useApiKeys, useCreateApiKey, useDeleteApiKey } from '../../../../hooks/use-api-keys';
import { useCompany, useUpdateCompany } from '../../../../hooks/use-companies';
import {
	useConnections,
	useDeleteConnection,
	useStartConnection,
} from '../../../../hooks/use-connections';
import { useCosts } from '../../../../hooks/use-costs';
import { usePreferences, useUpdatePreferences } from '../../../../hooks/use-preferences';
import { useCreateSecret, useDeleteSecret, useSecrets } from '../../../../hooks/use-secrets';
import {
	useCreateSkill,
	useDeleteSkill,
	useSkills,
	useSyncSkill,
} from '../../../../hooks/use-skills';

const settingsNav = [
	{ id: 'general', label: 'General' },
	{ id: 'connections', label: 'Connected platforms' },
	{ id: 'secrets', label: 'Secrets vault' },
	{ id: 'api-keys', label: 'API keys' },
	{ id: 'mcp', label: 'MCP servers' },
	{ id: 'budget', label: 'Budget' },
	{ id: 'preferences', label: 'Preferences' },
	{ id: 'skills', label: 'Skills' },
	{ id: 'skill-file', label: 'Skill file' },
];

function SettingsPage() {
	const { companyId } = Route.useParams();
	const [activeSection, setActiveSection] = useState('general');

	function scrollTo(id: string) {
		setActiveSection(id);
		document.getElementById(`settings-${id}`)?.scrollIntoView({ behavior: 'smooth' });
	}

	return (
		<div className="grid grid-cols-[160px_1fr] gap-6">
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
					<GeneralSection companyId={companyId} />
				</div>
				<div id="settings-connections">
					<ConnectionsSection companyId={companyId} />
				</div>
				<div id="settings-secrets">
					<SecretsSection companyId={companyId} />
				</div>
				<div id="settings-api-keys">
					<ApiKeysSection companyId={companyId} />
				</div>
				<div id="settings-mcp">
					<McpServersSection companyId={companyId} />
				</div>
				<div id="settings-budget">
					<BudgetSection companyId={companyId} />
				</div>
				<div id="settings-preferences">
					<PreferencesSection companyId={companyId} />
				</div>
				<div id="settings-skills">
					<SkillsSection companyId={companyId} />
				</div>
				<div id="settings-skill-file">
					<SkillFileSection />
				</div>
			</div>
		</div>
	);
}

function SectionHeader({ title, desc }: { title: string; desc?: string }) {
	return (
		<div className="mb-4">
			<h2 className="text-base font-medium">{title}</h2>
			{desc && <p className="text-[13px] text-text-muted mt-1">{desc}</p>}
		</div>
	);
}

function GeneralSection({ companyId }: { companyId: string }) {
	const { data: company } = useCompany(companyId);
	return (
		<section>
			<SectionHeader title="General" desc="Basic company information." />
			<div className="space-y-3 max-w-md">
				<div>
					<span className="text-xs font-medium uppercase tracking-wider text-text-muted block mb-1.5">
						Company name
					</span>
					<div className="text-[13px]">{company?.name ?? '—'}</div>
				</div>
				{company?.issue_prefix && (
					<div>
						<span className="text-xs font-medium uppercase tracking-wider text-text-muted block mb-1.5">
							Identifier prefix
						</span>
						<div className="text-[13px] font-mono">{company.issue_prefix}</div>
					</div>
				)}
				{company?.description && (
					<div>
						<span className="text-xs font-medium uppercase tracking-wider text-text-muted block mb-1.5">
							Description
						</span>
						<div className="text-[13px] text-text-muted">{company.description}</div>
					</div>
				)}
			</div>
		</section>
	);
}

function ConnectionsSection({ companyId }: { companyId: string }) {
	const { data: connections } = useConnections(companyId);
	const startConn = useStartConnection(companyId);
	const deleteConn = useDeleteConnection(companyId);

	async function handleConnect(platform: string) {
		const result = await startConn.mutateAsync(platform);
		window.location.href = result.auth_url;
	}

	const github = connections?.find((c) => c.platform === 'github');

	return (
		<section>
			<SectionHeader title="Connected platforms" desc="External services linked to this company." />
			{github ? (
				<div className="border border-border rounded-radius-md p-3 flex items-center justify-between">
					<div className="flex items-center gap-2">
						<span className="text-[13px] font-medium">GitHub</span>
						<Badge color={github.status === 'active' ? 'success' : 'danger'}>{github.status}</Badge>
					</div>
					<Button variant="danger-text" size="sm" onClick={() => deleteConn.mutate(github.id)}>
						<Trash2 className="w-3.5 h-3.5" /> Disconnect
					</Button>
				</div>
			) : (
				<Button
					variant="secondary"
					onClick={() => handleConnect('github')}
					disabled={startConn.isPending}
				>
					{startConn.isPending && <Loader2 className="w-3 h-3 animate-spin" />}
					<ExternalLink className="w-3.5 h-3.5" /> Connect GitHub
				</Button>
			)}
			{startConn.error && (
				<p className="text-[13px] text-accent-red mt-2">
					{(startConn.error as { message: string }).message}
				</p>
			)}
			<div className="mt-4 border-t border-border pt-4">
				<p className="text-[13px] text-text-muted mb-2">
					AI provider credentials (Anthropic, OpenAI, Google, Kimi) are shared across every company.
				</p>
				<Link
					to="/settings/ai-providers"
					className="inline-flex items-center gap-1 text-[13px] text-accent-blue-text hover:underline"
				>
					Manage AI providers <ExternalLink className="w-3.5 h-3.5" />
				</Link>
			</div>
		</section>
	);
}

function SecretsSection({ companyId }: { companyId: string }) {
	const { data: secrets } = useSecrets(companyId);
	const createSecret = useCreateSecret(companyId);
	const deleteSecret = useDeleteSecret(companyId);
	const [showForm, setShowForm] = useState(false);
	const [name, setName] = useState('');
	const [value, setValue] = useState('');

	async function handleCreate(e: React.FormEvent) {
		e.preventDefault();
		await createSecret.mutateAsync({ name, value });
		setName('');
		setValue('');
		setShowForm(false);
	}

	return (
		<section>
			<div className="flex items-center justify-between mb-4">
				<SectionHeader title="Secrets vault" desc="Encrypted secrets available to agents." />
				<Button variant="secondary" size="sm" onClick={() => setShowForm(!showForm)}>
					<Plus className="w-3 h-3" /> Add
				</Button>
			</div>
			{showForm && (
				<form onSubmit={handleCreate} className="flex gap-2 mb-3">
					<Input
						placeholder="Name"
						value={name}
						onChange={(e) => setName(e.target.value)}
						required
						className="flex-1"
					/>
					<Input
						placeholder="Value"
						type="password"
						value={value}
						onChange={(e) => setValue(e.target.value)}
						required
						className="flex-1"
					/>
					<Button type="submit" size="sm" disabled={createSecret.isPending}>
						Add
					</Button>
				</form>
			)}
			{secrets?.length === 0 ? (
				<p className="text-[13px] text-text-subtle">No secrets stored.</p>
			) : (
				<div className="flex flex-col gap-1">
					{secrets?.map((s) => (
						<div
							key={s.id}
							className="flex items-center justify-between rounded-radius-md border border-border bg-bg px-3 py-2 text-[13px]"
						>
							<div className="flex items-center gap-2">
								<span className="font-medium">{s.name}</span>
								<Badge color="neutral">{s.category}</Badge>
								{s.project_name && (
									<span className="text-xs text-text-subtle">{s.project_name}</span>
								)}
							</div>
							<button
								type="button"
								onClick={() => deleteSecret.mutate(s.id)}
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

function ApiKeysSection({ companyId }: { companyId: string }) {
	const { data: apiKeys } = useApiKeys(companyId);
	const createKey = useCreateApiKey(companyId);
	const deleteKey = useDeleteApiKey(companyId);
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
				<form onSubmit={handleCreate} className="flex gap-2 mb-3">
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

function BudgetSection({ companyId }: { companyId: string }) {
	const { data: costs } = useCosts(companyId, { group_by: 'agent' });
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

function PreferencesSection({ companyId }: { companyId: string }) {
	const { data: prefs } = usePreferences(companyId);
	const updatePrefs = useUpdatePreferences(companyId);
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
				<p className="text-[13px] text-text-muted whitespace-pre-wrap">
					{prefs?.content || 'No preferences set.'}
				</p>
			)}
		</section>
	);
}

function McpServersSection({ companyId }: { companyId: string }) {
	const { data: company } = useCompany(companyId);
	const updateCompany = useUpdateCompany(companyId);
	const [showAdd, setShowAdd] = useState(false);
	const [name, setName] = useState('');
	const [url, setUrl] = useState('');
	const [apiKey, setApiKey] = useState('');

	const servers = (company?.mcp_servers ?? []) as { name: string; url: string; api_key?: string }[];

	async function handleAdd(e: React.FormEvent) {
		e.preventDefault();
		if (!name.trim() || !url.trim()) return;
		const entry: { name: string; url: string; api_key?: string } = {
			name: name.trim(),
			url: url.trim(),
		};
		if (apiKey.trim()) entry.api_key = apiKey.trim();
		await updateCompany.mutateAsync({ mcp_servers: [...servers, entry] });
		setName('');
		setUrl('');
		setApiKey('');
		setShowAdd(false);
	}

	async function handleDelete(server: { name: string; url: string }) {
		const updated = servers.filter((s) => s.name !== server.name || s.url !== server.url);
		await updateCompany.mutateAsync({ mcp_servers: updated });
	}

	return (
		<section>
			<SectionHeader
				title="MCP servers"
				desc="Model Context Protocol servers available to agents."
			/>
			{servers.length === 0 && !showAdd && (
				<p className="text-[13px] text-text-muted mb-2">No MCP servers configured.</p>
			)}
			<div className="space-y-2 mb-3">
				{servers.map((s) => (
					<div
						key={`${s.name}-${s.url}`}
						className="border border-border rounded-radius-md p-3 flex items-center gap-3 bg-bg-subtle"
					>
						<div className="flex-1 min-w-0">
							<span className="text-[13px] font-medium">{s.name}</span>
							<span className="text-xs text-text-muted block font-mono truncate">{s.url}</span>
						</div>
						<Button variant="danger-text" size="sm" onClick={() => handleDelete(s)}>
							<Trash2 className="w-3 h-3" />
						</Button>
					</div>
				))}
			</div>
			{showAdd ? (
				<form onSubmit={handleAdd} className="space-y-2 border border-border rounded-radius-md p-3">
					<Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Server name" />
					<Input
						value={url}
						onChange={(e) => setUrl(e.target.value)}
						placeholder="URL (e.g. http://localhost:8080/mcp)"
					/>
					<Input
						value={apiKey}
						onChange={(e) => setApiKey(e.target.value)}
						placeholder="API key (optional)"
						type="password"
					/>
					<div className="flex gap-2">
						<Button type="submit" size="sm" disabled={!name.trim() || !url.trim()}>
							Add
						</Button>
						<Button type="button" variant="secondary" size="sm" onClick={() => setShowAdd(false)}>
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

function SkillsSection({ companyId }: { companyId: string }) {
	const { data: skills } = useSkills(companyId);
	const createSkill = useCreateSkill(companyId);
	const syncSkill = useSyncSkill(companyId);
	const deleteSkill = useDeleteSkill(companyId);
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
									<button
										type="button"
										onClick={() => syncSkill.mutate(s.slug)}
										disabled={syncSkill.isPending}
										className="text-text-subtle hover:text-text p-1"
										title="Re-download"
									>
										<RefreshCw className="w-3.5 h-3.5" />
									</button>
								)}
								<button
									type="button"
									onClick={() => deleteSkill.mutate(s.slug)}
									className="text-text-subtle hover:text-accent-red p-1"
									title="Delete"
								>
									<Trash2 className="w-3.5 h-3.5" />
								</button>
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

export const Route = createFileRoute('/companies/$companyId/settings/')({
	component: SettingsPage,
});
