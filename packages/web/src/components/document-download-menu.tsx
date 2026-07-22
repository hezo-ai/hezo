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

const TRIGGER_CLASS =
	'inline-flex h-[26px] items-center justify-center gap-1.5 whitespace-nowrap rounded-sm border border-transparent bg-transparent px-2.5 text-[12.5px] font-medium text-text-2 transition-colors cursor-pointer outline-none hover:bg-surface-3 hover:text-text-1 focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:border-accent';

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
 * View-mode toolbar control that downloads the open document. Documents are
 * stored as Markdown, so Markdown is the lossless native download and plain text
 * is a stripped rendering. Both are produced client-side from the already-loaded
 * content — no server round-trip (see {@link downloadTextFile}).
 */
export function DocumentDownloadMenu({ filename, content }: { filename: string; content: string }) {
	const [open, setOpen] = useState(false);

	function handleDownload(format: DocDownloadFormat) {
		const name = docDownloadFilename(filename, format);
		const body = format === 'text' ? markdownToPlainText(content) : content;
		downloadTextFile(name, body, DOC_DOWNLOAD_MIME[format]);
		setOpen(false);
	}

	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Trigger
				className={TRIGGER_CLASS}
				aria-label="Download document"
				data-testid="doc-download"
			>
				<Download className="w-3.5 h-3.5" />
				<span className="hidden sm:inline">Download</span>
				<ChevronDown className="w-3 h-3 opacity-70" />
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					align="end"
					sideOffset={6}
					className="z-50 w-56 rounded-md border border-border bg-surface p-1 shadow-md"
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
