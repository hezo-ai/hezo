import { FileText, Upload, X } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { InfoTooltip } from './ui/info-tooltip';

interface ProjectPlanUploadProps {
	value: string;
	filename: string | null;
	onChange: (value: string, filename: string | null) => void;
}

const HELP_CONTENT =
	'Attach a fuller document describing what this project is for when the description above isn’t enough — goals, scope, context, constraints. For a software team the Captain uses it to write the formal PRD; for other teams it’s used directly as the plan. Supported files: .md, .txt, .markdown.';

/**
 * Compact "attach project plan" control: a single minimal-height row with a
 * dotted border that doubles as a click-to-upload button and a drag-&-drop zone,
 * with an inline help tooltip (also listing the supported extensions). Text plans
 * only — read via `FileReader.readAsText`. Controlled by the parent.
 */
export function ProjectPlanUpload({ value, filename, onChange }: ProjectPlanUploadProps) {
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [dragOver, setDragOver] = useState(false);

	const handleFileUpload = useCallback(
		(file: File) => {
			const reader = new FileReader();
			reader.onload = (ev) => {
				const content = ev.target?.result;
				if (typeof content === 'string') {
					onChange(content, file.name);
				}
			};
			reader.readAsText(file);
		},
		[onChange],
	);

	return (
		<>
			{value ? (
				<div className="flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-2 text-[13px] text-text-1">
					<FileText className="w-3.5 h-3.5 shrink-0 text-text-2" />
					<span className="flex-1 min-w-0 truncate">{filename || 'Pasted content'}</span>
					<button
						type="button"
						onClick={() => onChange('', null)}
						className="shrink-0 text-text-3 hover:text-text-1 p-0.5"
						aria-label="Remove project plan document"
					>
						<X className="w-3.5 h-3.5" />
					</button>
				</div>
			) : (
				// The whole row is the drop zone; the label area opens the file picker.
				// The tooltip is a sibling button (never nested inside the label button,
				// which would be invalid HTML).
				// biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop wrapper; the inner button owns click/keyboard interaction
				<div
					className={`flex items-center gap-2 rounded-md border border-dotted bg-surface px-2.5 py-2 text-[13px] transition-colors ${
						dragOver ? 'border-accent bg-accent-soft' : 'border-border-strong'
					}`}
					onDragEnter={(e) => {
						e.preventDefault();
						e.stopPropagation();
						setDragOver(true);
					}}
					onDragOver={(e) => {
						e.preventDefault();
						e.stopPropagation();
					}}
					onDragLeave={(e) => {
						e.preventDefault();
						e.stopPropagation();
						setDragOver(false);
					}}
					onDrop={(e) => {
						e.preventDefault();
						e.stopPropagation();
						setDragOver(false);
						const file = e.dataTransfer.files[0];
						if (file) handleFileUpload(file);
					}}
				>
					<button
						type="button"
						className="flex flex-1 min-w-0 items-center gap-2 text-left text-text-2 hover:text-text-1 transition-colors cursor-pointer"
						onClick={() => fileInputRef.current?.click()}
					>
						<Upload className="w-3.5 h-3.5 shrink-0 text-text-3" />
						<span className="shrink-0">Attach project plan</span>
						<span className="text-text-3 truncate">or drag &amp; drop</span>
					</button>
					<InfoTooltip
						label="What is a project plan document?"
						data-testid="project-plan-help"
						content={HELP_CONTENT}
					/>
				</div>
			)}
			<input
				ref={fileInputRef}
				type="file"
				accept=".md,.txt,.markdown"
				className="hidden"
				onChange={(e) => {
					const file = e.target.files?.[0];
					if (file) handleFileUpload(file);
					e.target.value = '';
				}}
			/>
		</>
	);
}
