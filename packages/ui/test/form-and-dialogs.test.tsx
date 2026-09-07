import {
	Button,
	type Column,
	ConfirmDialog,
	DataTable,
	DialogContent,
	HelpDialog,
	Input,
	isMacPlatform,
	Kbd,
	segmentedLabelsFit,
	Textarea,
	Toggle,
} from '@hezo/ui';
import * as Dialog from '@radix-ui/react-dialog';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { expect, test, vi } from 'vitest';

/**
 * The surfaces the package shipped without a spec: the button's element type,
 * the text field, the two dialogs' own controls, and the confirmation's failure
 * and double-fire paths. Each renders with no provider of any kind.
 */

test('a button does not submit the form it sits in unless asked to', () => {
	const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
	render(
		<form onSubmit={onSubmit}>
			<Button>Add another</Button>
			<Button type="submit">Save</Button>
		</form>,
	);

	// The default is `button`: an action rendered beside a field is not the form's
	// submit control, and defaulting the other way makes every one of them one.
	fireEvent.click(screen.getByRole('button', { name: 'Add another' }));
	expect(onSubmit).not.toHaveBeenCalled();

	// A caller's own `type` still wins over the default.
	fireEvent.click(screen.getByRole('button', { name: 'Save' }));
	expect(onSubmit).toHaveBeenCalledTimes(1);
});

test('a field is tied to its label by a generated id, not by the label text', () => {
	render(
		<>
			<Input label="Name" />
			<Input label="Name" />
		</>,
	);

	const fields = screen.getAllByLabelText('Name');
	expect(fields).toHaveLength(2);
	// Two fields labelled the same used to emit one id between them, so both
	// labels pointed at the first field and clicking either focused it.
	expect(fields[0].id).not.toBe(fields[1].id);
	expect(fields[0].id).toBeTruthy();
});

// `size` is the height preset, never the native character count - a preset
// that reached the element as `size="lg"` would be an invalid attribute.
test("a field's size is a preset, never the native character count", async () => {
	const user = userEvent.setup();
	render(
		<>
			<Input label="Name" size="lg" />
			<Textarea label="Notes" size="sm" />
		</>,
	);
	expect(screen.getByLabelText('Name').getAttribute('size')).toBeNull();

	await user.type(screen.getByLabelText('Notes'), 'hello');
	expect((screen.getByLabelText('Notes') as HTMLTextAreaElement).value).toBe('hello');
});

test('a field keeps an id it is given', () => {
	render(<Input label="Token" id="provider-token" />);
	expect((screen.getByLabelText('Token') as HTMLInputElement).id).toBe('provider-token');
});

// A unit, a currency or a fixed domain belongs inside the border box: outside it
// the suffix sits beyond the focus ring and does not move with the size preset.
test('a field can end in fixed content, inside the same box as the input', () => {
	render(<Input label="Subdomain" suffix=".app.hezo.ai" defaultValue="acme" />);

	const field = screen.getByLabelText('Subdomain');
	const suffix = screen.getByText('.app.hezo.ai');
	expect(field.parentElement).toBe(suffix.parentElement);
});

// `InputHTMLAttributes` carries no `ref`, so a caller wanting to focus the field
// was refused by TypeScript for something React already passed through. It has
// to land on the `<input>`, not on either wrapper.
test('a field forwards its ref to the input itself', () => {
	function Harness() {
		const ref = useRef<HTMLInputElement>(null);
		return (
			<>
				<Input label="Name" ref={ref} />
				<button type="button" onClick={() => ref.current?.focus()}>
					Focus
				</button>
			</>
		);
	}
	render(<Harness />);

	fireEvent.click(screen.getByRole('button', { name: 'Focus' }));
	expect(document.activeElement).toBe(screen.getByLabelText('Name'));
});

test('a keycap renders what it is given', () => {
	render(<Kbd>⌘K</Kbd>);
	expect(screen.getByText('⌘K')).toBeTruthy();
});

test('a switch can be named, and reports its state', async () => {
	const user = userEvent.setup();
	const onChange = vi.fn();
	render(<Toggle checked={false} onChange={onChange} label="Email notifications" />);

	// Without a name a switch is announced as "switch, on" with no subject.
	const toggle = screen.getByRole('switch', { name: 'Email notifications' });
	expect(toggle.getAttribute('aria-checked')).toBe('false');

	await user.click(toggle);
	expect(onChange).toHaveBeenCalledWith(true);
});

test('a dialog renders its close button and corner actions, and can drop the close', () => {
	const { rerender } = render(
		<Dialog.Root open>
			<DialogContent cornerActions={<button type="button">Expand</button>}>
				<Dialog.Title>Settings</Dialog.Title>
			</DialogContent>
		</Dialog.Root>,
	);
	expect(screen.getByTestId('dialog-close')).toBeTruthy();
	expect(screen.getByRole('button', { name: 'Expand' })).toBeTruthy();

	rerender(
		<Dialog.Root open>
			<DialogContent showClose={false}>
				<Dialog.Title>Settings</Dialog.Title>
			</DialogContent>
		</Dialog.Root>,
	);
	expect(screen.queryByTestId('dialog-close')).toBeNull();
});

test('the help dialog opens and closes from its own controls', async () => {
	const user = userEvent.setup();
	render(
		<HelpDialog title="Pricing" triggerLabel="Help">
			<p>How pricing works.</p>
		</HelpDialog>,
	);

	await user.click(screen.getByRole('button', { name: 'Help' }));
	expect(await screen.findByText('How pricing works.')).toBeTruthy();

	await user.click(screen.getByTestId('dialog-close'));
	expect(screen.queryByText('How pricing works.')).toBeNull();
});

