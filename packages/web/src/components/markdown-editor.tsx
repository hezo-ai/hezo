import { type ReactNode, useRef, useState } from 'react';
import { MarkdownProse } from './markdown-prose';
import { MentionTextarea } from './mention-textarea';

export type MarkdownEditorMode = 'edit' | 'preview';

interface MarkdownEditorProps {
	value: string;
	onChange: (value: string) => void;

	/** Field label rendered to the left of the Edit/Preview tabs. */
	label?: ReactNode;
	/** Class override for the label span (callers use different idioms). */
	labelClassName?: string;
	/** Helper text shown beneath the editor (edit mode only). */
	helpText?: ReactNode;
	/** Clickable chips that insert a token at the cursor — e.g. template variables. */
	chips?: string[];

	placeholder?: string;
	/** Accessible name for the textarea; also how tests query it (findByLabelText). */
	ariaLabel?: string;
	required?: boolean;
	rows?: number;
	/** Extra classes for the textarea (sizing / font). */
	className?: string;

	/** Enables @mentions in the editor and mention links in the preview. */
	projectId?: string;
	projectSlug?: string;

	/**
	 * Server-resolved preview body. When provided the preview renders this instead
	 * of `value` (e.g. an agent prompt with its placeholders filled in).
	 */
	previewContent?: string;
	/** Shows a "Resolving…" placeholder while `previewContent` loads. */
	isPreviewLoading?: boolean;
	/** Fires on every mode flip so a parent can lazily fetch `previewContent`. */
	onModeChange?: (mode: MarkdownEditorMode) => void;
	/** Preview container classes (mainly min-height). */
	previewClassName?: string;
	previewTestId?: string;
	/** Markdown rendered when there is nothing to preview. */
	emptyPreviewText?: string;
	defaultMode?: MarkdownEditorMode;
}

const TAB_BASE = 'px-2.5 py-1 rounded';
const TAB_ACTIVE = 'bg-surface text-text-1 shadow-sm';
const TAB_INACTIVE = 'text-text-2 hover:text-text-1';

/**
 * Reusable markdown editor with an Edit/Preview toggle. Edits go through
 * {@link MentionTextarea} (which degrades to a plain textarea when no
 * `projectId` is set) and the preview renders through {@link MarkdownProse}.
 * Optionally shows template-variable chips that insert at the cursor, and
 * accepts a server-resolved `previewContent` override for prompts whose preview
 * is computed on the backend.
 */
export function MarkdownEditor({
	value,
	onChange,
	label,
	labelClassName = 'text-sm text-text-2',
	helpText,
	chips,
	placeholder,
	ariaLabel,
	required,
	rows,
	className,
	projectId,
	projectSlug,
	previewContent,
	isPreviewLoading,
	onModeChange,
	previewClassName = 'min-h-[160px]',
	previewTestId,
	emptyPreviewText = '',
	defaultMode = 'edit',
}: MarkdownEditorProps) {
	const [mode, setMode] = useState<MarkdownEditorMode>(defaultMode);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	function switchMode(next: MarkdownEditorMode) {
		if (next === mode) return;
		setMode(next);
		onModeChange?.(next);
	}

	function insertChip(token: string) {
		const el = textareaRef.current;
		if (!el) {
			// No live textarea (e.g. while previewing): append with a separating space.
			const sep = value && !/\s$/.test(value) ? ' ' : '';
			onChange(`${value}${sep}${token}`);
			return;
		}
		const start = el.selectionStart ?? value.length;
		const end = el.selectionEnd ?? start;
		const next = `${value.slice(0, start)}${token}${value.slice(end)}`;
		onChange(next);
		const caret = start + token.length;
		requestAnimationFrame(() => {
			el.focus();
			el.setSelectionRange(caret, caret);
		});
	}

	const previewBody = previewContent ?? value;

	return (
		<div>
			<div className="flex items-center justify-between gap-2 mb-1.5">
				{label ? <span className={labelClassName}>{label}</span> : <span />}
				<div
					role="tablist"
					aria-label="Editor view mode"
					className="inline-flex rounded-md border border-border-subtle bg-surface-2 p-0.5 text-xs"
				>
					<button
						type="button"
						role="tab"
						aria-selected={mode === 'edit'}
						onClick={() => switchMode('edit')}
						className={`${TAB_BASE} ${mode === 'edit' ? TAB_ACTIVE : TAB_INACTIVE}`}
					>
						Edit
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={mode === 'preview'}
						onClick={() => switchMode('preview')}
						className={`${TAB_BASE} ${mode === 'preview' ? TAB_ACTIVE : TAB_INACTIVE}`}
					>
						Preview
					</button>
				</div>
			</div>

			{mode === 'edit' ? (
				<>
					{chips && chips.length > 0 && (
						<div className="flex flex-wrap gap-1.5 mb-2">
							{chips.map((token) => (
								<button
									key={token}
									type="button"
									onClick={() => insertChip(token)}
									className="text-[11px] px-2 py-0.5 rounded-md bg-info-soft text-info-soft-fg cursor-pointer hover:opacity-80"
								>
									{token}
								</button>
							))}
						</div>
					)}
					<MentionTextarea
						ref={textareaRef}
						projectId={projectId}
						projectSlug={projectSlug}
						value={value}
						onChange={(e) => onChange(e.target.value)}
						aria-label={ariaLabel}
						placeholder={placeholder}
						required={required}
						rows={rows}
						className={className}
					/>
					{helpText && <p className="text-xs text-text-3 mt-1">{helpText}</p>}
				</>
			) : (
				<div
					data-testid={previewTestId}
					className={`${previewClassName} rounded-md border border-border bg-surface-2 px-3 py-2 text-sm`}
				>
					{isPreviewLoading ? (
						<div className="text-text-2 text-xs">Resolving…</div>
					) : (
						<MarkdownProse projectId={projectId} projectSlug={projectSlug}>
							{previewBody || emptyPreviewText}
						</MarkdownProse>
					)}
				</div>
			)}
		</div>
	);
}
