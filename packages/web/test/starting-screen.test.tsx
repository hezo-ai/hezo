import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { StartingScreen } from '../src/components/starting-screen';

afterEach(() => {
	vi.useRealTimers();
});

test('shows the live boot phase message with a spinner while starting', () => {
	render(<StartingScreen phase="migrations" message="Running database migrations…" />);
	expect(screen.getByText('Running database migrations…')).toBeTruthy();
	// The polite status region is what screen readers announce as the phase advances.
	expect(screen.getByRole('status')).toBeTruthy();
});

test('shows the step in flight so a long migration is distinguishable from a hang', () => {
	render(
		<StartingScreen
			phase="migrations"
			message="Running database migrations…"
			detail="Applying 043_repos_push_access.sql (2 of 5)"
		/>,
	);
	expect(screen.getByText('Applying 043_repos_push_access.sql (2 of 5)')).toBeTruthy();
});

test('renders the mark alone - no wordmark on the boot screen', () => {
	render(<StartingScreen phase="migrations" message="Running database migrations…" />);
	expect(screen.queryByText('hezo')).toBeNull();
	expect(screen.getByAltText('Hezo')).toBeTruthy();
});

test('falls back to a generic message when none is provided', () => {
	render(<StartingScreen />);
	expect(screen.getByText('Starting up…')).toBeTruthy();
});

test('renders the failure layout with the reason when boot errors', () => {
	render(<StartingScreen phase="error" message="Startup failed" detail="migration 017 failed" />);
	expect(screen.getByText('Startup failed')).toBeTruthy();
	expect(screen.getByText('migration 017 failed')).toBeTruthy();
	expect(screen.getByText('Check the server logs for details.')).toBeTruthy();
	// No spinner/status region on the error layout.
	expect(screen.queryByRole('status')).toBeNull();
});

test('surfaces elapsed time once a phase runs long', async () => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	render(<StartingScreen phase="migrations" message="Running database migrations…" />);
	expect(screen.queryByText(/Still working/)).toBeNull();

	await act(async () => {
		vi.advanceTimersByTime(65_000);
	});
	expect(screen.getByText(/Still working \(1m 05s\)/)).toBeTruthy();
});

test('resets the elapsed counter when the phase advances', async () => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	const { rerender } = render(<StartingScreen phase="migrations" message="Migrating…" />);
	await act(async () => {
		vi.advanceTimersByTime(45_000);
	});
	expect(screen.getByText(/Still working/)).toBeTruthy();

	rerender(<StartingScreen phase="seed" message="Preparing data…" />);
	await act(async () => {
		vi.advanceTimersByTime(1_000);
	});
	expect(screen.queryByText(/Still working/)).toBeNull();
});

test('surfaces why the previous boot died so a restart loop is actionable', () => {
	render(
		<StartingScreen
			phase="migrations"
			message="Running database migrations…"
			lastFailure={{
				message: 'Migration 046_add_local_model_providers.sql failed: no space left on device',
				phase: 'migrations',
				version: '0.36.0',
				at: '2026-07-29T07:03:00.000Z',
			}}
		/>,
	);
	const block = screen.getByTestId('starting-screen-last-failure');
	expect(block.textContent).toContain('no space left on device');
	expect(block.textContent).toContain('0.36.0');
});

test('says nothing about a previous failure when the last boot was clean', () => {
	render(<StartingScreen phase="migrations" message="Running database migrations…" />);
	expect(screen.queryByTestId('starting-screen-last-failure')).toBeNull();
});

test('flags a crash loop when the boot phase goes backwards', () => {
	const { rerender } = render(<StartingScreen phase="migrations" message="Migrating…" />);
	expect(screen.queryByTestId('starting-screen-restarts')).toBeNull();

	// A fresh process answered the poll: the server died mid-migration and the
	// supervisor restarted it.
	rerender(<StartingScreen phase="starting" message="Starting up…" />);
	expect(screen.getByTestId('starting-screen-restarts').textContent).toContain('(1 time)');

	rerender(<StartingScreen phase="migrations" message="Migrating…" />);
	rerender(<StartingScreen phase="database" message="Opening the database…" />);
	expect(screen.getByTestId('starting-screen-restarts').textContent).toContain('(2 times)');
});

test('does not flag a restart while the phase only moves forward', () => {
	const { rerender } = render(<StartingScreen phase="starting" message="Starting up…" />);
	for (const [phase, message] of [
		['database', 'Opening the database…'],
		['migrations', 'Running database migrations…'],
		['seed', 'Preparing data…'],
		['workspace', 'Setting up your workspace…'],
	] as const) {
		rerender(<StartingScreen phase={phase} message={message} />);
	}
	expect(screen.queryByTestId('starting-screen-restarts')).toBeNull();
});