test('a confirmation that fails stays open and says so', async () => {
	const user = userEvent.setup();
	const onError = vi.fn();
	const onOpenChange = vi.fn();
	const onConfirm = vi.fn().mockRejectedValue(new Error('upstream refused'));

	render(
		<ConfirmDialog
			open
			onOpenChange={onOpenChange}
			title="Delete project?"
			description="The project and its tasks are removed."
			onConfirm={onConfirm}
			onError={onError}
			errorLabel={(err) => `Could not delete: ${(err as Error).message}`}
		/>,
	);

	await user.click(screen.getByTestId('confirm-dialog-confirm'));

	// A rejection used to escape as an unhandled one: the dialog stayed open, the
	// button re-enabled, and nothing reached the reader.
	expect(await screen.findByRole('alert')).toHaveProperty(
		'textContent',
		'Could not delete: upstream refused',
	);
	expect(onError).toHaveBeenCalledTimes(1);
	expect(onOpenChange).not.toHaveBeenCalled();
	expect((screen.getByTestId('confirm-dialog-confirm') as HTMLButtonElement).disabled).toBe(false);
});

test('a confirmation given loading=false still fires only once', async () => {
	const onConfirm = vi.fn().mockImplementation(() => new Promise(() => {}));

	// Every caller wiring `loading={mutation.isPending}` passes false until the
	// request starts, and coalescing pinned the guard off for exactly that window.
	function Harness() {
		const [pending] = useState(false);
		return (
			<ConfirmDialog
				open
				onOpenChange={() => {}}
				title="Delete project?"
				description="The project and its tasks are removed."
				onConfirm={onConfirm}
				loading={pending}
			/>
		);
	}
	render(<Harness />);

	const confirm = screen.getByTestId('confirm-dialog-confirm');
	await act(async () => {
		fireEvent.click(confirm);
	});
	fireEvent.click(confirm);

	expect(onConfirm).toHaveBeenCalledTimes(1);
});

// **Withheld, not refused.** The confirmation's own precondition - a typed name,
// a required field - had nowhere to put its answer, so a caller could render the
// field and not stop the button. `loading` is the wrong lever: it draws a
// spinner over work that is not happening.
test('a confirmation can withhold its action without claiming to be busy', () => {
	const onConfirm = vi.fn();
	render(
		<ConfirmDialog
			open
			onOpenChange={() => {}}
			title="Delete instance?"
			description="Type the instance name to continue."
			onConfirm={onConfirm}
			confirmDisabled
		/>,
	);

	const confirm = screen.getByTestId('confirm-dialog-confirm') as HTMLButtonElement;
	expect(confirm.disabled).toBe(true);
	fireEvent.click(confirm);
	expect(onConfirm).not.toHaveBeenCalled();

	// The way out stays open: a withheld confirm must not trap the reader.
	expect((screen.getByTestId('confirm-dialog-close') as HTMLButtonElement).disabled).toBe(false);
	expect((screen.getByRole('button', { name: /Cancel/ }) as HTMLButtonElement).disabled).toBe(
		false,
	);
});

// The binding clicks the action through its ref, so a `disabled` button already
// swallows it - but the binding is gated too, so it never claims the key from
// whatever is underneath while the action is withheld.
test('the confirm shortcut is withheld with the button', async () => {
	const mac = isMacPlatform();
	const onConfirm = vi.fn();
	const { rerender } = render(
		<ConfirmDialog
			open
			onOpenChange={() => {}}
			title="Delete instance?"
			description="Type the instance name to continue."
			onConfirm={onConfirm}
			confirmDisabled
		/>,
	);

	fireEvent.keyDown(document.body, { key: 'Enter', metaKey: mac, ctrlKey: !mac });
	expect(onConfirm).not.toHaveBeenCalled();

	rerender(
		<ConfirmDialog
			open
			onOpenChange={() => {}}
			title="Delete instance?"
			description="Type the instance name to continue."
			onConfirm={onConfirm}
		/>,
	);
	// The enabled path runs `handleConfirm`, which sets state: awaited so the
	// commit lands inside the test rather than after it.
	await act(async () => {
		fireEvent.keyDown(document.body, { key: 'Enter', metaKey: mac, ctrlKey: !mac });
	});
	expect(onConfirm).toHaveBeenCalledTimes(1);
});

test('a clickable row is reachable by key, and is still a row', async () => {
	const user = userEvent.setup();
	const onRowClick = vi.fn();
	const columns: Column<{ id: string; name: string }>[] = [
		{ key: 'name', header: 'Name', render: (r) => r.name },
	];
	render(
		<DataTable
			columns={columns}
			data={[{ id: '1', name: 'alpha' }]}
			rowKey={(r) => r.id}
			onRowClick={onRowClick}
		/>,
	);

	// The row is the table's whole interaction, so leaving it mouse-only put the
	// only action out of reach of a keyboard.
	const row = screen.getByRole('row', { name: /alpha/ });
	expect(row.getAttribute('tabindex')).toBe('0');

	row.focus();
	await user.keyboard('{Enter}');
	expect(onRowClick).toHaveBeenCalledTimes(1);

	await user.keyboard(' ');
	expect(onRowClick).toHaveBeenCalledTimes(2);
});

test('an unmeasurable width shows the labels rather than hiding them', () => {
	// Labels are the richer state, so an unknown falls back to showing them.
	expect(segmentedLabelsFit(0, 0)).toBe(true);
	expect(segmentedLabelsFit(Number.NaN, 300)).toBe(true);
	expect(segmentedLabelsFit(100, 300)).toBe(true);
	// The tolerance keeps a label that fits by a hair off the divider beside it.
	expect(segmentedLabelsFit(300, 300)).toBe(false);
	expect(segmentedLabelsFit(295, 300)).toBe(false);
	expect(segmentedLabelsFit(292, 300)).toBe(true);
});
