// A cost nobody was billed for must never render as money someone was charged.
//
// Every dense surface that prints a run or task cost reads it through these two
// components, so this is where the rule is pinned: the tag is present exactly
// when the figure is imputed, and both go through the locale's money formatter
// rather than a hand-rolled divide-by-100. Render-driven (no layout, viewport or
// socket), so it sits in the component tier.

import { DEFAULT_LOCALE_SETTINGS, Language, NumberFormat } from '@hezo/shared';
import { TooltipProvider } from '@hezo/ui';
import { render } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { CostFigure, NotionalFigure } from '../src/components/cost-figures';
import { I18nProvider } from '../src/lib/i18n';

/** The provider seeds itself from the stored render hint, so set that. */
function renderIn(locale: Partial<typeof DEFAULT_LOCALE_SETTINGS>, node: React.ReactNode) {
	localStorage.setItem('locale', JSON.stringify({ ...DEFAULT_LOCALE_SETTINGS, ...locale }));
	return render(
		<I18nProvider>
			<TooltipProvider>{node}</TooltipProvider>
		</I18nProvider>,
	);
}

beforeEach(() => localStorage.clear());

test('a billed cost is the amount and nothing else', () => {
	const { container } = renderIn({}, <CostFigure cents={250} billed />);
	expect(container.textContent).toBe('$2.50');
});

test('an unbilled cost carries the tag beside the amount', () => {
	const { container } = renderIn({}, <CostFigure cents={250} billed={false} />);
	expect(container.textContent).toBe('$2.50 not billed');
});

test('a partial snapshot keeps its "~", billed or not', () => {
	const billed = renderIn({}, <CostFigure cents={250} billed approximate />);
	expect(billed.container.textContent).toBe('~$2.50');
	billed.unmount();

	const notional = renderIn({}, <CostFigure cents={250} billed={false} approximate />);
	expect(notional.container.textContent).toBe('~$2.50 not billed');
});

test('a notional total reads as an amount nobody was charged', () => {
	const { container } = renderIn({}, <NotionalFigure cents={412030} />);
	expect(container.textContent).toBe('$4,120.30 not billed');
});

test('the figure follows the locale money format, not a hand-rolled divide', () => {
	const { container } = renderIn(
		{ language: Language.De, number_format: NumberFormat.CommaDot },
		<CostFigure cents={412030} billed={false} />,
	);
	// A `(cents / 100).toFixed(2)` renders "4120.30" whatever the operator picked;
	// only the formatter gives them the separators they chose.
	expect(container.textContent).toContain('4.120,30');
	expect(container.textContent).toContain('nicht abgerechnet');
});
