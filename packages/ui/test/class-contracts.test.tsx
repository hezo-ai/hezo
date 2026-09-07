import {
	BackLink,
	Button,
	buttonClassName,
	Callout,
	Card,
	ConfirmDialog,
	DataTable,
	DialogContent,
	FilterPills,
	HelpDialog,
	hitAreaClassName,
	InfoTooltip,
	InPlaceForm,
	Input,
	inputSizeClassName,
	MultiSelect,
	NameSwitcherButton,
	PasswordInput,
	SearchableSelect,
	SegmentedControl,
	Textarea,
	ThemeProvider,
	ThemeSwitcher,
	Toggle,
	TooltipProvider,
	toneDotClassName,
	toneSolidClassName,
	toneTintClassName,
	touchCellHeightClassName,
	touchMinHeightClassName,
} from '@hezo/ui';
import * as Dialog from '@radix-ui/react-dialog';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { expect, test } from 'vitest';

// The one file in this tier that reads class strings, and why. happy-dom lays
// nothing out and evaluates no `in-data-*` variant, so a 44px target has no
// screen-observable form here: the class string IS the contract a second
// consumer reads, the way `standalone.test.tsx` treats `dialogOverlayClassName`.
// Geometry is proven once, in the browser (`test/browser/touch-density`).
//
// Two things are deliberately outside the contract: the `link` button variant
// and the breadcrumb's segments are inline text, and a 44px box would break
// the line they sit in.

const HIT = hitAreaClassName;
const FLOOR = touchMinHeightClassName;

test('the hit area positions nothing, and the touch floor leaks into no other density', () => {
	const hit = hitAreaClassName.split(' ');
	expect(hit.every((c) => c.startsWith('after:'))).toBe(true);
	expect(hit).not.toContain('relative');
	expect(hit).not.toContain('absolute');
	for (const floor of [touchMinHeightClassName, touchCellHeightClassName]) {
		expect(floor.split(' ').every((c) => c.startsWith('in-data-[density=touch]:'))).toBe(true);
	}
});

// Each control renders alone: an open dialog hides everything beside it from
// the accessibility tree, so the switch next to one is not queryable.
const isolatedControls: { name: string; ui: ReactNode; take: () => HTMLElement }[] = [
	{
		name: 'toggle',
		ui: <Toggle checked={false} onChange={() => {}} label="Notify" />,
		take: () => screen.getByRole('switch', { name: 'Notify' }),
	},
	{
		name: 'dialog close',
		ui: (
			<Dialog.Root open>
				<DialogContent>
					<Dialog.Title>Settings</Dialog.Title>
				</DialogContent>
			</Dialog.Root>
		),
		take: () => screen.getByTestId('dialog-close'),
	},
	{
		name: 'confirm close',
		ui: (
			<ConfirmDialog
				open
				onOpenChange={() => {}}
				title="Delete?"
				description="Gone for good."
				onConfirm={() => {}}
			/>
		),
		take: () => screen.getByTestId('confirm-dialog-close'),
	},
	{
		name: 'in-place form close',
		ui: (
			<InPlaceForm title="Add" onClose={() => {}}>
				<p>fields</p>
			</InPlaceForm>
		),
		take: () => screen.getByTestId('in-place-form-close'),
	},
	{
		name: 'theme trigger',
		ui: (
			<ThemeProvider storageKey="contract-theme">
				<ThemeSwitcher label="Theme" />
			</ThemeProvider>
		),
		take: () => screen.getByRole('button', { name: 'Theme' }),
	},
	{
		name: 'back link',
		ui: <BackLink onClick={() => {}} label="Back" />,
		take: () => screen.getByRole('button', { name: 'Back' }),
	},
	{
		name: 'password reveal',
		ui: <PasswordInput aria-label="Password" />,
		take: () => screen.getByRole('button', { name: 'Show password' }),
	},
	{
		name: 'help trigger',
		ui: (
			<HelpDialog title="Pricing" triggerLabel="Help">
				<p>How pricing works.</p>
			</HelpDialog>
		),
		take: () => screen.getByRole('button', { name: 'Help' }),
	},
	{
		name: 'info trigger',
		ui: (
			<TooltipProvider>
				<InfoTooltip content="What this means" label="More" />
			</TooltipProvider>
		),
		take: () => screen.getByRole('button', { name: 'More' }),
	},
	{
		name: 'name switcher',
		ui: (
			<NameSwitcherButton
				options={[{ value: 'a', label: 'Alpha' }]}
				value="a"
				onSelect={() => {}}
				label="Switch"
			/>
		),
		take: () => screen.getByRole('button', { name: 'Switch' }),
	},
];

