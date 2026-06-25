import { afterEach, expect, test, vi } from 'vitest';
import { copyToClipboard } from '../src/lib/clipboard';

const originalClipboard = navigator.clipboard;
const originalExecCommand = document.execCommand;

afterEach(() => {
	Object.defineProperty(navigator, 'clipboard', {
		value: originalClipboard,
		configurable: true,
	});
	document.execCommand = originalExecCommand;
	vi.restoreAllMocks();
});

function setClipboard(value: unknown) {
	Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
}

test('uses the async Clipboard API when available', async () => {
	const writeText = vi.fn().mockResolvedValue(undefined);
	setClipboard({ writeText });

	expect(await copyToClipboard('secret words')).toBe(true);
	expect(writeText).toHaveBeenCalledWith('secret words');
});

test('falls back to execCommand in an insecure context', async () => {
	setClipboard(undefined);
	const execCommand = vi.fn().mockReturnValue(true);
	document.execCommand = execCommand;

	expect(await copyToClipboard('fallback words')).toBe(true);
	expect(execCommand).toHaveBeenCalledWith('copy');
	expect(document.querySelector('textarea')).toBeNull();
});

test('falls back to execCommand when the async API rejects', async () => {
	setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) });
	const execCommand = vi.fn().mockReturnValue(true);
	document.execCommand = execCommand;

	expect(await copyToClipboard('words')).toBe(true);
	expect(execCommand).toHaveBeenCalledWith('copy');
});

test('returns false when every copy path fails', async () => {
	setClipboard(undefined);
	document.execCommand = vi.fn().mockReturnValue(false);

	expect(await copyToClipboard('words')).toBe(false);
	expect(document.querySelector('textarea')).toBeNull();
});
