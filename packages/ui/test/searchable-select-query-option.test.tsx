// A row built from the search text, for a caller that accepts a value its
// options do not hold: a local model runner, whose models the server may not be
// able to list. Options render in a Radix portal: query `document.body`.

import { SearchableSelect, type SearchableSelectOption } from '@hezo/ui';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

const OPTIONS: SearchableSelectOption[] = [{ value: 'llama3.3:70b', label: 'llama3.3:70b' }];

function setup() {
	const onChange = vi.fn();
	render(
		<SearchableSelect
			options={OPTIONS}
			value={null}
			onChange={onChange}
			testId="picker"
			searchPlaceholder="Search models"
			queryOption={(q) => ({ value: q, label: `Use "${q}"` })}
		/>,
	);
	return { onChange, user: userEvent.setup() };
}

test('offers the typed text first, and picking it hands the text to the caller', async () => {
	const { onChange, user } = setup();
	await user.click(screen.getByTestId('picker'));
	await user.type(screen.getByLabelText('Search models'), 'qwen3:32b');

	const rows = screen.getAllByRole('option');
	expect(rows.map((r) => r.textContent)).toEqual(['Use "qwen3:32b"']);
	await user.click(rows[0]);
	expect(onChange).toHaveBeenCalledWith('qwen3:32b');
});

test('offers no typed row for text that is already an option', async () => {
	const { user } = setup();
	await user.click(screen.getByTestId('picker'));
	await user.type(screen.getByLabelText('Search models'), 'llama3.3:70b');

	expect(screen.getAllByRole('option').map((r) => r.textContent)).toEqual(['llama3.3:70b']);
});

test('offers no typed row before anything is typed', async () => {
	const { user } = setup();
	await user.click(screen.getByTestId('picker'));

	expect(screen.getAllByRole('option').map((r) => r.textContent)).toEqual(['llama3.3:70b']);
});
