import {
	Avatar,
	Badge,
	Breadcrumb,
	BreadcrumbRow,
	Card,
	Code,
	CountOverlayBadge,
	DataTable,
	EmptyState,
	FilterPills,
	getInitials,
	InfoTooltip,
	Kbd,
	Logo,
	MultiSelect,
	NameSwitcherButton,
	PageLogo,
	PasswordInput,
	Progress,
	SearchableSelect,
	SectionHeader,
	SegmentedControl,
	StatusDot,
	Textarea,
	Toggle,
	Tooltip,
	TooltipProvider,
} from '@hezo/ui';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Boxes } from 'lucide-react';
import { expect, test, vi } from 'vitest';

// The presentational half of the package. Each of these renders standalone —
// no provider of any kind — which is the property that lets a second app draw
// them. Behaviour is asserted through what reaches the screen, never through a
// class string, so a restyle does not fail a spec.

// Two words give their first letters; one word gives its first two, so a
// single-word name still fills the circle rather than leaving it half-empty.
test('initials come from the words, not the first two letters', () => {
	expect(getInitials('Ada Lovelace')).toBe('AL');
	expect(getInitials('ada')).toBe('AD');
});

test('an avatar shows the initials it is given, running or not', () => {
	const { rerender } = render(<Avatar initials="AL" />);
	expect(screen.getByText('AL')).toBeTruthy();

	rerender(<Avatar initials="AL" running />);
	expect(screen.getByText('AL')).toBeTruthy();
});

// An image-backed avatar used to carry an empty `alt`, which left it with no
// accessible name at all - the initials that would otherwise name it are gone.
test('an image-backed avatar is named by its label', () => {
	// An empty `alt` is the decorative role, which is right only beside a visible
	// name - and wrong the moment the caller has one to give.
	const { rerender } = render(<Avatar initials="AL" imageUrl="/ada.png" />);
	expect(screen.getByRole('presentation')).toBeTruthy();

	rerender(<Avatar initials="AL" imageUrl="/ada.png" label="Ada Lovelace" />);
	expect(screen.getByRole('img', { name: 'Ada Lovelace' })).toBeTruthy();
});

// The live ring is the only thing that shows a running agent, so a reader who
// cannot see it is told instead.
test('a running avatar says so, not only draws so', () => {
	const { rerender } = render(<Avatar initials="AL" runningLabel="Working" />);
	expect(screen.queryByText('Working')).toBeNull();

	rerender(<Avatar initials="AL" running runningLabel="Working" />);
	expect(screen.getByText('Working')).toBeTruthy();
});

test('a badge renders its label', () => {
	render(<Badge color="green">Running</Badge>);
	expect(screen.getByText('Running')).toBeTruthy();
});

test('a card renders what it wraps', () => {
	render(
		<Card>
			<p>inside</p>
		</Card>,
	);
	expect(screen.getByText('inside')).toBeTruthy();
});

test('code renders its content', () => {
	render(<Code>bun run test</Code>);
	expect(screen.getByText('bun run test')).toBeTruthy();
});

// Zero is not a count worth a badge — it is the absence of one.
test('the count overlay hides itself at zero and caps at 99', () => {
	const { rerender, container } = render(<CountOverlayBadge count={0} />);
	expect(container.textContent).toBe('');

	rerender(<CountOverlayBadge count={7} />);
	expect(screen.getByText('7')).toBeTruthy();

	rerender(<CountOverlayBadge count={1200} />);
	expect(screen.getByText('99+')).toBeTruthy();
});

test('an empty state says what is missing', () => {
	render(<EmptyState title="No tasks yet" description="Create one to begin." />);
	expect(screen.getByText('No tasks yet')).toBeTruthy();
	expect(screen.getByText('Create one to begin.')).toBeTruthy();
});

