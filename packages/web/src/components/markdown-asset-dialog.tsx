import * as Dialog from '@radix-ui/react-dialog';
import { ExternalLink, Loader2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ProjectAsset } from '../hooks/use-project-assets';
import { MarkdownProse } from './markdown-prose';
import { dialogOverlayClassName } from './ui/dialog';

type ViewMode = 'preview' | 'source';

const TAB_BASE = 'px-2.5 py-1 rounded';
const TAB_ACTIVE = 'bg-surface text-text-1 shadow-sm';
const TAB_INACTIVE = 'text-text-2 hover:text-text-1';

/**
 * Renders a markdown asset (e.g. a generated blog post) with a rich Preview and
 * a raw Source toggle. The body is fetched from the asset's signed URL (the
 * public asset route serves the stored markdown text). `projectId` is the
 * route-param slug so @mentions/`assets/<file>` references resolve.
 */
export function MarkdownAssetDialog({
	asset,
	projectId,
	open,
	onOpenChange,
}: {
	asset: ProjectAsset;
	projectId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [mode, setMode] = useState<ViewMode>('preview');
	const [content, setContent] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setContent(null);
		setError(null);
		setMode('preview');
		(async () => {
			try {
				const res = await fetch(asset.url);
				if (!res.ok) throw new Error(`Failed to load asset (${res.status})`);
				const text = await res.text();
				if (!cancelled) setContent(text);
			} catch (e) {
				if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load asset');
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [open, asset.url]);

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className={dialogOverlayClassName} />
				<Dialog.Content
					data-testid="markdown-asset-dialog"
					className="fixed inset-0 z-50 flex flex-col bg-surface outline-none sm:inset-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:w-full sm:max-w-3xl sm:max-h-[90vh] sm:rounded-lg sm:border sm:border-border sm:shadow-lg"
				>
					<div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
						<Dialog.Title
							className="min-w-0 truncate text-sm font-semibold text-text-1"
							title={asset.original_filename}
						>
							{asset.original_filename}
						</Dialog.Title>
						<Dialog.Description className="sr-only">
							Markdown asset {asset.original_filename}, shown as a rendered preview with a
							view-source toggle.
						</Dialog.Description>
						<div className="flex shrink-0 items-center gap-2">
							<div
								role="tablist"
								aria-label="Asset view mode"
								className="inline-flex rounded-md border border-border-subtle bg-surface-2 p-0.5 text-xs"
							>
								<button
									type="button"
									role="tab"
									aria-selected={mode === 'preview'}
									onClick={() => setMode('preview')}
									className={`${TAB_BASE} ${mode === 'preview' ? TAB_ACTIVE : TAB_INACTIVE}`}
									data-testid="markdown-asset-preview-tab"
								>
									Preview
								</button>
								<button
									type="button"
									role="tab"
									aria-selected={mode === 'source'}
									onClick={() => setMode('source')}
									className={`${TAB_BASE} ${mode === 'source' ? TAB_ACTIVE : TAB_INACTIVE}`}
									data-testid="markdown-asset-source-tab"
								>
									Source
								</button>
							</div>
							<a
								href={asset.url}
								target="_blank"
								rel="noopener noreferrer"
								className="p-1 text-text-3 hover:text-text-1"
								aria-label="Open raw markdown in a new tab"
							>
								<ExternalLink className="h-4 w-4" />
							</a>
							<Dialog.Close
								className="p-1 text-text-3 hover:text-text-1"
								aria-label="Close"
								data-testid="markdown-asset-close"
							>
								<X className="h-4 w-4" />
							</Dialog.Close>
						</div>
					</div>

					<div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
						{error ? (
							<div className="text-[13px] text-danger" data-testid="markdown-asset-error">
								{error}
							</div>
						) : content === null ? (
							<div className="flex items-center gap-2 text-[13px] text-text-2">
								<Loader2 className="h-3.5 w-3.5 animate-spin" />
								Loading…
							</div>
						) : mode === 'preview' ? (
							<MarkdownProse projectId={projectId} testId="markdown-asset-rendered">
								{content}
							</MarkdownProse>
						) : (
							<pre
								className="whitespace-pre-wrap break-words font-mono text-[12px] text-text-1"
								data-testid="markdown-asset-source"
							>
								{content}
							</pre>
						)}
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
