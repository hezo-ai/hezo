import { isArchiveAssetMime, isMarkdownAssetMime } from '@hezo/shared';
import {
	Code,
	FileArchive,
	FileAudio,
	File as FileIcon,
	FileText,
	FileVideo,
	Image as ImageIcon,
} from 'lucide-react';

/**
 * MIME-matched file-type glyph. The single glyph source for every surface that
 * shows an asset: the asset grid, the asset viewer, comment-attachment thumbs
 * and the composer's pending-upload chips (the latter two pass a smaller
 * `className`). Add a type here, not in a local copy.
 */
export function AssetIcon({
	contentType,
	className = 'h-8 w-8 text-text-3',
}: {
	contentType: string;
	className?: string;
}) {
	if (contentType.startsWith('audio/')) return <FileAudio className={className} />;
	if (contentType.startsWith('video/')) return <FileVideo className={className} />;
	if (contentType === 'text/html') return <Code className={className} />;
	if (isArchiveAssetMime(contentType)) return <FileArchive className={className} />;
	if (
		contentType === 'application/pdf' ||
		contentType === 'text/plain' ||
		isMarkdownAssetMime(contentType)
	) {
		return <FileText className={className} />;
	}
	if (contentType.startsWith('image/')) return <ImageIcon className={className} />;
	return <FileIcon className={className} />;
}

export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