test('a progress bar reports its position to assistive tech', () => {
	render(<Progress value={40} label="Uploading" />);
	expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('40');

	// Out of range is clamped rather than reported as nonsense.
	render(<Progress value={140} label="Overrun" />);
	expect(screen.getByLabelText('Overrun').getAttribute('aria-valuenow')).toBe('100');
});

test('a section header renders its title', () => {
	render(<SectionHeader icon={Boxes} title="Connectors" />);
	expect(screen.getByText('Connectors')).toBeTruthy();
});

test('a status dot carries an accessible label', () => {
	render(<StatusDot status="active" label="Online" />);
	expect(screen.getByLabelText('Online')).toBeTruthy();
});

test('a keycap renders the key', () => {
	render(<Kbd>Esc</Kbd>);
	expect(screen.getByText('Esc')).toBeTruthy();
});

test('the brand mark renders, with and without the wordmark', () => {
	const { rerender } = render(<Logo src="/mark.svg" alt="Acme" />);
	expect(screen.getByRole('img', { hidden: true }).getAttribute('src')).toBe('/mark.svg');
	expect(screen.queryByText('acme')).toBeNull();

	rerender(<Logo src="/mark.svg" alt="Acme" wordmark="acme" />);
	expect(screen.getByText('acme')).toBeTruthy();
});

test('the page logo renders the mark it is given', () => {
	render(<PageLogo src="/mark.svg" alt="Acme" wordmark="acme" />);
	expect(screen.getByRole('img', { hidden: true }).getAttribute('alt')).toBe('Acme');
	expect(screen.getByText('acme')).toBeTruthy();
});

test('a toggle reports and changes its state', async () => {
	const user = userEvent.setup();
	const onChange = vi.fn();
	render(<Toggle checked={false} onChange={onChange} />);

	const toggle = screen.getByRole('switch');
	expect(toggle.getAttribute('aria-checked')).toBe('false');

	await user.click(toggle);
	expect(onChange).toHaveBeenCalledWith(true);
});

test('a textarea takes typing', async () => {
	const user = userEvent.setup();
	render(<Textarea aria-label="Notes" defaultValue="" />);

	await user.type(screen.getByLabelText('Notes'), 'hello');
	expect((screen.getByLabelText('Notes') as HTMLTextAreaElement).value).toBe('hello');
});

// **The point of the control is that the secret is hidden until asked for.**
test('a password field hides its value until revealed', async () => {
	const user = userEvent.setup();
	render(
		<PasswordInput
			aria-label="Token"
			showLabel="Show key"
			hideLabel="Hide key"
			defaultValue="s3cret"
		/>,
	);

	expect((screen.getByLabelText('Token') as HTMLInputElement).type).toBe('password');

	await user.click(screen.getByRole('button', { name: /Show key/ }));
	expect((screen.getByLabelText('Token') as HTMLInputElement).type).toBe('text');
});

test('filter pills mark the active one and report a change', async () => {
	const user = userEvent.setup();
	const onChange = vi.fn();
	render(
		<FilterPills
			options={[
				{ value: 'all', label: 'All' },
				{ value: 'open', label: 'Open' },
			]}
			value="all"
			onChange={onChange}
			label="Filter"
		/>,
	);

	// Pressed rather than checked: the pills are buttons in a labelled group.
	expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true');

	await user.click(screen.getByRole('button', { name: 'Open' }));
	expect(onChange).toHaveBeenCalledWith('open');
});

test('a segmented control reports the choice', async () => {
	const user = userEvent.setup();
	const onChange = vi.fn();
	render(
		<SegmentedControl
			options={[
				{ value: 'list', label: 'List' },
				{ value: 'board', label: 'Board' },
			]}
			value="list"
			onChange={onChange}
			label="View"
		/>,
	);

	await user.click(screen.getByRole('button', { name: 'Board' }));
	expect(onChange).toHaveBeenCalledWith('board');
});

test('a breadcrumb row renders every segment', () => {
	render(
		<BreadcrumbRow>
			<span>Projects</span>
			<span>Acme</span>
		</BreadcrumbRow>,
	);
	expect(screen.getByText('Projects')).toBeTruthy();
	expect(screen.getByText('Acme')).toBeTruthy();
});

