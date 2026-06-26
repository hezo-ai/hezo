import { isAllowedProjectIconInputMime } from '@hezo/shared';
import { ImagePlus, Loader2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { type Project, useRemoveProjectIcon, useUploadProjectIcon } from '../hooks/use-projects';
import { toast } from '../hooks/use-toast';
import { normalizeProjectIcon } from '../lib/normalize-image';
import { Avatar, getInitials } from './ui/avatar';
import { Button } from './ui/button';

interface Preview {
	blob: Blob;
	url: string;
}

/**
 * GitHub-style project-icon control: shows the current icon (or the initials
 * fallback), lets the user pick an image, previews the center-cropped square
 * before saving, and removes an existing icon. The picked image is normalized to
 * a ≤512×512 PNG client-side (`normalizeProjectIcon`) before upload.
 */
export function ProjectIconSection({ project }: { project: Project }) {
	const upload = useUploadProjectIcon(project.slug);
	const remove = useRemoveProjectIcon(project.slug);
	const inputRef = useRef<HTMLInputElement>(null);
	const [preview, setPreview] = useState<Preview | null>(null);
	const [processing, setProcessing] = useState(false);

	const busy = processing || upload.isPending || remove.isPending;

	function clearPreview() {
		setPreview((prev) => {
			if (prev) URL.revokeObjectURL(prev.url);
			return null;
		});
	}

	async function handleFile(file: File) {
		if (!isAllowedProjectIconInputMime(file.type)) {
			toast.error('Unsupported image type. Use PNG, JPEG, WebP, GIF, or SVG.');
			return;
		}
		setProcessing(true);
		try {
			const blob = await normalizeProjectIcon(file);
			clearPreview();
			setPreview({ blob, url: URL.createObjectURL(blob) });
		} catch {
			toast.error('Could not read that image. Try a different file.');
		} finally {
			setProcessing(false);
		}
	}

	async function handleSave() {
		if (!preview) return;
		try {
			await upload.mutateAsync(preview.blob);
			clearPreview();
		} catch {
			toast.error('Failed to upload icon');
		}
	}

	async function handleRemove() {
		try {
			await remove.mutateAsync();
		} catch {
			toast.error('Failed to remove icon');
		}
	}

	const shownUrl = preview?.url ?? project.icon_url ?? undefined;

	return (
		<section>
			<h2 className="text-sm font-medium text-text-2 mb-3">Project icon</h2>
			<div className="flex flex-col gap-4 sm:flex-row sm:items-center">
				<div data-testid="project-icon-preview">
					<Avatar initials={getInitials(project.name)} imageUrl={shownUrl} size="lg" />
				</div>
				<div className="flex flex-col gap-2">
					<div className="flex flex-wrap gap-2">
						<input
							ref={inputRef}
							type="file"
							accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
							className="hidden"
							data-testid="project-icon-input"
							onChange={(e) => {
								const file = e.target.files?.[0];
								// Reset so re-picking the same file fires change again.
								e.target.value = '';
								if (file) void handleFile(file);
							}}
						/>
						{preview ? (
							<>
								<Button
									size="sm"
									onClick={handleSave}
									disabled={busy}
									data-testid="project-icon-save"
								>
									{upload.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Save icon'}
								</Button>
								<Button size="sm" variant="ghost" onClick={clearPreview} disabled={busy}>
									Cancel
								</Button>
							</>
						) : (
							<>
								<Button
									size="sm"
									variant="outline"
									onClick={() => inputRef.current?.click()}
									disabled={busy}
									data-testid="project-icon-upload"
								>
									{processing ? (
										<Loader2 className="w-3 h-3 animate-spin" />
									) : (
										<>
											<ImagePlus className="w-3.5 h-3.5 mr-1.5" />
											{project.icon_url ? 'Replace image' : 'Upload image'}
										</>
									)}
								</Button>
								{project.icon_url && (
									<Button
										size="sm"
										variant="destructive"
										onClick={handleRemove}
										disabled={busy}
										data-testid="project-icon-remove"
									>
										{remove.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Remove'}
									</Button>
								)}
							</>
						)}
					</div>
					<p className="text-xs text-text-3">
						Shown in the project rail. Square images work best; we crop to a square and resize to{' '}
						512×512. Leave unset to show the project initials.
					</p>
				</div>
			</div>
		</section>
	);
}
