import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { StartingScreen } from '../src/components/starting-screen';

test('shows the live boot phase message with a spinner while starting', () => {
	render(<StartingScreen phase="migrations" message="Running database migrations…" />);
	expect(screen.getByText('Running database migrations…')).toBeTruthy();
	// The polite status region is what screen readers announce as the phase advances.
	expect(screen.getByRole('status')).toBeTruthy();
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