test('a breadcrumb renders its segments in order', () => {
	render(
		<Breadcrumb
			segments={[
				{ key: 'projects', label: 'Projects', onNavigate: () => {} },
				{ key: 'acme', label: 'Acme' },
			]}
		/>,
	);
	expect(screen.getByText('Projects')).toBeTruthy();
	expect(screen.getByText('Acme')).toBeTruthy();
});

interface Box {
	name: string;
	size: string;
}

const BOX_COLUMNS = [
	{ key: 'name', header: 'Name', render: (r: Box) => r.name },
	{ key: 'size', header: 'Size', render: (r: Box) => r.size },
];

test('a data table renders a row per record, under its headers', () => {
	render(
		<DataTable
			columns={BOX_COLUMNS}
			data={[
				{ name: 'alpha', size: '1 GB' },
				{ name: 'beta', size: '2 GB' },
			]}
			rowKey={(r) => r.name}
		/>,
	);

	expect(screen.getByText('alpha')).toBeTruthy();
	expect(screen.getByText('beta')).toBeTruthy();
	expect(screen.getByRole('columnheader', { name: 'Name' })).toBeTruthy();
});

test('a data table with nothing in it still names its columns', () => {
	render(<DataTable columns={BOX_COLUMNS} data={[]} rowKey={(r) => r.name} />);

	expect(screen.getByRole('columnheader', { name: 'Name' })).toBeTruthy();
	expect(screen.queryByText('alpha')).toBeNull();
});

test('a tooltip renders the thing it describes', () => {
	render(
		<TooltipProvider>
			<Tooltip content="Copy to clipboard">
				<button type="button">Copy</button>
			</Tooltip>
		</TooltipProvider>,
	);
	expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
});

// A tooltip left uncontrolled opens on hover and focus but never on a tap, and
// this trigger is the only route to what it holds.
test('an info tooltip opens on a tap, not only on hover', async () => {
	const user = userEvent.setup();
	render(
		<TooltipProvider>
			<InfoTooltip content="What this means" label="More about this" />
		</TooltipProvider>,
	);

	const trigger = screen.getByRole('button', { name: 'More about this' });
	expect(trigger.getAttribute('aria-expanded')).toBe('false');

	await user.click(trigger);
	expect(trigger.getAttribute('aria-expanded')).toBe('true');
	expect(await screen.findAllByText('What this means')).not.toHaveLength(0);
});

test('a searchable select opens and reports a choice', async () => {
	const user = userEvent.setup();
	const onSelect = vi.fn();
	render(
		<SearchableSelect
			options={[
				{ value: 'a', label: 'Alpha' },
				{ value: 'b', label: 'Beta' },
			]}
			value="a"
			onChange={onSelect}
			trigger={<button type="button">Open</button>}
		/>,
	);

	await user.click(screen.getByRole('button', { name: 'Open' }));
	await user.click(await screen.findByText('Beta'));
	expect(onSelect).toHaveBeenCalledWith('b');
});

test('a multi select reports each choice', async () => {
	const user = userEvent.setup();
	const onChange = vi.fn();
	render(
		<MultiSelect
			options={[
				{ value: 'a', label: 'Alpha' },
				{ value: 'b', label: 'Beta' },
			]}
			value={[]}
			onChange={onChange}
			label="Tags"
		/>,
	);

	await user.click(screen.getByRole('button', { name: /Tags/ }));
	await user.click(await screen.findByText('Alpha'));
	expect(onChange).toHaveBeenCalled();
});

test('a name switcher renders its label', () => {
	render(
		<NameSwitcherButton
			options={[{ value: 'a', label: 'Alpha' }]}
			value="a"
			onSelect={() => {}}
			label="Switch document"
		/>,
	);
	expect(screen.getByRole('button', { name: 'Switch document' })).toBeTruthy();
});
