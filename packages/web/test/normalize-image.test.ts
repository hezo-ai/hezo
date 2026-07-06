// Unit coverage for src/lib/normalize-image.ts. happy-dom has no real image
// decoder or canvas rasterizer, so the decode surface (createImageBitmap /
// HTMLImageElement) and the canvas 2D surface are stubbed at the exact browser
// API boundary — the tests then assert the module's real transformation
// decisions: center-crop math, the 512px downscale clamp vs. small-image
// passthrough, PNG encoding, the SVG/<img> fallback routing, and each failure
// mode's error.

import { PROJECT_ICON_MAX_DIMENSION } from '@hezo/shared';
import { afterEach, expect, test, vi } from 'vitest';
import { normalizeProjectIcon } from '../src/lib/normalize-image';

interface FakeBitmap {
	width: number;
	height: number;
	close: ReturnType<typeof vi.fn>;
}

function fakeBitmap(width: number, height: number): FakeBitmap {
	return { width, height, close: vi.fn() };
}

interface FakeCanvas {
	width: number;
	height: number;
	getContext: ReturnType<typeof vi.fn>;
	toBlob: ReturnType<typeof vi.fn>;
}

interface FakeCtx {
	imageSmoothingQuality: string;
	drawImage: ReturnType<typeof vi.fn>;
}

/**
 * Route document.createElement('canvas') to a fake with a recordable 2D
 * context; every other tag falls through to happy-dom.
 */
function installCanvas(opts: { ctx?: FakeCtx | null; blob?: Blob | null } = {}): {
	canvas: FakeCanvas;
	ctx: FakeCtx | null;
} {
	const ctx: FakeCtx | null =
		opts.ctx === undefined ? { imageSmoothingQuality: '', drawImage: vi.fn() } : opts.ctx;
	const canvas: FakeCanvas = {
		width: 0,
		height: 0,
		getContext: vi.fn(() => ctx),
		toBlob: vi.fn((cb: (b: Blob | null) => void, type?: string) => {
			if (opts.blob === null) cb(null);
			else cb(opts.blob ?? new Blob(['png-bytes'], { type: type ?? '' }));
		}),
	};
	const original = document.createElement.bind(document);
	vi.spyOn(document, 'createElement').mockImplementation(((tag: string) =>
		tag === 'canvas' ? canvas : original(tag)) as typeof document.createElement);
	return { canvas, ctx };
}

type WindowWithBitmap = { createImageBitmap?: (f: File) => Promise<unknown> };

function installCreateImageBitmap(impl: (f: File) => Promise<unknown>): ReturnType<typeof vi.fn> {
	const fn = vi.fn(impl);
	(window as unknown as WindowWithBitmap).createImageBitmap = fn as unknown as (
		f: File,
	) => Promise<unknown>;
	return fn;
}

type UrlStatics = {
	createObjectURL?: (b: Blob | File) => string;
	revokeObjectURL?: (u: string) => void;
};
const urlStatics = URL as unknown as UrlStatics;
const originalCreateObjectURL = urlStatics.createObjectURL;
const originalRevokeObjectURL = urlStatics.revokeObjectURL;

function installObjectUrl() {
	const create = vi.fn(() => 'blob:test-url');
	const revoke = vi.fn();
	urlStatics.createObjectURL = create;
	urlStatics.revokeObjectURL = revoke;
	return { create, revoke };
}

/** An <img> whose src assignment fires onload (or onerror) on a microtask. */
function installImage(opts: { width?: number; height?: number; fail?: boolean } = {}) {
	class FakeImage {
		onload: (() => void) | null = null;
		onerror: (() => void) | null = null;
		decoding = '';
		width = opts.width ?? 300;
		height = opts.height ?? 150;
		set src(_v: string) {
			queueMicrotask(() => {
				if (opts.fail) this.onerror?.();
				else this.onload?.();
			});
		}
	}
	vi.stubGlobal('Image', FakeImage);
	return FakeImage;
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	delete (window as unknown as WindowWithBitmap).createImageBitmap;
	urlStatics.createObjectURL = originalCreateObjectURL;
	urlStatics.revokeObjectURL = originalRevokeObjectURL;
});

const pngFile = () => new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' });

