import { ArrowLeft, FileText, Loader2, Plus, Trash2 } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { MarkdownProse } from './markdown-prose';
import { MentionTextarea } from './mention-textarea';
import { Button } from './ui/button';
import { EmptyState } from './ui/empty-state';

export interface DocItem {
	key: string;
	label: ReactNode;
	meta?: ReactNode;
	pinned?: boolean;
	canDelete?: boolean;
}

interface DocsLibraryProps {
	items: DocItem[];
	isLoadingList?: boolean;
	selectedKey: string | null;
	onSelect: (key: string | null) => void;

	docContent: string | null | undefined;
	isLoadingDoc?: boolean;

	onSave: (content: string) => Promise<void> | void;
	isSaving?: boolean;
	onDelete?: () => Promise<void> | void;

	onNewDoc?: () => void;
	isCreating?: boolean;
	newForm?: ReactNode;

	viewerExtras?: ReactNode;

	emptyTitle?: string;
	emptyDescription?: string;

	companyId?: string;
	projectSlug?: string;
}

export function DocsLibrary({
	items,
	isLoadingList,
	selectedKey,
	onSelect,
	docContent,
	isLoadingDoc,
	onSave,
	isSaving,
	onDelete,
	onNewDoc,
	isCreating,
	newForm,
	viewerExtras,
	emptyTitle = 'No documents yet',
	emptyDescription,
	companyId,
	projectSlug,
}: DocsLibraryProps) {
	const [mode, setMode] = useState<'view' | 'edit'>('view');
	const [modeKey, setModeKey] = useState<string | null>(selectedKey);
	const [draft, setDraft] = useState('');

	if (modeKey !== selectedKey) {
		setModeKey(selectedKey);
		setMode('view');
	}

	useEffect(() => {
		if (mode === 'edit' && docContent != null) {
			setDraft(docContent);
		}
	}, [mode, docContent]);

	const showNewForm = isCreating && !!newForm;
	const selectedItem = selectedKey ? items.find((it) => it.key === selectedKey) : undefined;
	const showRightPane = showNewForm || selectedKey;

	async function handleSave() {
		await onSave(draft);
		setMode('view');
	}

	async function handleDelete() {
		if (!onDelete) return;
		if (!confirm('Delete this document?')) return;
		await onDelete();
		onSelect(null);
	}

	return (
		<div className="grid grid-cols-1 md:grid-cols-[240px_1fr] md:gap-6 md:min-h-[500px]">
			<aside
				className={`md:border-r md:border-border md:pr-6 ${
					showRightPane ? 'hidden md:block' : 'block'
				}`}
			>
				{onNewDoc && (
					<Button
						variant="outline"
						size="sm"
						className="w-full mb-3 justify-start"
						onClick={onNewDoc}
					>
						<Plus className="w-3.5 h-3.5" /> New document
					</Button>
				)}

				{isLoadingList ? (
					<div className="text-text-muted text-[13px] py-4">Loading...</div>
				) : items.length === 0 ? (
					<div className="text-text-muted text-[13px] py-4">No documents</div>
				) : (
					<ul className="flex flex-col gap-0.5">
						{items.map((item) => {
							const isActive = item.key === selectedKey;
							return (
								<li key={item.key}>
									<button
										type="button"
										onClick={() => onSelect(item.key)}
										className={`w-full text-left px-2 py-1.5 rounded-radius-md transition-colors ${
											isActive
												? 'bg-bg-subtle text-text'
												: 'text-text-muted hover:bg-bg-subtle hover:text-text'
										}`}
									>
										<div className="text-[13px] font-medium truncate">{item.label}</div>
										{item.meta && (
											<div className="text-[11px] text-text-subtle mt-0.5 truncate">
												{item.meta}
											</div>
										)}
									</button>
								</li>
							);
						})}
					</ul>
				)}
			</aside>

			<section className={showRightPane ? 'block' : 'hidden md:block'}>
				{!showNewForm && selectedKey && (
					<button
						type="button"
						onClick={() => onSelect(null)}
						className="md:hidden inline-flex items-center gap-1 text-sm text-text-muted hover:text-text mb-3"
					>
						<ArrowLeft className="w-3.5 h-3.5" /> Back
					</button>
				)}

				{showNewForm ? (
					newForm
				) : !selectedKey ? (
					<EmptyState
						icon={<FileText className="w-10 h-10" />}
						title={emptyTitle}
						description={emptyDescription}
					/>
				) : isLoadingDoc || docContent == null ? (
					<div className="text-text-muted text-[13px] py-4">Loading...</div>
				) : (
					<div className="flex flex-col">
						<div className="flex items-center justify-between gap-2 mb-4 pb-3 border-b border-border-subtle">
							<h2 className="text-base font-semibold text-text truncate">
								{selectedItem?.label ?? selectedKey}
							</h2>
							<div className="flex items-center gap-2 shrink-0">
								{mode === 'view' ? (
									<>
										<Button variant="ghost" size="sm" onClick={() => setMode('edit')}>
											Edit
										</Button>
										{onDelete && selectedItem?.canDelete !== false && (
											<Button
												variant="ghost"
												size="sm"
												className="text-accent-red"
												onClick={handleDelete}
												aria-label="Delete document"
											>
												<Trash2 className="w-3.5 h-3.5" />
											</Button>
										)}
									</>
								) : (
									<>
										<Button variant="ghost" size="sm" onClick={() => setMode('view')}>
											Cancel
										</Button>
										<Button size="sm" onClick={handleSave} disabled={isSaving}>
											{isSaving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
											Save
										</Button>
									</>
								)}
							</div>
						</div>

						{mode === 'view' ? (
							<MarkdownProse companyId={companyId} projectSlug={projectSlug}>
								{docContent || '_(empty)_'}
							</MarkdownProse>
						) : (
							<MentionTextarea
								companyId={companyId}
								projectSlug={projectSlug}
								value={draft}
								onChange={(e) => setDraft(e.target.value)}
								className="min-h-[400px] font-mono text-xs"
							/>
						)}

						{mode === 'view' && viewerExtras}
					</div>
				)}
			</section>
		</div>
	);
}
