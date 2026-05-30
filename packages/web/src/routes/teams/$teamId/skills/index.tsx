import { createFileRoute, useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { MarkdownProse } from '../../../../components/markdown-prose';
import { Button } from '../../../../components/ui/button';
import {
	type SkillListItem,
	useCreateSkill,
	useDeleteSkill,
	useSkill,
	useSkills,
	useSyncSkill,
	useUpdateSkill,
} from '../../../../hooks/use-skills';

interface SkillsSearch {
	slug?: string;
}

export const Route = createFileRoute('/teams/$teamId/skills/')({
	validateSearch: (search: Record<string, unknown>): SkillsSearch => ({
		slug: typeof search.slug === 'string' ? search.slug : undefined,
	}),
	component: SkillsPage,
});

type CreateMode = 'inline' | 'download';

function sourceBadge(skill: Pick<SkillListItem, 'source_url'>): {
	label: string;
	className: string;
} {
	// We can reliably detect "downloaded" via source_url. Agent-authored vs.
	// human-authored manual skills are indistinguishable from the list payload,
	// so both surface as "manual".
	if (skill.source_url) {
		return { label: 'downloaded', className: 'bg-blue-100 text-blue-700' };
	}
	return { label: 'manual', className: 'bg-gray-100 text-gray-600' };
}

function SkillsPage() {
	const { teamId } = useParams({ from: '/teams/$teamId/skills/' });
	const { slug: searchSlug } = Route.useSearch();
	const { data: skills } = useSkills(teamId);
	const [selectedSlug, setSelectedSlug] = useState<string | null>(searchSlug ?? null);
	const [isCreating, setIsCreating] = useState(false);

	useEffect(() => {
		if (searchSlug) {
			setSelectedSlug(searchSlug);
			setIsCreating(false);
		}
	}, [searchSlug]);

	const showDetail = selectedSlug !== null || isCreating;

	return (
		<div className="flex h-full flex-col md:flex-row">
			{/* List pane */}
			<aside
				className={`${
					showDetail ? 'hidden md:flex' : 'flex'
				} w-full shrink-0 flex-col border-b border-gray-200 md:flex md:w-80 md:border-b-0 md:border-r`}
			>
				<div className="flex items-center justify-between gap-2 border-b border-gray-200 p-4">
					<h1 className="text-base font-semibold">Skills database</h1>
					<Button
						size="sm"
						onClick={() => {
							setIsCreating(true);
							setSelectedSlug(null);
						}}
					>
						New
					</Button>
				</div>
				<div className="flex-1 overflow-y-auto">
					{(skills ?? []).length === 0 ? (
						<p className="p-4 text-sm text-gray-500">No skills yet.</p>
					) : (
						<ul className="divide-y divide-gray-100">
							{(skills ?? []).map((skill) => {
								const badge = sourceBadge(skill);
								const active = skill.slug === selectedSlug;
								return (
									<li key={skill.id}>
										<button
											type="button"
											onClick={() => {
												setSelectedSlug(skill.slug);
												setIsCreating(false);
											}}
											className={`flex w-full flex-col gap-1 px-4 py-3 text-left hover:bg-gray-50 ${
												active ? 'bg-gray-50' : ''
											}`}
										>
											<span className="flex items-center gap-2">
												<span className="truncate text-sm font-medium">{skill.name}</span>
												<span
													className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${badge.className}`}
												>
													{badge.label}
												</span>
											</span>
											{skill.description ? (
												<span className="line-clamp-2 text-xs text-gray-500">
													{skill.description}
												</span>
											) : null}
										</button>
									</li>
								);
							})}
						</ul>
					)}
				</div>
			</aside>

			{/* Detail / editor pane */}
			<main className={`${showDetail ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 flex-col`}>
				{isCreating ? (
					<CreateSkillForm
						teamId={teamId}
						onCancel={() => setIsCreating(false)}
						onCreated={(slug) => {
							setIsCreating(false);
							setSelectedSlug(slug);
						}}
					/>
				) : selectedSlug ? (
					<SkillDetailPane
						key={selectedSlug}
						teamId={teamId}
						slug={selectedSlug}
						onBack={() => setSelectedSlug(null)}
						onDeleted={() => setSelectedSlug(null)}
					/>
				) : (
					<div className="hidden flex-1 items-center justify-center p-8 text-sm text-gray-500 md:flex">
						Select a skill or create a new one.
					</div>
				)}
				{/* TODO: skills revision history (no endpoint yet) */}
			</main>
		</div>
	);
}

function CreateSkillForm({
	teamId,
	onCancel,
	onCreated,
}: {
	teamId: string;
	onCancel: () => void;
	onCreated: (slug: string) => void;
}) {
	const [mode, setMode] = useState<CreateMode>('inline');
	const [name, setName] = useState('');
	const [description, setDescription] = useState('');
	const [content, setContent] = useState('');
	const [sourceUrl, setSourceUrl] = useState('');
	const [error, setError] = useState<string | null>(null);
	const createSkill = useCreateSkill(teamId);

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);
		try {
			const created = await createSkill.mutateAsync(
				mode === 'download'
					? { name, description: description || undefined, source_url: sourceUrl }
					: { name, description: description || undefined, content },
			);
			onCreated(created.slug);
		} catch {
			setError('Failed to create skill. Check the inputs and try again.');
		}
	};

	return (
		<form onSubmit={submit} className="flex flex-1 flex-col overflow-y-auto p-4 md:p-6">
			<div className="mb-4 flex items-center justify-between gap-2">
				<h2 className="text-base font-semibold">New skill</h2>
				<Button type="button" variant="ghost" size="sm" onClick={onCancel}>
					Cancel
				</Button>
			</div>

			<div className="mb-4 inline-flex w-fit rounded-md border border-gray-200 p-0.5">
				<button
					type="button"
					onClick={() => setMode('inline')}
					className={`rounded px-3 py-1 text-sm ${
						mode === 'inline' ? 'bg-gray-900 text-white' : 'text-gray-600'
					}`}
				>
					Write content
				</button>
				<button
					type="button"
					onClick={() => setMode('download')}
					className={`rounded px-3 py-1 text-sm ${
						mode === 'download' ? 'bg-gray-900 text-white' : 'text-gray-600'
					}`}
				>
					Download from URL
				</button>
			</div>

			<label className="mb-3 flex flex-col gap-1 text-sm">
				<span className="font-medium">Name</span>
				<input
					value={name}
					onChange={(e) => setName(e.target.value)}
					required
					className="rounded border border-gray-300 px-3 py-2 text-sm"
				/>
			</label>

			<label className="mb-3 flex flex-col gap-1 text-sm">
				<span className="font-medium">Description</span>
				<input
					value={description}
					onChange={(e) => setDescription(e.target.value)}
					className="rounded border border-gray-300 px-3 py-2 text-sm"
				/>
			</label>

			{mode === 'download' ? (
				<label className="mb-3 flex flex-col gap-1 text-sm">
					<span className="font-medium">Source URL</span>
					<input
						value={sourceUrl}
						onChange={(e) => setSourceUrl(e.target.value)}
						required
						type="url"
						placeholder="https://example.com/skill.md"
						className="rounded border border-gray-300 px-3 py-2 text-sm"
					/>
				</label>
			) : (
				<label className="mb-3 flex flex-1 flex-col gap-1 text-sm">
					<span className="font-medium">Content (markdown)</span>
					<textarea
						value={content}
						onChange={(e) => setContent(e.target.value)}
						required
						className="min-h-48 flex-1 rounded border border-gray-300 px-3 py-2 font-mono text-sm"
					/>
				</label>
			)}

			{error ? <p className="mb-3 text-sm text-red-600">{error}</p> : null}

			<div className="flex gap-2">
				<Button type="submit" disabled={createSkill.isPending}>
					{createSkill.isPending ? 'Creating…' : 'Create'}
				</Button>
			</div>
		</form>
	);
}

function SkillDetailPane({
	teamId,
	slug,
	onBack,
	onDeleted,
}: {
	teamId: string;
	slug: string;
	onBack: () => void;
	onDeleted: () => void;
}) {
	const { data: skill } = useSkill(teamId, slug);
	const updateSkill = useUpdateSkill(teamId);
	const deleteSkill = useDeleteSkill(teamId);
	const syncSkill = useSyncSkill(teamId);

	const [isEditing, setIsEditing] = useState(false);
	const [name, setName] = useState('');
	const [description, setDescription] = useState('');
	const [content, setContent] = useState('');
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (skill) {
			setName(skill.name);
			setDescription(skill.description ?? '');
			setContent(skill.content);
		}
	}, [skill]);

	if (!skill) {
		return (
			<div className="flex flex-1 items-center justify-center p-8 text-sm text-gray-500">
				Loading…
			</div>
		);
	}

	const badge = sourceBadge(skill);

	const save = async (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);
		try {
			await updateSkill.mutateAsync({
				slug,
				input: { name, description: description || undefined, content },
			});
			setIsEditing(false);
		} catch {
			setError('Failed to save changes.');
		}
	};

	const remove = async () => {
		if (!window.confirm(`Delete "${skill.name}"?`)) return;
		try {
			await deleteSkill.mutateAsync(slug);
			onDeleted();
		} catch {
			setError('Failed to delete skill.');
		}
	};

	return (
		<div className="flex flex-1 flex-col overflow-y-auto p-4 md:p-6">
			<div className="mb-4 flex flex-wrap items-center gap-2">
				<Button type="button" variant="ghost" size="sm" className="md:hidden" onClick={onBack}>
					Back
				</Button>
				<span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${badge.className}`}>
					{badge.label}
				</span>
				<div className="ml-auto flex flex-wrap gap-2">
					{skill.source_url ? (
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={syncSkill.isPending}
							onClick={() => syncSkill.mutate(slug)}
						>
							{syncSkill.isPending ? 'Syncing…' : 'Sync'}
						</Button>
					) : null}
					{!isEditing ? (
						<Button type="button" variant="outline" size="sm" onClick={() => setIsEditing(true)}>
							Edit
						</Button>
					) : null}
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={deleteSkill.isPending}
						onClick={remove}
					>
						Delete
					</Button>
				</div>
			</div>

			{isEditing ? (
				<form onSubmit={save} className="flex flex-1 flex-col">
					<label className="mb-3 flex flex-col gap-1 text-sm">
						<span className="font-medium">Name</span>
						<input
							value={name}
							onChange={(e) => setName(e.target.value)}
							required
							className="rounded border border-gray-300 px-3 py-2 text-sm"
						/>
					</label>
					<label className="mb-3 flex flex-col gap-1 text-sm">
						<span className="font-medium">Description</span>
						<input
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							className="rounded border border-gray-300 px-3 py-2 text-sm"
						/>
					</label>
					<label className="mb-3 flex flex-1 flex-col gap-1 text-sm">
						<span className="font-medium">Content (markdown)</span>
						<textarea
							value={content}
							onChange={(e) => setContent(e.target.value)}
							required
							className="min-h-48 flex-1 rounded border border-gray-300 px-3 py-2 font-mono text-sm"
						/>
					</label>
					{error ? <p className="mb-3 text-sm text-red-600">{error}</p> : null}
					<div className="flex gap-2">
						<Button type="submit" disabled={updateSkill.isPending}>
							{updateSkill.isPending ? 'Saving…' : 'Save'}
						</Button>
						<Button
							type="button"
							variant="ghost"
							onClick={() => {
								setIsEditing(false);
								setName(skill.name);
								setDescription(skill.description ?? '');
								setContent(skill.content);
							}}
						>
							Cancel
						</Button>
					</div>
				</form>
			) : (
				<>
					<h2 className="text-lg font-semibold">{skill.name}</h2>
					{skill.description ? (
						<p className="mt-1 text-sm text-gray-600">{skill.description}</p>
					) : null}
					{skill.source_url ? (
						<p className="mt-2 break-all text-xs text-gray-500">
							Source:{' '}
							<a
								href={skill.source_url}
								target="_blank"
								rel="noreferrer"
								className="text-blue-600 underline"
							>
								{skill.source_url}
							</a>
						</p>
					) : null}
					{error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
					<div className="mt-4">
						<MarkdownProse teamId={teamId}>{skill.content}</MarkdownProse>
					</div>
				</>
			)}
		</div>
	);
}

export default SkillsPage;
