import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
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

test('chips insert their token into the value', async () => {
	const user = userEvent.setup({ delay: null });
	const { getByRole, getByLabelText } = renderWithClient(
		<Harness ariaLabel="Body" chips={['{{team_name}}', '{{agent_role}}']} />,
	);

	await user.click(getByRole('button', { name: '{{team_name}}' }));
	await user.click(getByRole('button', { name: '{{agent_role}}' }));

	const textarea = getByLabelText('Body') as HTMLTextAreaElement;
	expect(textarea.value).toContain('{{team_name}}');
	expect(textarea.value).toContain('{{agent_role}}');
});

test('without a projectId, typing @ opens no mention picker', async () => {
	const user = userEvent.setup({ delay: null });
	const { getByLabelText, queryByTestId } = renderWithClient(<Harness ariaLabel="Body" />);

	await user.type(getByLabelText('Body'), '@eng');
	expect(queryByTestId('mention-picker')).toBeNull();
});
