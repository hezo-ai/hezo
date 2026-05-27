import { cleanup } from '@testing-library/react';
import * as React from 'react';
import { afterEach, vi } from 'vitest';

// TanStack Router's internal components (Transitioner, MatchesInner, MatchImpl)
// run useState/startTransition updates asynchronously after mount and after
// every router.navigate, even when navigate is awaited. React Testing Library
// sets IS_REACT_ACT_ENVIRONMENT, so each of those updates produces a noisy
// "not wrapped in act" warning that has no corresponding fix on the router
// side. Filter only those exact warnings; any other act warning still
// surfaces. React passes the component name as the second printf arg, so the
// format string holds %s rather than the literal name.
const ROUTER_ACT_COMPONENTS = new Set([
	'Transitioner',
	'MatchesInner',
	'MatchImpl',
	'Matches',
	'Match',
	'RouterProvider',
]);
const originalConsoleError = console.error;
console.error = (...args: unknown[]) => {
	const first = args[0];
	const second = args[1];
	if (
		typeof first === 'string' &&
		first.includes('not wrapped in act') &&
		typeof second === 'string' &&
		ROUTER_ACT_COMPONENTS.has(second)
	) {
		return;
	}
	originalConsoleError(...args);
};

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

// happy-dom has no layout, so IntersectionObserver never fires entries.
// LazyMount and any other intersection-driven mount stays empty under that
// model. Stub IO so it synchronously reports the observed node as intersecting
// — tests don't care about lazy mounting and the real behaviour is identical
// after first paint anyway.
class StubIntersectionObserver {
	private cb: IntersectionObserverCallback;
	root: Element | Document | null = null;
	rootMargin = '';
	thresholds: ReadonlyArray<number> = [];
	constructor(cb: IntersectionObserverCallback) {
		this.cb = cb;
	}
	observe(target: Element): void {
		this.cb(
			[
				{
					isIntersecting: true,
					target,
					intersectionRatio: 1,
					boundingClientRect: target.getBoundingClientRect(),
					intersectionRect: target.getBoundingClientRect(),
					rootBounds: null,
					time: 0,
				} as IntersectionObserverEntry,
			],
			this as unknown as IntersectionObserver,
		);
	}
	unobserve(): void {}
	disconnect(): void {}
	takeRecords(): IntersectionObserverEntry[] {
		return [];
	}
}
(
	globalThis as unknown as { IntersectionObserver: typeof StubIntersectionObserver }
).IntersectionObserver = StubIntersectionObserver;