test('every isolated control carries the shared hit area', () => {
	for (const { name, ui, take } of isolatedControls) {
		render(ui);
		const el = take();
		expect(el.className, name).toContain(HIT);
		// The pseudo-element is positioned against its host, so every host is
		// positioned itself - the constant carries no positioning of its own.
		expect(
			el.className.includes('relative') || el.className.includes('absolute'),
			`${name} is positioned`,
		).toBe(true);
		cleanup();
	}
});

test('the theme menu rows stack, so they take the floor rather than the area', async () => {
	const user = userEvent.setup();
	render(
		<ThemeProvider storageKey="contract-theme">
			<ThemeSwitcher label="Theme" />
		</ThemeProvider>,
	);
	await user.click(screen.getByRole('button', { name: 'Theme' }));
	const items = await screen.findAllByRole('menuitemradio');
	expect(items.length).toBeGreaterThan(0);
	for (const item of items) {
		expect(item.className).toContain(FLOOR);
		expect(item.className).not.toContain(HIT);
	}
});

const BOX_COLUMNS = [
	{ key: 'name', header: 'Name', sortKey: 'name', render: (r: { name: string }) => r.name },
];
const ROWS = [{ name: 'alpha' }, { name: 'beta' }];

test('every stacked control takes the touch floor', async () => {
	const user = userEvent.setup();
	render(
		<>
			<Button size="sm">Small</Button>
			<Button size="md">Medium</Button>
			<Button size="lg">Large</Button>
			<Input label="Name" />
			<PasswordInput aria-label="Password" />
			<SegmentedControl
				label="View"
				value="list"
				onChange={() => {}}
				options={[
					{ value: 'list', label: 'List' },
					{ value: 'board', label: 'Board' },
				]}
			/>
			<FilterPills
				label="Status"
				value="all"
				onChange={() => {}}
				options={[
					{ value: 'all', label: 'All' },
					{ value: 'open', label: 'Open' },
				]}
			/>
			<MultiSelect
				label="Status"
				options={[{ value: 'open', label: 'Open' }]}
				value={['open']}
				onChange={() => {}}
				testId="multi"
			/>
			<SearchableSelect
				options={[{ value: 'a', label: 'Alpha' }]}
				value={null}
				onChange={() => {}}
				testId="single"
			/>
			<DataTable
				columns={BOX_COLUMNS}
				data={ROWS}
				rowKey={(r) => r.name}
				onRowClick={() => {}}
				sort={{ key: 'name', direction: 'asc', onSort: () => {}, label: (h) => `Sort by ${h}` }}
			/>
		</>,
	);

	for (const name of ['Small', 'Medium', 'Large']) {
		expect(screen.getByRole('button', { name }).className).toContain(FLOOR);
	}
	expect(buttonClassName({ size: 'sm' })).toContain(FLOOR);
	// The floor sits on the box a reader sees, not the bare field inside it.
	expect(screen.getByLabelText('Name').parentElement?.className).toContain(FLOOR);
	expect(screen.getByLabelText('Password').className).toContain(FLOOR);
	for (const name of ['List', 'Board', 'All', 'Open']) {
		expect(screen.getByRole('button', { name }).className).toContain(FLOOR);
	}
	expect(screen.getByRole('button', { name: 'Sort by Name' }).className).toContain(FLOOR);
	// A clickable row's floor rides its cells: a `<tr>` cannot carry it.
	for (const cell of screen.getAllByRole('cell')) {
		expect(cell.className).toContain(touchCellHeightClassName);
	}

	expect(screen.getByTestId('multi').className).toContain(FLOOR);
	await user.click(screen.getByTestId('multi'));
	for (const item of await screen.findAllByRole('menuitemcheckbox')) {
		expect(item.className).toContain(FLOOR);
	}
	expect(screen.getByRole('button', { name: 'Clear selection' }).className).toContain(FLOOR);
	await user.keyboard('{Escape}');

	expect(screen.getByTestId('single').className).toContain(FLOOR);
	await user.click(screen.getByTestId('single'));
	expect((await screen.findByTestId('single-search')).className).toContain(FLOOR);
	for (const option of screen.getAllByRole('option')) {
		expect(option.className).toContain(FLOOR);
	}
});

