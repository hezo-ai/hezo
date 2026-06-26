import { PROJECT_ICON_MAX_DIMENSION } from '@hezo/shared';

/**
 * Normalize a user-picked image file into a square PNG no larger than
 * `PROJECT_ICON_MAX_DIMENSION` per side, center-cropped to a square. Handles
 * raster formats and SVG (rasterized via the browser); animated GIFs collapse
 * to their first frame. Returns a PNG `Blob` ready to upload.
 *
 * Throws if the file can't be decoded as an image.
 */
export async function normalizeProjectIcon(file: File): Promise<Blob> {
	const bitmap = await loadImage(file);
	try {
		const srcSize = Math.min(bitmap.width, bitmap.height);
		if (srcSize <= 0) throw new Error('Image has no pixels');
		const sx = (bitmap.width - srcSize) / 2;
		const sy = (bitmap.height - srcSize) / 2;
		const outSize = Math.min(srcSize, PROJECT_ICON_MAX_DIMENSION);

		const canvas = document.createElement('canvas');
		canvas.width = outSize;
		canvas.height = outSize;
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('Canvas 2D context unavailable');
		ctx.imageSmoothingQuality = 'high';
		ctx.drawImage(bitmap, sx, sy, srcSize, srcSize, 0, 0, outSize, outSize);

		return await new Promise<Blob>((resolve, reject) => {
			canvas.toBlob(
				(blob) => (blob ? resolve(blob) : reject(new Error('Failed to encode image'))),
				'image/png',
			);
		});
	} finally {
		if ('close' in bitmap && typeof bitmap.close === 'function') bitmap.close();
	}
}

/** Decode a file into a drawable bitmap, falling back to an <img> for SVG. */
async function loadImage(file: File): Promise<ImageBitmap | HTMLImageElement> {
	// SVG must go through an <img> element so the browser rasterizes it; some
	// browsers reject SVG in createImageBitmap.
	if (file.type !== 'image/svg+xml' && 'createImageBitmap' in window) {
		try {
			return await createImageBitmap(file);
		} catch {
			// Fall through to the <img> path for formats createImageBitmap can't decode.
		}
	}
	const url = URL.createObjectURL(file);
	try {
		const img = new Image();
		img.decoding = 'async';
		await new Promise<void>((resolve, reject) => {
			img.onload = () => resolve();
			img.onerror = () => reject(new Error('Could not decode image'));
			img.src = url;
		});
		return img;
	} finally {
		URL.revokeObjectURL(url);
	}
}
