import { FileText, Upload, X } from 'lucide-react';
import { useCallback, useRef } from 'react';

interface ProjectPlanUploadProps {
	value: string;
	filename: string | null;
	onChange: (value: string, filename: string | null) => void;
}

export function ProjectPlanUpload({ value, filename, onChange }: ProjectPlanUploadProps) {
	const fileInputRef = useRef<HTMLInputElement>(null);

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
		<div className="flex flex-col gap-1.5">
			{value ? (
				<div className="rounded-md border border-border bg-surface px-3 py-2 text-[13px]">
					<div className="flex items-center justify-between mb-2">
						<span className="flex items-center gap-1.5 text-text-2">
							<FileText className="w-3.5 h-3.5" />
							{filename || 'Pasted content'}
						</span>
						<button
							type="button"
							onClick={() => onChange('', null)}
							className="text-text-3 hover:text-text-1 p-0.5"
							aria-label="Remove project plan document"
						>
							<X className="w-3.5 h-3.5" />
						</button>
					</div>
					<p className="text-text-3 text-xs truncate">
						{value.slice(0, 120)}
						{value.length > 120 ? '…' : ''}
					</p>
				</div>
			) : (
				<button
					type="button"
					className="rounded-md border border-dashed border-border bg-surface px-3 py-4 text-[13px] text-center cursor-pointer hover:border-border-strong transition-colors w-full"
					onClick={() => fileInputRef.current?.click()}
					onDragOver={(e) => {
						e.preventDefault();
						e.stopPropagation();
					}}
					onDrop={(e) => {
						e.preventDefault();
						e.stopPropagation();
						const file = e.dataTransfer.files[0];
						if (file) handleFileUpload(file);
					}}
				>
					<Upload className="w-4 h-4 mx-auto mb-1 text-text-3" />
					<p className="text-text-3">Drop a file here or click to upload</p>
					<p className="text-text-3 text-xs mt-1">.md or .txt</p>
				</button>
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
		</div>
	);
}