test('a table that is not clickable and a link-styled button stay as they are', () => {
	render(<DataTable columns={BOX_COLUMNS} data={ROWS} rowKey={(r) => r.name} />);
	for (const cell of screen.getAllByRole('cell')) {
		expect(cell.className).not.toContain(touchCellHeightClassName);
	}
	expect(buttonClassName({ variant: 'link' })).not.toContain(FLOOR);
});

test("a field's presets mirror the button's, and md is the box it always was", () => {
	expect(inputSizeClassName.md).toContain('h-8');
	const { rerender } = render(<Input label="Name" />);
	const box = () => screen.getByLabelText('Name').parentElement?.className ?? '';
	expect(box()).toContain('h-8');

	rerender(<Input label="Name" size="sm" />);
	expect(box()).toContain('h-[26px]');
	rerender(<Input label="Name" size="lg" />);
	expect(box()).toContain('h-[38px]');

	rerender(<Textarea label="Notes" size="sm" />);
	expect(screen.getByLabelText('Notes').className).toContain('min-h-[56px]');
	rerender(<Textarea label="Notes" />);
	expect(screen.getByLabelText('Notes').className).toContain('min-h-[72px]');
});

// **The tone tables are a contract a second consumer reads**, which is why they
// are asserted here rather than through the screen: a consumer composing its own
// shape from these pairs is the alternative to restating them, and a tone that
// went missing from one table would fail only in that consumer's repo.
test('every tone is drawn by every table, and none reads a raw custom property', () => {
	const tones = Object.keys(toneTintClassName);
	expect(tones.length).toBeGreaterThan(0);

	for (const table of [toneTintClassName, toneSolidClassName, toneDotClassName]) {
		expect(Object.keys(table).sort()).toEqual([...tones].sort());
		for (const classes of Object.values(table)) {
			expect(classes).not.toContain('var(--');
			expect(classes.trim()).not.toBe('');
		}
	}
});

// The pill and the paragraph take their colour from the same row, so a restyle
// of one cannot silently leave the other behind.
test('a callout is painted from the same tint the badge uses', () => {
	render(<Callout tone="warning">Reconnecting.</Callout>);

	expect(screen.getByRole('status').className).toContain(toneTintClassName.warning);
});

test('a card highlights only when it is interactive', () => {
	const hover = 'hover:border-border-strong';
	const { rerender } = render(<Card data-testid="card">inside</Card>);
	expect(screen.getByTestId('card').className).not.toContain(hover);

	rerender(
		<Card data-testid="card" onClick={() => {}}>
			inside
		</Card>,
	);
	expect(screen.getByTestId('card').className).toContain(hover);

	rerender(
		<Card data-testid="card" interactive>
			inside
		</Card>,
	);
	expect(screen.getByTestId('card').className).toContain(hover);

	rerender(
		<Card data-testid="card" onClick={() => {}} interactive={false}>
			inside
		</Card>,
	);
	expect(screen.getByTestId('card').className).not.toContain(hover);
});
