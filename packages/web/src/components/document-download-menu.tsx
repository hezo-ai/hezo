import {
	DOC_DOWNLOAD_MIME,
	type DocDownloadFormat,
	docDownloadFilename,
	markdownToPlainText,
} from '@hezo/shared';
import * as Popover from '@radix-ui/react-popover';
import { ChevronDown, Download, FileText, Type } from 'lucide-react';
import { useState } from 'react';
import { downloadTextFile } from '../lib/download-file';
import { Tooltip } from './ui/tooltip';

/**
 * `'toolbar'` is the labelled control on the Documents page, which has room for
 * the word "Download". `'icon'` is the compact form for the two preview surfaces
 * (task-sidebar panel, standalone preview route), whose headers are icon-only
 * clusters — it matches their shared icon-button styling and names itself
 * through a tooltip instead.
 */
export type DocumentDownloadVariant = 'toolbar' | 'icon';

const TRIGGER_CLASS: Record<DocumentDownloadVariant, string> = {
	toolbar:
		'inline-flex h-[26px] items-center justify-center gap-1.5 whitespace-nowrap rounded-sm border border-transparent bg-transparent px-2.5 text-[12.5px] font-medium text-text-2 transition-colors cursor-pointer outline-none hover:bg-surface-3 hover:text-text-1 focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:border-accent',
	icon: 'shrink-0 rounded-md p-1 text-text-3 transition-colors cursor-pointer outline-none hover:bg-surface-3 hover:text-text-1 focus-visible:ring-[3px] focus-visible:ring-ring',
};

interface DownloadOption {
	format: DocDownloadFormat;
	label: string;
	ext: string;
	description: string;
	icon: typeof FileText;
}

const OPTIONS: DownloadOption[] = [
	{
		format: 'markdown',
		label: 'Markdown',
		ext: '.md',
		description: 'Original source',
		icon: FileText,
	},
	{
		format: 'text',
		label: 'Plain text',
		ext: '.txt',
		description: 'Markdown stripped',
		icon: Type,
	},
];

/**
 * View-mode control that downloads the open document, shared by every read-only
 * doc surface (Documents page, task-sidebar preview panel, standalone preview
 * route). Documents are stored as Markdown, so Markdown is the lossless native
 * download and plain text is a stripped rendering. Both are produced client-side
 * from the already-loaded content — no server round-trip (see
 * {@link downloadTextFile}).
 */
export function DocumentDownloadMenu({
	filename,
	content,
	variant = 'toolbar',
}: {
	filename: string;
	content: string;
	variant?: DocumentDownloadVariant;
}) {
	const [open, setOpen] = useState(false);

	function handleDownload(format: DocDownloadFormat) {
		const name = docDownloadFilename(filename, format);
		const body = format === 'text' ? markdownToPlainText(content) : content;
		downloadTextFile(name, body, DOC_DOWNLOAD_MIME[format]);
		setOpen(false);
	}

	const trigger = (
		<Popover.Trigger
			className={TRIGGER_CLASS[variant]}
			aria-label="Download document"
			data-testid="doc-download"
		>
			{variant === 'icon' ? (
				<Download className="h-4 w-4" />
			) : (
				<>
					<Download className="w-3.5 h-3.5" />
					<span className="hidden sm:inline">Download</span>
					<ChevronDown className="w-3 h-3 opacity-70" />
				</>
			)}
		</Popover.Trigger>
	);

	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			{variant === 'icon' ? <Tooltip content="Download document">{trigger}</Tooltip> : trigger}
			<Popover.Portal>
				{/* z-[70] clears the task-detail preview panel, which is a full-screen
				    z-[60] overlay below lg - at z-50 the portalled menu painted behind
				    it and was invisible on mobile. Dialogs (z-[80]/[90]) still win. */}
				<Popover.Content
					align="end"
					sideOffset={6}
					className="z-[70] w-56 rounded-md border border-border bg-surface p-1 shadow-md"
				>
					<p className="px-2 pt-1 pb-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-text-3">
						Download as
					</p>
					{OPTIONS.map((opt) => {
						const Icon = opt.icon;
						return (
							<button
								key={opt.format}
								type="button"
								onClick={() => handleDownload(opt.format)}
								data-testid={`doc-download-${opt.format}`}
								className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-text-2 transition-colors cursor-pointer hover:bg-surface-3 hover:text-text-1"
							>
								<span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-surface-3 text-text-2">
									<Icon className="w-3.5 h-3.5" />
								</span>
								<span className="min-w-0 flex-1">
									<span className="block text-[13px] font-medium">
										{opt.label} <span className="font-mono text-[11px] text-text-3">{opt.ext}</span>
									</span>
									<span className="block truncate text-[11px] text-text-3">{opt.description}</span>
								</span>
							</button>
						);
					})}
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
