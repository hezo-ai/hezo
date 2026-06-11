// Covers the reconnect-invalidation hook: row-change events emitted while the
// WebSocket was down are lost (no replay), so the shell must refetch everything
// once the connection heals — and must NOT refetch on the initial connect.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { useInvalidateOnReconnect } from '../src/hooks/use-websocket';

function Probe({ connected }: { connected: boolean }) {
	useInvalidateOnReconnect(connected);
	return null;
}

test('invalidates all queries on reconnect but not on the initial connect', () => {
	const queryClient = new QueryClient();
	const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

	const ui = (connected: boolean) => (
		<QueryClientProvider client={queryClient}>
			<Probe connected={connected} />
		</QueryClientProvider>
	);

	// Mounts disconnected — the socket dials asynchronously.
	const { rerender } = render(ui(false));
	expect(invalidate).not.toHaveBeenCalled();

	// Initial connect: queries are freshly fetched on mount, so no invalidation.
	rerender(ui(true));
	expect(invalidate).not.toHaveBeenCalled();

	// Server restart: the socket drops and heals — everything refetches.
	rerender(ui(false));
	rerender(ui(true));
	expect(invalidate).toHaveBeenCalledTimes(1);

	// Each subsequent drop/heal cycle refetches again.
	rerender(ui(false));
	rerender(ui(true));
	expect(invalidate).toHaveBeenCalledTimes(2);
});
