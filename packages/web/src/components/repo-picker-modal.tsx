import * as Dialog from '@radix-ui/react-dialog';
import { GitBranch, Loader2, Lock } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
	type GitHubRepoSummary,
	useCreateRepo,
	useGitHubOrgs,
	useGitHubReposForOwner,
} from '../hooks/use-repos';
import { Button } from './ui/button';
import { dialogContentClassName, dialogOverlayClassName } from './ui/dialog';
import { Input } from './ui/input';

interface RepoPickerModalProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	companyId: string;
	projectId: string;
	oauthConnectionId: string;
}

type PickerMode = 'link' | 'create';

function slugify(value: string): string {
	return value
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40);
}

export function RepoPickerModal({
	open,
	onOpenChange,
	companyId,
	projectId,
	oauthConnectionId,
}: RepoPickerModalProps) {
	const [mode, setMode] = useState<PickerMode>('link');
	const [owner, setOwner] = useState<string | null>(null);
	const [search, setSearch] = useState('');
	const [debouncedSearch, setDebouncedSearch] = useState('');
	const [selectedRepoFullName, setSelectedRepoFullName] = useState<string | null>(null);
	const [shortName, setShortName] = useState('');
	const [shortNameTouched, setShortNameTouched] = useState(false);
	const [newRepoName, setNewRepoName] = useState('');
	const [newRepoPrivate, setNewRepoPrivate] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const createRepo = useCreateRepo(companyId, projectId);
	const orgsQuery = useGitHubOrgs(companyId, open ? oauthConnectionId : null);
	const reposQuery = useGitHubReposForOwner(companyId, oauthConnectionId, owner, debouncedSearch);

	useEffect(() => {
		if (!open) {
			setMode('link');
			setOwner(null);
			setSearch('');
			setDebouncedSearch('');
			setSelectedRepoFullName(null);
			setShortName('');
			setShortNameTouched(false);
			setNewRepoName('');
			setNewRepoPrivate(true);
			setError(null);
		}
	}, [open]);

	useEffect(() => {
		const t = setTimeout(() => setDebouncedSearch(search), 250);
		return () => clearTimeout(t);
	}, [search]);

	useEffect(() => {
		const orgs = orgsQuery.data;
		if (orgs && orgs.length > 0 && !owner) setOwner(orgs[0].login);
	}, [orgsQuery.data, owner]);

	const derivedShortName = useMemo(() => {
		if (mode === 'link') {
			const sel = reposQuery.data?.find((r) => r.full_name === selectedRepoFullName);
			return sel ? slugify(sel.name) : '';
		}
		return slugify(newRepoName);
	}, [mode, selectedRepoFullName, newRepoName, reposQuery.data]);

	const effectiveShortName = shortNameTouched ? shortName : derivedShortName;

	const canSubmit =
		!createRepo.isPending &&
		!!effectiveShortName.trim() &&
		!!owner &&
		(mode === 'link' ? !!selectedRepoFullName : !!newRepoName.trim());

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (!owner) return;
		setError(null);
		try {
			if (mode === 'link') {
				const sel = reposQuery.data?.find((r) => r.full_name === selectedRepoFullName);
				if (!sel) return;
				await createRepo.mutateAsync({
					short_name: effectiveShortName.trim(),
					mode: 'link',
					url: `https://github.com/${sel.full_name}`,
					oauth_connection_id: oauthConnectionId,
				});
			} else {
				await createRepo.mutateAsync({
					short_name: effectiveShortName.trim(),
					mode: 'create',
					owner,
					name: newRepoName.trim(),
					private: newRepoPrivate,
					oauth_connection_id: oauthConnectionId,
				});
			}
			onOpenChange(false);
		} catch (e) {
			setError((e as Error).message);
		}
	}

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className={dialogOverlayClassName} />
				<Dialog.Content className={dialogContentClassName.lg} data-testid="repo-picker-modal">
					<Dialog.Title className="text-base font-semibold mb-1 flex items-center gap-2">
						<GitBranch className="size-4" />
						Set up GitHub repo
					</Dialog.Title>
					<Dialog.Description className="text-sm text-text-muted mb-4">
						Pick an existing repository for this project, or create a new one in one of your orgs.
					</Dialog.Description>

					<div className="flex gap-1 border-b border-border mb-4">
						<button
							type="button"
							className={`px-3 py-1.5 text-sm border-b-2 transition-colors ${
								mode === 'link'
									? 'text-text font-medium border-text'
									: 'text-text-muted border-transparent hover:text-text'
							}`}
							onClick={() => setMode('link')}
							data-testid="repo-picker-tab-link"
						>
							Link existing
						</button>
						<button
							type="button"
							className={`px-3 py-1.5 text-sm border-b-2 transition-colors ${
								mode === 'create'
									? 'text-text font-medium border-text'
									: 'text-text-muted border-transparent hover:text-text'
							}`}
							onClick={() => setMode('create')}
							data-testid="repo-picker-tab-create"
						>
							Create new
						</button>
					</div>

					<form onSubmit={handleSubmit} className="space-y-3">
						<div className="flex flex-col gap-1.5">
							<label
								htmlFor="repo-picker-owner"
								className="text-xs font-medium uppercase tracking-wider text-text-muted"
							>
								Owner
							</label>
							{orgsQuery.isLoading ? (
								<div className="flex items-center gap-2 text-sm text-text-muted py-2">
									<Loader2 className="size-4 animate-spin" /> Loading…
								</div>
							) : (
								<select
									id="repo-picker-owner"
									className="rounded-radius-md border border-border bg-bg px-3 py-2 text-[13px] text-text outline-none focus:border-border-hover"
									value={owner ?? ''}
									onChange={(e) => setOwner(e.target.value)}
									data-testid="repo-picker-owner"
								>
									{(orgsQuery.data ?? []).map((o) => (
										<option key={o.login} value={o.login}>
											{o.login}
											{o.is_personal ? ' (you)' : ''}
										</option>
									))}
								</select>
							)}
						</div>

						{mode === 'link' ? (
							<>
								<Input
									label="Search"
									placeholder="Filter by name…"
									value={search}
									onChange={(e) => setSearch(e.target.value)}
								/>
								<div className="flex flex-col gap-1.5">
									<span className="text-xs font-medium uppercase tracking-wider text-text-muted">
										Repository
									</span>
									<div className="rounded-radius-md border border-border bg-bg max-h-64 overflow-y-auto">
										{reposQuery.isLoading && (
											<div className="flex items-center gap-2 text-sm text-text-muted px-3 py-3">
												<Loader2 className="size-4 animate-spin" /> Loading…
											</div>
										)}
										{!reposQuery.isLoading && (reposQuery.data?.length ?? 0) === 0 && (
											<div className="text-sm text-text-muted px-3 py-3">No repos found.</div>
										)}
										{(reposQuery.data ?? []).map((r: GitHubRepoSummary) => (
											<button
												type="button"
												key={r.id}
												onClick={() => setSelectedRepoFullName(r.full_name)}
												className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm border-b border-border-subtle last:border-b-0 hover:bg-bg-subtle ${
													selectedRepoFullName === r.full_name ? 'bg-bg-subtle' : ''
												}`}
												data-testid={`repo-picker-row-${r.full_name}`}
											>
												<span className="font-mono text-xs">{r.full_name}</span>
												{r.private && (
													<span className="flex items-center gap-1 text-text-muted text-xs">
														<Lock className="size-3" /> private
													</span>
												)}
											</button>
										))}
									</div>
								</div>
							</>
						) : (
							<>
								<Input
									label="Repository name"
									placeholder="my-new-service"
									value={newRepoName}
									onChange={(e) => setNewRepoName(e.target.value)}
									required
								/>
								<label className="flex items-center gap-2 text-sm">
									<input
										type="checkbox"
										checked={newRepoPrivate}
										onChange={(e) => setNewRepoPrivate(e.target.checked)}
									/>
									Private repository
								</label>
							</>
						)}

						<Input
							label="Short name"
							placeholder={derivedShortName || 'api'}
							value={effectiveShortName}
							onChange={(e) => {
								setShortNameTouched(true);
								setShortName(e.target.value);
							}}
							required
						/>

						{error && (
							<div className="rounded-radius-md border border-accent-red/40 bg-accent-red/10 px-3 py-2 text-sm text-accent-red">
								{error}
							</div>
						)}

						<div className="flex justify-end gap-2 mt-2">
							<Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
								Cancel
							</Button>
							<Button type="submit" disabled={!canSubmit} data-testid="repo-picker-submit">
								{createRepo.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
								{mode === 'link' ? 'Link repo' : 'Create repo'}
							</Button>
						</div>
					</form>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
