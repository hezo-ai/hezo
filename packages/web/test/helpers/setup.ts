import { cleanup } from '@testing-library/react';
import * as React from 'react';
import { afterEach, vi } from 'vitest';

// happy-dom has no layout, so react-virtuoso measures zero viewport and refuses
// to mount any items. Component-tier tests don't care about virtualization;
// stub Virtuoso to a plain mapped list so comments / sub-tasks / KB lists
// actually render. Tests that need the real virtualization (windowing, scroll
// behaviour) stay in Playwright.
vi.mock('react-virtuoso', () => {
	type ItemRenderer = (index: number, item: unknown) => React.ReactNode;
	interface VirtuosoProps {
		data?: unknown[];
		itemContent?: ItemRenderer;
		computeItemKey?: (index: number, item: unknown) => React.Key;
	}
	const Virtuoso = React.forwardRef<unknown, VirtuosoProps>((props, _ref) => {
		const { data = [], itemContent, computeItemKey } = props;
		return React.createElement(
			'div',
			{ 'data-virtuoso-stub': 'true' },
			data.map((item, i) =>
				React.createElement(
					React.Fragment,
					{ key: computeItemKey?.(i, item) ?? i },
					itemContent?.(i, item),
				),
			),
		);
	});
	return { Virtuoso, VirtuosoGrid: Virtuoso, VirtuosoHandle: class {} };
});

// React Testing Library unmounts components after each test; without this the
// previous test's DOM still sits in document.body and the next test's queries
// match both.
afterEach(() => {
	cleanup();
});

// Stub WebSocket so the realtime layer doesn't try to dial a real socket from
// happy-dom (the dev shell wires up reconnecting-websocket on every mount and
// would otherwise leak handles across tests). The shape mirrors enough of the
// real WebSocket interface that reconnecting-websocket's wrapper accepts it.
class StubWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	readonly CONNECTING = 0;
	readonly OPEN = 1;
	readonly CLOSING = 2;
	readonly CLOSED = 3;
	readyState = 3;
	url: string;
	binaryType = 'blob';
	protocol = '';
	extensions = '';
	bufferedAmount = 0;
	onopen: ((this: WebSocket, ev: Event) => unknown) | null = null;
	onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null = null;
	onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null;
	onerror: ((this: WebSocket, ev: Event) => unknown) | null = null;
	constructor(url: string | URL, _protocols?: string | string[]) {
		this.url = url.toString();
	}
	close() {}
	send() {}
	addEventListener() {}
	removeEventListener() {}
	dispatchEvent() {
		return true;
	}
}
(globalThis as unknown as { WebSocket: typeof StubWebSocket }).WebSocket = StubWebSocket;
