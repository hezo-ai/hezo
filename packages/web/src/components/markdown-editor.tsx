import type { SystemPromptVar } from '@hezo/shared';
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
	/**
	 * Rendered above the textarea in edit mode — the slot a reference or legend
	 * for the field occupies (see {@link SystemPromptReference}).
	 */
	reference?: ReactNode;
	/** Substitution variables reachable from a `{{` trigger inside the textarea. */
	variables?: readonly SystemPromptVar[];

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
	/**
	 * Grow to fill the available height of a flex column (both the edit textarea
	 * and the preview). The caller must place this editor in a `flex flex-col`
	 * parent with a bounded height. Used by the fullscreen create-task dialog so
	 * the description occupies most of the space.
	 */
	fill?: boolean;
}

const TAB_BASE = 'px-2.5 py-1 rounded';
const TAB_ACTIVE = 'bg-surface text-text-1 shadow-sm';
const TAB_INACTIVE = 'text-text-2 hover:text-text-1';

/**
 * Reusable markdown editor with an Edit/Preview toggle. Edits go through
 * {@link MentionTextarea} (which degrades to a plain textarea when no
 * `projectId` is set) and the preview renders through {@link MarkdownProse}.
 * Optionally renders a `reference` above the field, offers substitution
 * `variables` through the textarea's `{{` lookup, and accepts a server-resolved
 * `previewContent` override for prompts whose preview is computed on the
 * backend.
 */
export function MarkdownEditor({
	value,
	onChange,
	label,
	labelClassName = 'text-sm text-text-2',
	helpText,
	reference,
	variables,
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
	fill = false,
}: MarkdownEditorProps) {
	const [mode, setMode] = useState<MarkdownEditorMode>(defaultMode);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	function switchMode(next: MarkdownEditorMode) {
		if (next === mode) return;
		setMode(next);
		onModeChange?.(next);
	}

	const previewBody = previewContent ?? value;

	return (
		<div className={fill ? 'flex min-h-0 flex-1 flex-col' : undefined}>
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
				<div className={fill ? 'flex min-h-0 flex-1 flex-col' : 'contents'}>
					{reference}
					<MentionTextarea
						ref={textareaRef}
						projectId={projectId}
						projectSlug={projectSlug}
						variables={variables}
						value={value}
						onChange={(e) => onChange(e.target.value)}
						aria-label={ariaLabel}
						placeholder={placeholder}
						required={required}
						rows={rows}
						containerClassName={fill ? 'relative flex min-h-0 flex-1 flex-col' : 'relative'}
						wrapperClassName={fill ? 'flex min-h-0 flex-1 flex-col' : undefined}
						className={fill ? `min-h-0 flex-1 resize-none ${className ?? ''}` : className}
					/>
					{helpText && <p className="text-xs text-text-3 mt-1">{helpText}</p>}
				</div>
			) : (
				<div
					data-testid={previewTestId}
					className={`${fill ? 'min-h-0 flex-1 overflow-y-auto' : previewClassName} rounded-md border border-border bg-surface-2 px-3 py-2 text-sm`}
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
