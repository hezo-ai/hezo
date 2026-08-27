import { render } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { RelativeTime } from '../src/components/ui/relative-time';
import { formatDate } from '../src/lib/format-date';

// The absolute-date tooltip content is driven by formatDateTime (covered in
// format-date.test.ts) and rendered through the shared Radix <Tooltip>; its
// hover/tap portal behaviour needs a real layout engine, so the interaction is
// exercised in the Playwright tier, not here in happy-dom.

const NOW = new Date('2026-07-19T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});

afterEach(() => {
	vi.useRealTimers();
});

test('renders a <time> with the relative label and the exact timestamp in dateTime', () => {
	const iso = new Date(NOW.getTime() - 2 * HOUR).toISOString();
	const { container } = render(<RelativeTime iso={iso} />);
	const el = container.querySelector('time');
	expect(el).not.toBeNull();
	expect(el?.textContent).toBe('2 hours ago');
	expect(el?.getAttribute('datetime')).toBe(iso);
});

test('honours the compact variant', () => {
	const iso = new Date(NOW.getTime() - 3 * HOUR).toISOString();
	const { container } = render(<RelativeTime iso={iso} compact />);
	expect(container.querySelector('time')?.textContent).toBe('3h');
});

test('falls back to the absolute date past a week, and stays relative when asked', () => {
	const iso = new Date(NOW.getTime() - 9 * 24 * HOUR).toISOString();
	const { container: dated } = render(<RelativeTime iso={iso} />);
	expect(dated.querySelector('time')?.textContent).toBe(formatDate(iso));
	const { container: relative } = render(<RelativeTime iso={iso} alwaysRelative />);
	expect(relative.querySelector('time')?.textContent).toBe('9 days ago');
});

test('renders nothing for an empty/unparsable timestamp', () => {
	const { container } = render(<RelativeTime iso={null} />);
	expect(container.querySelector('time')).toBeNull();
});
