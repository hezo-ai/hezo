import { MultiSelect, type MultiSelectOption } from '@hezo/ui';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { expect, test, vi } from 'vitest';

// The multi-select, rendered with no provider: picking from a list it is
// handed, filtering that list itself, and searching a list that lives
// somewhere else, with the chosen values shown as tags.

const FRUIT: MultiSelectOption[] = [
	{ value: 'a', label: 'Apple', description: 'Crisp' },
	{ value: 'b', label: 'Banana' },
	{ value: 'c', label: 'Cherry', description: 'Stone fruit' },
];

/** A select that keeps its own selection, the way a caller would. */
function Kept(props: Partial<Parameters<typeof MultiSelect>[0]> & { initial?: string[] }) {
	const { initial = [], ...rest } = props;
	const [value, setValue] = useState<string[]>(initial);
	return <MultiSelect label="Fruit" options={FRUIT} value={value} onChange={setValue} {...rest} />;
}

async function open(user: ReturnType<typeof userEvent.setup>) {
	await user.click(screen.getByRole('button', { name: /^Fruit:/ }));
}

test('names the selection on the trigger, and draws no search box unless asked', async () => {
	const user = userEvent.setup();
	render(<Kept />);

	expect(screen.getByRole('button', { name: 'Fruit: Any' })).toBeTruthy();
	await open(user);
	expect(screen.queryByRole('searchbox')).toBeNull();

	await user.click(await screen.findByRole('menuitemcheckbox', { name: /Apple/ }));
	expect(screen.getByRole('button', { name: 'Fruit: Apple' })).toBeTruthy();
	await user.click(screen.getByRole('menuitemcheckbox', { name: /Banana/ }));
	expect(screen.getByRole('button', { name: 'Fruit: 2 selected' })).toBeTruthy();

	await user.click(screen.getByRole('button', { name: 'Clear selection' }));
	expect(screen.getByRole('button', { name: 'Fruit: Any' })).toBeTruthy();
});

test('draws each option’s second line', async () => {
	const user = userEvent.setup();
	render(<Kept />);

	await open(user);

	expect((await screen.findByRole('menuitemcheckbox', { name: /Cherry/ })).textContent).toContain(
		'Stone fruit',
	);
});

test('filters the options itself, by label and by second line, when it owns the search', async () => {
	const user = userEvent.setup();
	render(<Kept searchable />);

	await open(user);
	await user.type(await screen.findByRole('searchbox', { name: 'Search…' }), 'stone');

	const shown = screen.getAllByRole('menuitemcheckbox').map((item) => item.textContent);
	expect(shown).toEqual(['CherryStone fruit']);

	await user.clear(screen.getByRole('searchbox'));
	await user.type(screen.getByRole('searchbox'), 'zzz');
	expect(screen.getByRole('status').textContent).toBe('No options');
});

// **A list too long to hand over whole is searched where it lives.** The select
// reports the term and draws what the caller found for it, untouched.
test('reports each term and leaves the matching to a caller that searches', async () => {
	const user = userEvent.setup();
	const terms: string[] = [];
	render(<Kept searchable onSearchChange={(term) => terms.push(term)} />);

	await open(user);
	await user.type(await screen.findByRole('searchbox'), 'zz');

	expect(terms).toEqual(['z', 'zz']);
	expect(screen.getAllByRole('menuitemcheckbox')).toHaveLength(FRUIT.length);
});

test('says the options are on their way, why they failed, and what else to know', async () => {
	const user = userEvent.setup();
	const { rerender } = render(
		<MultiSelect
			label="Fruit"
			options={[]}
			value={[]}
			onChange={() => {}}
			searchable
			onSearchChange={() => {}}
			loading
			loadingLabel="Looking…"
		/>,
	);

	await open(user);
	expect((await screen.findByRole('status')).textContent).toBe('Looking…');

	rerender(
		<MultiSelect
			label="Fruit"
			options={FRUIT}
			value={[]}
			onChange={() => {}}
			searchable
			onSearchChange={() => {}}
			errorLabel="The list could not be read."
			hint="More match: keep typing."
		/>,
	);
	expect(await screen.findByText('The list could not be read.')).toBeTruthy();
	expect(screen.getByText('More match: keep typing.')).toBeTruthy();
	expect(screen.queryByRole('status')).toBeNull();
});

// A chosen value a later search no longer returns still has to be named.
test('names a chosen value the options no longer hold, from the labels it was handed', async () => {
	render(
		<MultiSelect
			label="Fruit"
			options={[FRUIT[1] as MultiSelectOption]}
			value={['a']}
			onChange={() => {}}
			selectedOptions={[FRUIT[0] as MultiSelectOption]}
		/>,
	);

	expect(screen.getByRole('button', { name: 'Fruit: Apple' })).toBeTruthy();
});

// As it always has: a value nothing names stays off the trigger.
test('leaves a value nothing names off the trigger', () => {
	render(<MultiSelect label="Fruit" options={FRUIT} value={['gone']} onChange={() => {}} />);

	expect(screen.getByRole('button', { name: 'Fruit: Any' })).toBeTruthy();
});

test('draws each chosen value as a tag that takes it back', async () => {
	const user = userEvent.setup();
	const onChange = vi.fn();
	render(
		<MultiSelect
			label="Fruit"
			options={[FRUIT[1] as MultiSelectOption]}
			value={['a', 'b', 'gone']}
			onChange={onChange}
			selectedOptions={[FRUIT[0] as MultiSelectOption]}
			display="tags"
			removeLabel={(name) => `Drop ${name}`}
		/>,
	);

	const tags = within(screen.getByRole('list', { name: 'Fruit' }));
	expect(tags.getAllByRole('button').map((tag) => tag.getAttribute('aria-label'))).toEqual([
		'Drop Apple',
		'Drop Banana',
		// Nothing names it, so it is shown as itself and can still be taken back.
		'Drop gone',
	]);

	await user.click(tags.getByRole('button', { name: 'Drop Apple' }));
	expect(onChange).toHaveBeenCalledWith(['b', 'gone']);
});

test('draws no tags while nothing is chosen, and none in the summary display', () => {
	const { rerender } = render(
		<MultiSelect label="Fruit" options={FRUIT} value={[]} onChange={() => {}} display="tags" />,
	);
	expect(screen.queryByRole('list')).toBeNull();

	rerender(<MultiSelect label="Fruit" options={FRUIT} value={['a']} onChange={() => {}} />);
	expect(screen.queryByRole('list')).toBeNull();
});

// A term left from the last visit would open the list already narrowed.
test('clears the search when the list closes, and tells a caller that searches', async () => {
	const user = userEvent.setup();
	const terms: string[] = [];
	render(<Kept searchable onSearchChange={(term) => terms.push(term)} />);

	await open(user);
	await user.type(await screen.findByRole('searchbox'), 'ap');
	await user.keyboard('{Escape}');

	expect(terms.at(-1)).toBe('');
	await open(user);
	expect(((await screen.findByRole('searchbox')) as HTMLInputElement).value).toBe('');
});
