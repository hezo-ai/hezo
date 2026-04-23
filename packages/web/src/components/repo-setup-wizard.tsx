import * as Dialog from '@radix-ui/react-dialog';
import { Check, GitBranch, Github, Loader2, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useConnections, useStartConnection } from '../hooks/use-connections';
import { useGithubOrgs, useGithubRepos } from '../hooks/use-github';
import { useCreateRepo } from '../hooks/use-repos';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Toggle } from './ui/toggle';

interface RepoSetupWizardProps {
	companyId: string;
	projectId: string;
	issueId?: string;
	open: boolean;
	onOpenChange: (v: boolean) => void;
	onComplete?: () => void;
}

export function RepoSetupWizard({
	companyId,
	projectId,
	issueId,
	open,
	onOpenChange,
	onComplete,
}: RepoSetupWizardProps) {
	const connections = useConnections(companyId);
	const hasGithub = (connections.data ?? []).some(
		(c) => c.platform === 'github' && c.status === 'active',
	);

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm" />
				<Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-xl rounded-radius-lg border border-border bg-bg-elevated p-6 shadow-2xl">
					<Dialog.Title className="text-base font-medium mb-1 flex items-center gap-2">
						<GitBranch className="w-4 h-4" />
						Set up repository
					</Dialog.Title>
					<p className="text-sm text-text-muted mb-4">
						Connect GitHub and pick (or create) the repository this project will build in.
					</p>
					{hasGithub ? (
						<ConnectedStep
							companyId={companyId}
							projectId={projectId}
							onClose={() => onOpenChange(false)}
							onComplete={onComplete}
						/>
					) : (
						<ConnectGithubStep companyId={companyId} issueId={issueId} />
					)}
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

function ConnectGithubStep({ companyId, issueId }: { companyId: string; issueId?: string }) {
	const start = useStartConnection(companyId);
	async function handleConnect() {
		const res = await start.mutateAsync(issueId ? { platform: 'github', issueId } : 'github');
		window.location.href = res.auth_url;
	}
	return (
		<div className="flex flex-col gap-4">
			<div className="rounded-md border border-border-subtle bg-bg p-3 text-sm text-text-muted">
				Hezo needs permission to read your GitHub orgs and create or access a repository on your
				behalf. Your SSH key will be uploaded so agents can clone and push.
			</div>
			<Button onClick={handleConnect} disabled={start.isPending}>
				{start.isPending ? (
					<Loader2 className="w-4 h-4 animate-spin" />
				) : (
					<Github className="w-4 h-4" />
				)}
				Connect GitHub
			</Button>
		</div>
	);
}

function ConnectedStep({
	companyId,
	projectId,
	onClose,
	onComplete,
}: {
	companyId: string;
	projectId: string;
	onClose: () => void;
	onComplete?: () => void;
}) {
	const orgs = useGithubOrgs(companyId);
	const [tab, setTab] = useState<'create' | 'existing'>('create');
	const [owner, setOwner] = useState<string | null>(null);

	useEffect(() => {
		if (!owner && orgs.data && orgs.data.length > 0) setOwner(orgs.data[0].login);
	}, [orgs.data, owner]);

	if (orgs.isLoading) {
		return (
			<div className="flex items-center gap-2 text-sm text-text-muted">
				<Loader2 className="w-4 h-4 animate-spin" /> Loading GitHub orgs…
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-4">
			<div>
				<label
					htmlFor="repo-wizard-owner"
					className="text-xs font-medium text-text-muted mb-1 block"
				>
					Organization
				</label>
				<select
					id="repo-wizard-owner"
					value={owner ?? ''}
					onChange={(e) => setOwner(e.target.value)}
					className="w-full h-9 rounded-md border border-border bg-bg px-2 text-sm"
				>
					{(orgs.data ?? []).map((o) => (
						<option key={o.login} value={o.login}>
							{o.login} {o.is_personal ? '(personal)' : ''}
						</option>
					))}
				</select>
			</div>

			<div className="flex gap-1 border-b border-border-subtle">
				<TabButton active={tab === 'create'} onClick={() => setTab('create')}>
					Create new
				</TabButton>
				<TabButton active={tab === 'existing'} onClick={() => setTab('existing')}>
					Select existing
				</TabButton>
			</div>

			{tab === 'create' ? (
				<CreateRepoForm
					companyId={companyId}
					projectId={projectId}
					owner={owner}
					onClose={onClose}
					onComplete={onComplete}
				/>
			) : (
				<SelectRepoForm
					companyId={companyId}
					projectId={projectId}
					owner={owner}
					onClose={onClose}
					onComplete={onComplete}
				/>
			)}
		</div>
	);
}

function TabButton({
	active,
	onClick,
	children,
}: {
	active: boolean;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={`px-3 py-1.5 text-sm border-b-2 -mb-[1px] transition-colors ${
				active
					? 'border-accent-blue text-text font-medium'
					: 'border-transparent text-text-muted hover:text-text'
			}`}
		>
			{children}
		</button>
	);
}

function CreateRepoForm({
	companyId,
	projectId,
	owner,
	onClose,
	onComplete,
}: {
	companyId: string;
	projectId: string;
	owner: string | null;
	onClose: () => void;
	onComplete?: () => void;
}) {
	const [name, setName] = useState('');
	const [shortName, setShortName] = useState('');
	const [isPrivate, setIsPrivate] = useState(true);
	const create = useCreateRepo(companyId, projectId);

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (!owner || !name.trim() || !shortName.trim()) return;
		await create.mutateAsync({
			short_name: shortName.trim(),
			mode: 'create',
			owner,
			name: name.trim(),
			private: isPrivate,
		});
		onComplete?.();
		onClose();
	}

	return (
		<form onSubmit={handleSubmit} className="flex flex-col gap-3">
			<Input
				label="Repository name"
				value={name}
				onChange={(e) => {
					setName(e.target.value);
					if (!shortName) setShortName(slugify(e.target.value));
				}}
				placeholder="my-app"
				required
			/>
			<Input
				label="Short name (used in worktree paths)"
				value={shortName}
				onChange={(e) => setShortName(e.target.value)}
				placeholder="app"
				required
			/>
			<div className="flex items-center gap-2 text-sm">
				<Toggle checked={isPrivate} onChange={setIsPrivate} />
				<span>Private repository</span>
			</div>
			{create.error && (
				<p className="text-sm text-accent-red">{(create.error as { message: string }).message}</p>
			)}
			<div className="flex justify-end gap-2 mt-2">
				<Button type="button" variant="secondary" onClick={onClose}>
					Cancel
				</Button>
				<Button type="submit" disabled={create.isPending || !owner}>
					{create.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
					Create repository
				</Button>
			</div>
		</form>
	);
}

function SelectRepoForm({
	companyId,
	projectId,
	owner,
	onClose,
	onComplete,
}: {
	companyId: string;
	projectId: string;
	owner: string | null;
	onClose: () => void;
	onComplete?: () => void;
}) {
	const [query, setQuery] = useState('');
	const [selectedFull, setSelectedFull] = useState<string | null>(null);
	const [shortName, setShortName] = useState('');
	const repos = useGithubRepos(companyId, owner, query);
	const create = useCreateRepo(companyId, projectId);

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (!selectedFull || !shortName.trim()) return;
		await create.mutateAsync({
			short_name: shortName.trim(),
			mode: 'link',
			url: `https://github.com/${selectedFull}`,
		});
		onComplete?.();
		onClose();
	}

	return (
		<form onSubmit={handleSubmit} className="flex flex-col gap-3">
			<div className="relative">
				<Search className="w-3.5 h-3.5 text-text-subtle absolute left-2.5 top-1/2 -translate-y-1/2" />
				<input
					type="text"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder="Filter repositories…"
					className="w-full h-9 pl-8 pr-2 rounded-md border border-border bg-bg text-sm"
				/>
			</div>
			<div className="border border-border-subtle rounded-md max-h-60 overflow-y-auto">
				{repos.isLoading ? (
					<p className="p-3 text-sm text-text-muted">Loading…</p>
				) : (repos.data ?? []).length === 0 ? (
					<p className="p-3 text-sm text-text-subtle">No repositories.</p>
				) : (
					<ul className="divide-y divide-border-subtle">
						{(repos.data ?? []).map((r) => {
							const isSelected = selectedFull === r.full_name;
							return (
								<li key={r.full_name}>
									<button
										type="button"
										onClick={() => {
											setSelectedFull(r.full_name);
											if (!shortName) setShortName(slugify(r.name));
										}}
										className={`w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-bg-hover ${
											isSelected ? 'bg-accent-blue-bg' : ''
										}`}
									>
										{isSelected ? (
											<Check className="w-3.5 h-3.5 text-accent-blue-text" />
										) : (
											<span className="w-3.5" />
										)}
										<span className="text-sm font-medium">{r.name}</span>
										<span className="text-xs text-text-muted">{r.full_name}</span>
										{r.private && <span className="text-[10px] text-text-subtle">private</span>}
									</button>
								</li>
							);
						})}
					</ul>
				)}
			</div>
			<Input
				label="Short name (used in worktree paths)"
				value={shortName}
				onChange={(e) => setShortName(e.target.value)}
				placeholder="app"
				required
			/>
			{create.error && (
				<p className="text-sm text-accent-red">{(create.error as { message: string }).message}</p>
			)}
			<div className="flex justify-end gap-2 mt-2">
				<Button type="button" variant="secondary" onClick={onClose}>
					Cancel
				</Button>
				<Button type="submit" disabled={create.isPending || !selectedFull}>
					{create.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
					Link repository
				</Button>
			</div>
		</form>
	);
}

function slugify(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}