test('a large landscape image is center-cropped square and downscaled to 512', async () => {
	const bitmap = fakeBitmap(2000, 1000);
	const cib = installCreateImageBitmap(async () => bitmap);
	const { canvas, ctx } = installCanvas();

	const blob = await normalizeProjectIcon(pngFile());

	expect(cib).toHaveBeenCalledTimes(1);
	// Output canvas is clamped to the max dimension.
	expect(canvas.width).toBe(PROJECT_ICON_MAX_DIMENSION);
	expect(canvas.height).toBe(PROJECT_ICON_MAX_DIMENSION);
	// Center crop: srcSize = 1000, sx = (2000-1000)/2 = 500, sy = 0.
	expect(ctx?.drawImage).toHaveBeenCalledWith(
		bitmap,
		500,
		0,
		1000,
		1000,
		0,
		0,
		PROJECT_ICON_MAX_DIMENSION,
		PROJECT_ICON_MAX_DIMENSION,
	);
	expect(ctx?.imageSmoothingQuality).toBe('high');
	// Encoded as PNG and the bitmap is released.
	expect(canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png');
	expect(blob.type).toBe('image/png');
	expect(bitmap.close).toHaveBeenCalledTimes(1);
});

test('a small portrait image keeps its own size (no upscale) with a vertical center crop', async () => {
	const bitmap = fakeBitmap(60, 100);
	installCreateImageBitmap(async () => bitmap);
	const { canvas, ctx } = installCanvas();

	await normalizeProjectIcon(pngFile());

	// srcSize = 60 < 512 → out stays 60; sy = (100-60)/2 = 20.
	expect(canvas.width).toBe(60);
	expect(canvas.height).toBe(60);
	expect(ctx?.drawImage).toHaveBeenCalledWith(bitmap, 0, 20, 60, 60, 0, 0, 60, 60);
});

test('SVG skips createImageBitmap and rasterizes through an <img> + object URL', async () => {
	const cib = installCreateImageBitmap(async () => fakeBitmap(999, 999));
	const { ctx, canvas } = installCanvas();
	const { create, revoke } = installObjectUrl();
	const FakeImage = installImage({ width: 300, height: 150 });

	const svg = new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' });
	await normalizeProjectIcon(svg);

	// The SVG never touches createImageBitmap; it decodes via <img>.
	expect(cib).not.toHaveBeenCalled();
	const drawn = ctx?.drawImage.mock.calls[0]?.[0];
	expect(drawn).toBeInstanceOf(FakeImage);
	// srcSize = 150, sx = 75; no upscale.
	expect(ctx?.drawImage).toHaveBeenCalledWith(drawn, 75, 0, 150, 150, 0, 0, 150, 150);
	expect(canvas.width).toBe(150);
	// Object URL lifecycle: created for the <img>, revoked afterwards.
	expect(create).toHaveBeenCalledTimes(1);
	expect(revoke).toHaveBeenCalledWith('blob:test-url');
});

test('falls back to the <img> path when createImageBitmap rejects the format', async () => {
	const cib = installCreateImageBitmap(async () => {
		throw new Error('unsupported');
	});
	const { ctx } = installCanvas();
	installObjectUrl();
	const FakeImage = installImage({ width: 80, height: 80 });

	await normalizeProjectIcon(pngFile());

	expect(cib).toHaveBeenCalledTimes(1);
	expect(ctx?.drawImage.mock.calls[0]?.[0]).toBeInstanceOf(FakeImage);
});

test('rejects with a decode error when the <img> fallback cannot load the file', async () => {
	installCreateImageBitmap(async () => {
		throw new Error('nope');
	});
	installCanvas();
	const { revoke } = installObjectUrl();
	installImage({ fail: true });

	await expect(normalizeProjectIcon(pngFile())).rejects.toThrow('Could not decode image');
	// The object URL is still released on failure.
	expect(revoke).toHaveBeenCalledWith('blob:test-url');
});

test('rejects a zero-pixel image but still closes the bitmap', async () => {
	const bitmap = fakeBitmap(0, 0);
	installCreateImageBitmap(async () => bitmap);
	installCanvas();

	await expect(normalizeProjectIcon(pngFile())).rejects.toThrow('Image has no pixels');
	expect(bitmap.close).toHaveBeenCalledTimes(1);
});

test('rejects when the canvas 2D context is unavailable', async () => {
	const bitmap = fakeBitmap(100, 100);
	installCreateImageBitmap(async () => bitmap);
	installCanvas({ ctx: null });

	await expect(normalizeProjectIcon(pngFile())).rejects.toThrow('Canvas 2D context unavailable');
	expect(bitmap.close).toHaveBeenCalledTimes(1);
});

test('rejects when PNG encoding produces no blob', async () => {
	installCreateImageBitmap(async () => fakeBitmap(100, 100));
	installCanvas({ blob: null });

	await expect(normalizeProjectIcon(pngFile())).rejects.toThrow('Failed to encode image');
});
