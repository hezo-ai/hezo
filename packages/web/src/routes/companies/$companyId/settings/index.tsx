import { createFileRoute } from '@tanstack/react-router';
import {
	Copy,
	ExternalLink,
	FileText,
	Key,
	Link2,
	Loader2,
	Lock,
	Plus,
	ScrollText,
	Server,
	Trash2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '../../../../components/ui/badge';
import { Button } from '../../../../components/ui/button';
import { Card } from '../../../../components/ui/card';
import { Input } from '../../../../components/ui/input';
import { Textarea } from '../../../../components/ui/textarea';
import { useAgents } from '../../../../hooks/use-agents';
import { useApiKeys, useCreateApiKey, useDeleteApiKey } from '../../../../hooks/use-api-keys';
import { useAuditLog } from '../../../../hooks/use-audit-log';
import { useCompany, useUpdateCompany } from '../../../../hooks/use-companies';
import {
	useConnections,
	useDeleteConnection,
	useStartConnection,
} from '../../../../hooks/use-connections';
import { useCosts } from '../../../../hooks/use-costs';
import { usePreferences, useUpdatePreferences } from '../../../../hooks/use-preferences';
import { useCreateSecret, useDeleteSecret, useSecrets } from '../../../../hooks/use-secrets';

function SettingsPage() {
	const { companyId } = Route.useParams();

	return (
		<div className="p-6 max-w-3xl space-y-8">
			<h1 className="text-lg font-semibold">Settings</h1>
			<ConnectionsSection companyId={companyId} />
			<SecretsSection companyId={companyId} />
			<ApiKeysSection companyId={companyId} />
			<BudgetSection companyId={companyId} />
			<PreferencesSection companyId={companyId} />
			<McpServersSection companyId={companyId} />
			<SkillFileSection />
			<AuditLogSection companyId={companyId} />
		</div>
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
			<h2 className="text-sm font-medium text-text-muted mb-3 flex items-center gap-1.5">
				<Link2 className="w-4 h-4" /> Connected Platforms
			</h2>
			{github ? (
				<Card className="p-3 flex items-center justify-between">
					<div className="flex items-center gap-2">
						<Badge color="green">GitHub</Badge>
						<Badge color={github.status === 'active' ? 'green' : 'red'}>{github.status}</Badge>
					</div>
					<Button
						variant="ghost"
						size="sm"
						className="text-danger"
						onClick={() => deleteConn.mutate(github.id)}
					>
						<Trash2 className="w-3.5 h-3.5" /> Disconnect
					</Button>
				</Card>
			) : (
				<Button
					variant="secondary"
					size="sm"
					onClick={() => handleConnect('github')}
					disabled={startConn.isPending}
				>
					{startConn.isPending && <Loader2 className="w-3 h-3 animate-spin" />}
					<ExternalLink className="w-3.5 h-3.5" /> Connect GitHub
				</Button>
			)}
			{startConn.error && (
				<p className="text-sm text-danger mt-2">
					{(startConn.error as { message: string }).message}
				</p>
			)}
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
			<div className="flex items-center justify-between mb-3">
				<h2 className="text-sm font-medium text-text-muted flex items-center gap-1.5">
					<Lock className="w-4 h-4" /> Secrets Vault
				</h2>
				<Button variant="ghost" size="sm" onClick={() => setShowForm(!showForm)}>
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
				<p className="text-sm text-text-subtle">No secrets stored.</p>
			) : (
				<div className="flex flex-col gap-1">
					{secrets?.map((s) => (
						<div
							key={s.id}
							className="flex items-center justify-between rounded-md border border-border-subtle bg-bg px-3 py-2 text-sm"
						>
							<div className="flex items-center gap-2">
								<span className="font-medium">{s.name}</span>
								<Badge color="gray">{s.category}</Badge>
								{s.project_name && (
									<span className="text-xs text-text-subtle">{s.project_name}</span>
								)}
							</div>
							<button
								type="button"
								onClick={() => deleteSecret.mutate(s.id)}
								className="text-text-subtle hover:text-danger"
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
			<div className="flex items-center justify-between mb-3">
				<h2 className="text-sm font-medium text-text-muted flex items-center gap-1.5">
					<Key className="w-4 h-4" /> API Keys
				</h2>
				<Button variant="ghost" size="sm" onClick={() => setShowForm(!showForm)}>
					<Plus className="w-3 h-3" /> Create
				</Button>
			</div>
			{newKey && (
				<Card className="p-3 mb-3 border-success/50 bg-success/5">
					<p className="text-xs text-success font-medium mb-1">
						New API key created — copy it now, it won't be shown again:
					</p>
					<div className="flex items-center gap-2">
						<code className="text-xs font-mono break-all flex-1">{newKey}</code>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => {
								navigator.clipboard.writeText(newKey);
							}}
						>
							<Copy className="w-3 h-3" />
						</Button>
					</div>
					<Button variant="ghost" size="sm" className="mt-2" onClick={() => setNewKey(null)}>
						Dismiss
					</Button>
				</Card>
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
				<p className="text-sm text-text-subtle">No API keys.</p>
			) : (
				<div className="flex flex-col gap-1">
					{apiKeys?.map((k) => (
						<div
							key={k.id}
							className="flex items-center justify-between rounded-md border border-border-subtle bg-bg px-3 py-2 text-sm"
						>
							<div className="flex items-center gap-2">
								<span className="font-medium">{k.name}</span>
								<span className="text-xs text-text-subtle font-mono">hezo_{k.prefix}...</span>
							</div>
							<button
								type="button"
								onClick={() => deleteKey.mutate(k.id)}
								className="text-text-subtle hover:text-danger"
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
	const { data: agents } = useAgents(companyId);
	const highBudgetAgents =
		agents?.filter(
			(a) => a.monthly_budget_cents > 0 && a.budget_used_cents / a.monthly_budget_cents > 0.8,
		) ?? [];

	return (
		<section>
			<h2 className="text-sm font-medium text-text-muted mb-3">Budget Overview</h2>
			{highBudgetAgents.length > 0 && (
				<div className="mb-3 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">
					{highBudgetAgents.length} agent{highBudgetAgents.length > 1 ? 's' : ''} at 80%+ budget
					usage: {highBudgetAgents.map((a) => a.title).join(', ')}
				</div>
			)}
			{costs?.summary?.length === 0 ? (
				<p className="text-sm text-text-subtle">No spend recorded.</p>
			) : (
				<div className="flex flex-col gap-1">
					{costs?.summary?.map((s) => (
						<div
							key={s.label}
							className="flex items-center justify-between rounded-md border border-border-subtle bg-bg px-3 py-2 text-sm"
						>
							<span>{s.label}</span>
							<span className="font-mono">${(s.total_cents / 100).toFixed(2)}</span>
						</div>
					))}
					<div className="flex items-center justify-between px-3 py-2 text-sm font-medium border-t border-border mt-1 pt-2">
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
			<div className="flex items-center justify-between mb-3">
				<h2 className="text-sm font-medium text-text-muted">Company Preferences</h2>
				{!editing && (
					<Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
						Edit
					</Button>
				)}
			</div>
			{editing ? (
				<div className="flex flex-col gap-2">
					<Textarea
						value={content}
						onChange={(e) => setContent(e.target.value)}
						className="min-h-[120px] font-mono text-xs"
					/>
					<div className="flex justify-end gap-2">
						<Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
							Cancel
						</Button>
						<Button size="sm" onClick={handleSave} disabled={updatePrefs.isPending}>
							{updatePrefs.isPending && <Loader2 className="w-3 h-3 animate-spin" />}
							Save
						</Button>
					</div>
				</div>
			) : (
				<p className="text-sm text-text-muted whitespace-pre-wrap">
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
			<h2 className="text-sm font-medium text-text-muted mb-3 flex items-center gap-1.5">
				<Server className="w-4 h-4" /> MCP Servers
			</h2>
			{servers.length === 0 && !showAdd && (
				<p className="text-sm text-text-muted mb-2">No MCP servers configured.</p>
			)}
			<div className="space-y-2 mb-3">
				{servers.map((s) => (
					<Card key={`${s.name}-${s.url}`} className="p-3 flex items-center gap-3">
						<div className="flex-1 min-w-0">
							<span className="text-sm font-medium text-text">{s.name}</span>
							<span className="text-xs text-text-muted block truncate">{s.url}</span>
							{s.api_key && (
								<span className="text-[10px] text-text-subtle">Key: {'*'.repeat(8)}</span>
							)}
						</div>
						<Button
							variant="ghost"
							size="sm"
							className="text-danger shrink-0"
							onClick={() => handleDelete(s)}
						>
							<Trash2 className="w-3 h-3" />
						</Button>
					</Card>
				))}
			</div>
			{showAdd ? (
				<form onSubmit={handleAdd} className="space-y-2 border border-border rounded-lg p-3">
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
						<Button type="button" variant="ghost" size="sm" onClick={() => setShowAdd(false)}>
							Cancel
						</Button>
					</div>
				</form>
			) : (
				<Button variant="ghost" size="sm" onClick={() => setShowAdd(true)}>
					<Plus className="w-3 h-3" /> Add MCP Server
				</Button>
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
			<h2 className="text-sm font-medium text-text-muted mb-3 flex items-center gap-1.5">
				<FileText className="w-4 h-4" /> Skill File
			</h2>
			<div className="flex gap-2 mb-2">
				<a
					href="/skill.md"
					target="_blank"
					rel="noopener noreferrer"
					className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
				>
					<ExternalLink className="w-3.5 h-3.5" /> Open /skill.md
				</a>
				<Button variant="ghost" size="sm" onClick={() => setShowPreview(!showPreview)}>
					{showPreview ? 'Hide' : 'Preview'}
				</Button>
			</div>
			{showPreview && content && (
				<pre className="text-xs bg-bg-muted border border-border rounded-lg p-3 overflow-auto max-h-64 text-text-muted whitespace-pre-wrap">
					{content}
				</pre>
			)}
		</section>
	);
}

function AuditLogSection({ companyId }: { companyId: string }) {
	const { data: entries } = useAuditLog(companyId);

	return (
		<section>
			<h2 className="text-sm font-medium text-text-muted mb-3 flex items-center gap-1.5">
				<ScrollText className="w-4 h-4" /> Audit Log
			</h2>
			{!entries?.length ? (
				<p className="text-sm text-text-muted">No audit entries yet.</p>
			) : (
				<div className="border border-border rounded-lg overflow-hidden">
					<table className="w-full text-xs">
						<thead className="bg-bg-subtle">
							<tr>
								<th className="text-left px-3 py-2 font-medium text-text-muted">Time</th>
								<th className="text-left px-3 py-2 font-medium text-text-muted">Actor</th>
								<th className="text-left px-3 py-2 font-medium text-text-muted">Action</th>
								<th className="text-left px-3 py-2 font-medium text-text-muted">Entity</th>
							</tr>
						</thead>
						<tbody>
							{entries.map((e) => (
								<tr key={e.id} className="border-t border-border">
									<td className="px-3 py-1.5 text-text-subtle">
										{new Date(e.created_at).toLocaleString()}
									</td>
									<td className="px-3 py-1.5">
										<span className="text-text">{e.actor_name || e.actor_type}</span>
									</td>
									<td className="px-3 py-1.5">
										<Badge color="gray" className="text-[10px]">
											{e.action}
										</Badge>
									</td>
									<td className="px-3 py-1.5 text-text-muted">{e.entity_type}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</section>
	);
}

export const Route = createFileRoute('/companies/$companyId/settings/')({
	component: SettingsPage,
});
