import { Button, ConfirmDialog, isMacPlatform, parseShortcut } from '@hezo/ui';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { expect, test, vi } from 'vitest';

/**
 * Which binding owns a key when more than one wants it.
 *
 * Every binding used to register its own listener and defer to whoever had
 * already claimed the key, so the *first* one mounted won and a confirmation
 * opened over a page lost its shortcut to the button underneath. These specs pin
 * the opposite: the most recently registered binding fires, and the key returns
 * to the one below it when that binding goes away.
 */

// `mod` is the platform-primary modifier, so ask which key to press rather than
// hard-coding one - the same spec has to pass on a mac and on a Linux CI host.
const mac = isMacPlatform();
const modEnter = { key: 'Enter', metaKey: mac, ctrlKey: !mac };

test('the most recently registered binding is the only one that fires', () => {
	const page = vi.fn();
	const layer = vi.fn();

	function Harness({ layerOpen }: { layerOpen: boolean }) {
		return (
			<>
				<Button shortcut="mod+Enter" onClick={page}>
					Save
				</Button>
				{layerOpen && (
					<Button shortcut="mod+Enter" onClick={layer}>
						Confirm
					</Button>
				)}
			</>
		);
	}

	const { rerender } = render(<Harness layerOpen={false} />);
	fireEvent.keyDown(document.body, modEnter);
	expect([page.mock.calls.length, layer.mock.calls.length]).toEqual([1, 0]);

	// The layer registers in a later commit, which is what puts it on top.
	rerender(<Harness layerOpen />);
	fireEvent.keyDown(document.body, modEnter);
	expect([page.mock.calls.length, layer.mock.calls.length]).toEqual([1, 1]);

	// And the key comes back rather than staying dead.
	rerender(<Harness layerOpen={false} />);
	fireEvent.keyDown(document.body, modEnter);
	expect([page.mock.calls.length, layer.mock.calls.length]).toEqual([2, 1]);
});

test('a confirmation opened over a page button takes the shortcut from it', async () => {
	const pageAction = vi.fn();
	const onConfirm = vi.fn();

	function Harness() {
		const [open, setOpen] = useState(false);
		return (
			<>
				<Button shortcut="mod+Enter" onClick={pageAction}>
					Delete project
				</Button>
				<Button onClick={() => setOpen(true)}>Open</Button>
				<ConfirmDialog
					open={open}
					onOpenChange={setOpen}
					title="Delete project?"
					description="The project and its tasks are removed."
					onConfirm={onConfirm}
				/>
			</>
		);
	}

	render(<Harness />);
	fireEvent.click(screen.getByRole('button', { name: 'Open' }));

	// The dialog stays mounted while closed and registers only once it opens, so
	// opening it is what puts its binding above the page button's.
	await act(async () => {
		fireEvent.keyDown(document.body, modEnter);
	});

	expect(onConfirm).toHaveBeenCalledTimes(1);
	expect(pageAction).not.toHaveBeenCalled();
});

test('one binding still fires, and a claimed key reaches none of them', () => {
	const outer = vi.fn();
	const inner = vi.fn();
	render(
		<>
			<Button shortcut="Escape" onClick={outer}>
				Outer
			</Button>
			<Button shortcut="Escape" onClick={inner}>
				Inner
			</Button>
		</>,
	);

	fireEvent.keyDown(document.body, { key: 'Escape' });
	expect([outer.mock.calls.length, inner.mock.calls.length]).toEqual([0, 1]);

	// Claimed by a handler nearer the target, or by an earlier capture-phase one:
	// nothing on the stack runs behind it.
	const claimed = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
	claimed.preventDefault();
	document.dispatchEvent(claimed);
	expect([outer.mock.calls.length, inner.mock.calls.length]).toEqual([0, 1]);
});

test('unregistering from the middle leaves the rest of the stack in order', () => {
	const a = vi.fn();
	const b = vi.fn();
	const c = vi.fn();

	function Harness({ showB }: { showB: boolean }) {
		return (
			<>
				<Button shortcut="Escape" onClick={a}>
					A
				</Button>
				{showB && (
					<Button shortcut="Escape" onClick={b}>
						B
					</Button>
				)}
				<Button shortcut="Escape" onClick={c}>
					C
				</Button>
			</>
		);
	}

	const { rerender } = render(<Harness showB />);
	fireEvent.keyDown(document.body, { key: 'Escape' });
	expect([a.mock.calls.length, b.mock.calls.length, c.mock.calls.length]).toEqual([0, 0, 1]);

	// Removing the middle binding must not promote or demote anything else.
	rerender(<Harness showB={false} />);
	fireEvent.keyDown(document.body, { key: 'Escape' });
	expect([a.mock.calls.length, b.mock.calls.length, c.mock.calls.length]).toEqual([0, 0, 2]);
});

test('a bare-letter shortcut survives a checkbox holding focus', () => {
	const onClick = vi.fn();
	render(
		<>
			<input type="checkbox" data-testid="box" />
			<Button shortcut="r" onClick={onClick}>
				Refresh
			</Button>
		</>,
	);

	// A checkbox consumes no typed characters, so it is not somewhere a letter
	// needs protecting from.
	fireEvent.keyDown(screen.getByTestId('box'), { key: 'r' });
	expect(onClick).toHaveBeenCalledTimes(1);
});

test('a spec naming only modifiers fails rather than binding nothing', () => {
	expect(() => parseShortcut('mod+shift')).toThrow(/no key/);
});
