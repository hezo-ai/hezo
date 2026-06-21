import { Progress } from '@hezo/web/components/ui/progress';
import { render } from '@testing-library/react';
import { expect, test } from 'vitest';

test('Progress exposes a clamped progressbar value and sets the fill width', () => {
	const { getByRole, rerender } = render(<Progress value={42} label="Build progress" />);
	const bar = getByRole('progressbar');
	expect(bar.getAttribute('aria-valuenow')).toBe('42');
	expect(bar.getAttribute('aria-label')).toBe('Build progress');
	const fill = bar.firstElementChild as HTMLElement;
	expect(fill.style.width).toBe('42%');

	rerender(<Progress value={150} label="Build progress" />);
	expect(getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');

	rerender(<Progress value={-5} label="Build progress" />);
	expect(getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0');
});
