import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactElement, useState } from 'react';
import { expect, test, vi } from 'vitest';
import { MarkdownEditor } from '../src/components/markdown-editor';

/** The preview pane mounts <MarkdownProse>, whose mention hooks call useQuery. */
function renderWithClient(ui: ReactElement) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: 0 } },
	});
	return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/** Controlled wrapper mirroring how the real forms drive the editor. */
function Harness({
	initial = '',
	onChange,
	...rest
}: {
	initial?: string;
	onChange?: (next: string) => void;
} & Omit<React.ComponentProps<typeof MarkdownEditor>, 'value' | 'onChange'>) {
	const [value, setValue] = useState(initial);
	return (
		<MarkdownEditor
			value={value}
			onChange={(next) => {
				setValue(next);
				onChange?.(next);
			}}
			{...rest}
		/>
	);
}

test('typing updates the value via onChange', async () => {
	const user = userEvent.setup({ delay: null });
	const onChange = vi.fn();
	const { getByLabelText } = renderWithClient(<Harness ariaLabel="Body" onChange={onChange} />);

	const textarea = getByLabelText('Body') as HTMLTextAreaElement;
	await user.type(textarea, 'hello');

	expect(textarea.value).toBe('hello');
	expect(onChange).toHaveBeenLastCalledWith('hello');
});

test('toggling Edit/Preview swaps panes, fires onModeChange, and round-trips the value', async () => {
	const user = userEvent.setup({ delay: null });
	const onModeChange = vi.fn();
	const { getByRole, getByTestId, queryByLabelText, getByLabelText } = renderWithClient(
		<Harness
			initial="# Heading"
			ariaLabel="Body"
			previewTestId="md-preview"
			onModeChange={onModeChange}
		/>,
	);

	await user.click(getByRole('tab', { name: 'Preview' }));
	expect(onModeChange).toHaveBeenLastCalledWith('preview');
	// Edit textarea is replaced by the rendered preview.
	expect(queryByLabelText('Body')).toBeNull();
	expect(getByTestId('md-preview').querySelector('h1')?.textContent).toContain('Heading');

	await user.click(getByRole('tab', { name: 'Edit' }));
	expect(onModeChange).toHaveBeenLastCalledWith('edit');
	// The raw markdown survives the round-trip.
	expect((getByLabelText('Body') as HTMLTextAreaElement).value).toBe('# Heading');
});

test('empty content renders the emptyPreviewText placeholder', async () => {
	const user = userEvent.setup({ delay: null });
	const { getByRole, getByTestId } = renderWithClient(
		<Harness
			ariaLabel="Body"
			previewTestId="md-preview"
			emptyPreviewText="_(nothing to preview)_"
		/>,
	);

	await user.click(getByRole('tab', { name: 'Preview' }));
	expect(getByTestId('md-preview').textContent).toContain('nothing to preview');
});

test('previewContent overrides the editor value in the preview pane', async () => {
	const user = userEvent.setup({ delay: null });
	const { getByRole, getByTestId } = renderWithClient(
		<Harness
			initial="# Raw template"
			ariaLabel="Body"
			previewTestId="md-preview"
			previewContent="# Resolved output"
		/>,
	);

	await user.click(getByRole('tab', { name: 'Preview' }));
	const preview = getByTestId('md-preview');
	expect(preview.querySelector('h1')?.textContent).toContain('Resolved output');
	expect(preview.textContent).not.toContain('Raw template');
});

test('isPreviewLoading shows a resolving placeholder instead of the body', async () => {
	const user = userEvent.setup({ delay: null });
	const { getByRole, getByTestId } = renderWithClient(
		<Harness
			initial="# Body heading"
			ariaLabel="Body"
			previewTestId="md-preview"
			isPreviewLoading
		/>,
	);

	await user.click(getByRole('tab', { name: 'Preview' }));
	const preview = getByTestId('md-preview');
	expect(preview.textContent).toContain('Resolving');
	expect(preview.querySelector('h1')).toBeNull();
});

const TEST_VARS = [
	{ token: '{{team_name}}', description: "The team's name." },
	{ token: '{{skills_context}}', description: 'The skills manifest.' },
];

/**
 * userEvent reads `{{` as its escape for a literal `{`, so typing the trigger
 * through it never produces one. Drive the change directly instead - React's
 * onChange is what the trigger detection hangs off either way.
 */
function typeInto(el: HTMLTextAreaElement, value: string) {
	fireEvent.change(el, { target: { value } });
}

test('the {{ trigger inserts a variable token, with no projectId needed', async () => {
	const user = userEvent.setup({ delay: null });
	const { getByLabelText, findByTestId, getByText } = renderWithClient(
		<Harness ariaLabel="Body" variables={TEST_VARS} />,
	);

	const textarea = getByLabelText('Body') as HTMLTextAreaElement;
	// The variable vocabulary is local, so the picker opens without a project.
	typeInto(textarea, 'Follow {{team');
	await findByTestId('mention-picker');
	await user.click(getByText('{{team_name}}'));

	expect(textarea.value).toBe('Follow {{team_name}}');
	// No trailing space: a token has to be able to butt up against its suffix.
	expect(textarea.value.endsWith('}}')).toBe(true);
});

test('the {{ trigger filters to the matching variables only', async () => {
	const { getByLabelText, findByTestId, queryByText } = renderWithClient(
		<Harness ariaLabel="Body" variables={TEST_VARS} />,
	);

	typeInto(getByLabelText('Body') as HTMLTextAreaElement, '{{skills');
	await findByTestId('mention-picker');
	expect(queryByText('{{skills_context}}')).not.toBeNull();
	expect(queryByText('{{team_name}}')).toBeNull();
});

test('without variables, {{ is ordinary text', async () => {
	const { getByLabelText, queryByTestId } = renderWithClient(<Harness ariaLabel="Body" />);

	typeInto(getByLabelText('Body') as HTMLTextAreaElement, '{{team');
	expect(queryByTestId('mention-picker')).toBeNull();
});

test('without a projectId, typing @ opens no mention picker', async () => {
	const user = userEvent.setup({ delay: null });
	const { getByLabelText, queryByTestId } = renderWithClient(<Harness ariaLabel="Body" />);

	await user.type(getByLabelText('Body'), '@eng');
	expect(queryByTestId('mention-picker')).toBeNull();
});
