import { render } from '@testing-library/react';
import { expect, test } from 'vitest';
import { ExpandableText } from '../src/components/ui/expandable-text';

// Component tier (happy-dom). ExpandableText is a pure component (no router /
// query). Covers the non-layout branches: empty/whitespace text → placeholder
// branch (with the className applied to the placeholder wrapper) and the
// text-present branch rendering the paragraph. The overflow/expand toggle
// depends on real line-clamp layout (scrollHeight vs clientHeight) which
// happy-dom can't measure — that branch is intentionally left to Playwright.

test('renders the placeholder when text is empty', () => {
	const { getByText, container } = render(
		<ExpandableText text="" placeholder={<span>Nothing yet…</span>} className="my-wrap" />,
	);

	expect(getByText('Nothing yet…')).toBeTruthy();
	// The placeholder branch returns a div carrying the passed className.
	expect((container.firstElementChild as HTMLElement).className).toContain('my-wrap');
	// No paragraph (the text branch) and no toggle button render.
	expect(container.querySelector('p')).toBeNull();
	expect(container.querySelector('button')).toBeNull();
});

test('treats whitespace-only text as empty (placeholder branch)', () => {
	const { getByText, container } = render(
		<ExpandableText text={'   \n  '} placeholder={<span>Empty</span>} />,
	);

	expect(getByText('Empty')).toBeTruthy();
	expect(container.querySelector('p')).toBeNull();
});

test('renders the text in a paragraph when present, collapsed by default with no toggle (no overflow in happy-dom)', () => {
	const { getByText, container } = render(<ExpandableText text="A short summary line." />);

	const p = container.querySelector('p') as HTMLParagraphElement;
	expect(p).toBeTruthy();
	expect(getByText('A short summary line.')).toBeTruthy();
	// Collapsed state applies the line-clamp class.
	expect(p.className).toContain('line-clamp-1');
	// happy-dom reports no overflow → the toggle button is not shown.
	expect(container.querySelector('button')).toBeNull();
});
