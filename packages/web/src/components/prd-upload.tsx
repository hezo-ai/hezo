import { FileText, Upload, X } from 'lucide-react';
import { useCallback, useRef } from 'react';

interface PrdUploadProps {
	value: string;
	filename: string | null;
	onChange: (value: string, filename: string | null) => void;
}

export function PrdUpload({ value, filename, onChange }: PrdUploadProps) {
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
			<span className="text-xs font-medium uppercase tracking-wider text-text-muted">
				Requirements Document (optional)
			</span>
			{value ? (
				<div className="rounded-radius-md border border-border bg-bg px-3 py-2 text-[13px]">
					<div className="flex items-center justify-between mb-2">
						<span className="flex items-center gap-1.5 text-text-muted">
							<FileText className="w-3.5 h-3.5" />
							{filename || 'Pasted content'}
						</span>
						<button
							type="button"
							onClick={() => onChange('', null)}
							className="text-text-subtle hover:text-text p-0.5"
						>
							<X className="w-3.5 h-3.5" />
						</button>
					</div>
					<p className="text-text-subtle text-xs truncate">
						{value.slice(0, 120)}
						{value.length > 120 ? '…' : ''}
					</p>
				</div>
			) : (
				<button
					type="button"
					className="rounded-radius-md border border-dashed border-border bg-bg px-3 py-4 text-[13px] text-center cursor-pointer hover:border-border-hover transition-colors w-full"
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
					<Upload className="w-4 h-4 mx-auto mb-1 text-text-subtle" />
					<p className="text-text-subtle">Drop a file here or click to upload</p>
					<p className="text-text-subtle text-xs mt-1">.md or .txt</p>
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
