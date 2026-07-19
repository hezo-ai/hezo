// The disconnect indicator: the module-level connection store, the socket
// monitor that drives it (debounce + connected-once gate), and the persistent
// toast the Toaster renders from it. The monitor consumes only a boolean + a
// stable callback, so it's driven directly by a prop here (no real socket).
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Toaster } from '../src/components/ui/toast';
import {
	type ConnectionState,
	OFFLINE_DEBOUNCE_MS,
	setConnectionOffline,
	setConnectionOnline,
	useConnectionMonitor,
	useConnectionStatus,
} from '../src/hooks/use-connection-status';

let latest: ConnectionState;
function Reader() {
	latest = useConnectionStatus();
	return null;
}
function Monitor({ connected, reconnect }: { connected: boolean; reconnect: () => void }) {
	useConnectionMonitor(connected, reconnect);
	return null;
}

describe('connection store', () => {
	afterEach(() => setConnectionOnline());

	test('offline/online transitions drive the store and notify readers', () => {
		render(<Reader />);
		expect(latest.offline).toBe(false);
		expect(latest.retry).toBeNull();

		const retry = () => {};
		act(() => setConnectionOffline(retry));
		expect(latest.offline).toBe(true);
		expect(latest.retry).toBe(retry);

		act(() => setConnectionOnline());
		expect(latest.offline).toBe(false);
		expect(latest.retry).toBeNull();
	});
});

describe('useConnectionMonitor', () => {
	afterEach(() => {
		vi.useRealTimers();
		setConnectionOnline();
	});

	const ui = (connected: boolean, reconnect: () => void) => (
		<>
			<Monitor connected={connected} reconnect={reconnect} />
			<Reader />
		</>
	);

	test('surfaces offline only after the debounce, and heals immediately', () => {
		vi.useFakeTimers();
		const reconnect = vi.fn();
		const { rerender } = render(ui(true, reconnect)); // connect first
		expect(latest.offline).toBe(false);

		rerender(ui(false, reconnect)); // drop
		act(() => vi.advanceTimersByTime(OFFLINE_DEBOUNCE_MS - 1));
		expect(latest.offline).toBe(false); // still within the debounce window

		act(() => vi.advanceTimersByTime(1));
		expect(latest.offline).toBe(true);
		expect(latest.retry).toBe(reconnect); // "Retry now" is wired to reconnect

		rerender(ui(true, reconnect)); // heal
		expect(latest.offline).toBe(false);
	});

	test('a brief blip that heals before the debounce never surfaces offline', () => {
		vi.useFakeTimers();
		const noop = () => {};
		const { rerender } = render(ui(true, noop));
		rerender(ui(false, noop));
		act(() => vi.advanceTimersByTime(OFFLINE_DEBOUNCE_MS - 500));
		rerender(ui(true, noop)); // heals before the debounce elapses
		act(() => vi.advanceTimersByTime(5000));
		expect(latest.offline).toBe(false);
	});

	test('never surfaces offline until the socket has connected once', () => {
		// Mirrors the component-test harness, whose stubbed WebSocket never opens:
		// without the connected-once gate every shell test would grow a disconnect
		// toast. Start disconnected and never connect.
		vi.useFakeTimers();
		render(ui(false, () => {}));
		act(() => vi.advanceTimersByTime(OFFLINE_DEBOUNCE_MS * 3));
		expect(latest.offline).toBe(false);
	});

	test('surfaces offline when the browser goes offline, even if the socket reads connected', () => {
		// A dropped internet connection can leave an already-open socket reading
		// OPEN (half-open TCP), so navigator.onLine is the signal that fires.
		vi.useFakeTimers();
		render(ui(true, () => {}));
		expect(latest.offline).toBe(false);

		act(() => window.dispatchEvent(new Event('offline')));
		act(() => vi.advanceTimersByTime(OFFLINE_DEBOUNCE_MS));
		expect(latest.offline).toBe(true);

		act(() => window.dispatchEvent(new Event('online')));
		expect(latest.offline).toBe(false);
	});
});

describe('connection toast (Toaster)', () => {
	afterEach(() => setConnectionOnline());

	test('shows nothing while online', () => {
		render(<Toaster />);
		expect(screen.queryByTestId('connection-toast')).toBeNull();
	});

	test('renders the disconnect banner when offline and Retry now fires reconnect', async () => {
		const user = userEvent.setup();
		const retry = vi.fn();
		render(<Toaster />);

		act(() => setConnectionOffline(retry));

		const banner = screen.getByTestId('connection-toast');
		expect(banner.textContent).toContain('Connection lost');
		expect(banner.textContent).toContain('Reconnecting');

		await user.click(screen.getByTestId('connection-retry'));
		expect(retry).toHaveBeenCalledTimes(1);
	});
});
