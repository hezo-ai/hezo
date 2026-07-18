import { isAllowedProjectIconInputMime } from '@hezo/shared';
import { ImagePlus, Loader2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from '../hooks/use-toast';
import { normalizeProjectIcon } from '../lib/normalize-image';
import { Avatar } from './ui/avatar';
import { Button } from './ui/button';

interface Preview {
	blob: Blob;
	url: string;
}

interface IconUploadSectionProps {
	/** Section heading (e.g. "Agent avatar"). */
	label: string;
	/** Helper copy under the buttons. */
	helpText: string;
	/** Fallback initials shown when there is no image. */
	initials: string;
	/** Current signed icon URL, or null/undefined when unset. */
	currentIconUrl?: string | null;
	/** Upload the normalized square-PNG blob. Resolves on success. */
	onUpload: (blob: Blob) => Promise<unknown>;
	/** Remove the current icon. Resolves on success. */
	onRemove: () => Promise<unknown>;
	isUploading: boolean;
	isRemoving: boolean;
	/** Prefix for the `data-testid`s (`<prefix>-input`, `-upload`, `-save`, `-remove`, `-preview`). */
	testIdPrefix: string;
}

/**
 * GitHub-style avatar/icon control shared by any entity that can carry a custom
 * image (project icon, agent avatar, admin avatar). Shows the current image (or
 * an initials fallback), lets the user pick an image, previews the
 * center-cropped square before saving, and removes an existing image. The picked
 * file is normalized to a ≤512×512 PNG client-side (`normalizeProjectIcon`)
 * before it is handed to `onUpload`. Data fetching/mutations live in the caller;
 * this component owns only the pick → preview → save/remove interaction.
 */
export function IconUploadSection({
	label,
	helpText,
	initials,
	currentIconUrl,
	onUpload,
	onRemove,
	isUploading,
	isRemoving,
	testIdPrefix,
}: IconUploadSectionProps) {
	const inputRef = useRef<HTMLInputElement>(null);
	const [preview, setPreview] = useState<Preview | null>(null);
	const [processing, setProcessing] = useState(false);

	const busy = processing || isUploading || isRemoving;

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
			await onUpload(preview.blob);
			clearPreview();
		} catch {
			toast.error('Failed to upload image');
		}
	}

	async function handleRemove() {
		try {
			await onRemove();
		} catch {
			toast.error('Failed to remove image');
		}
	}

	const shownUrl = preview?.url ?? currentIconUrl ?? undefined;

	return (
		<section>
			<h2 className="text-sm font-medium text-text-2 mb-3">{label}</h2>
			<div className="flex flex-col gap-4 sm:flex-row sm:items-center">
				<div data-testid={`${testIdPrefix}-preview`}>
					<Avatar initials={initials} imageUrl={shownUrl} size="lg" />
				</div>
				<div className="flex flex-col gap-2">
					<div className="flex flex-wrap gap-2">
						<input
							ref={inputRef}
							type="file"
							accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
							className="hidden"
							data-testid={`${testIdPrefix}-input`}
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
									data-testid={`${testIdPrefix}-save`}
								>
									{isUploading ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Save image'}
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
									data-testid={`${testIdPrefix}-upload`}
								>
									{processing ? (
										<Loader2 className="w-3 h-3 animate-spin" />
									) : (
										<>
											<ImagePlus className="w-3.5 h-3.5 mr-1.5" />
											{currentIconUrl ? 'Replace image' : 'Upload image'}
										</>
									)}
								</Button>
								{currentIconUrl && (
									<Button
										size="sm"
										variant="destructive"
										onClick={handleRemove}
										disabled={busy}
										data-testid={`${testIdPrefix}-remove`}
									>
										{isRemoving ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Remove'}
									</Button>
								)}
							</>
						)}
					</div>
					<p className="text-xs text-text-3">{helpText}</p>
				</div>
			</div>
		</section>
	);
}
