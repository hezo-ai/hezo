import { quietTestLogs } from '@hezo/server/test/helpers/log-level';
import { cleanup, configure } from '@testing-library/react';
import * as React from 'react';
import { afterEach, vi } from 'vitest';

// Web component tests boot the server in-process (createTestApp via render.tsx),
// so the server logger drives all the `[info]` chatter (seeded teams,
// provisioned stub containers, …). Raise the floor to `warn` so it doesn't bury
// real signal; `[warn]`/`[error]` stay visible. Honour HEZO_LOG_LEVEL to opt back in.
quietTestLogs();

// Testing Library's default `findBy*` / `waitFor` timeout of 1s races CI's
// fork-pool concurrency on smaller runners. With 10 worker forks each
// owning a full PGlite + Hono boot, navigation + initial render
// routinely exceeds 1s under load — surfacing as random "Unable to find
// an element" failures on whichever test happens to be scheduled when
// the box is most contended. A passing `findBy*` still returns the
// moment the element appears; only the worst case is bounded higher.
configure({ asyncUtilTimeout: 10_000 });

// "An update to X inside a test was not wrapped in act(...)" warnings are
// pure test-environment noise here: TanStack Router internals
// (Transitioner, OutletImpl, MatchInnerImpl), Radix UI (Tooltip, Presence,
// Popper) and React Query refetches all trigger async state updates that
// React Testing Library can't batch into act, even when navigation /
// findBy* / waitFor are awaited correctly. None of these translate to real
// runtime bugs — they only surface because IS_REACT_ACT_ENVIRONMENT is on
// for the test runner. Suppress the entire warning category so CI logs
// stay readable; behavioural regressions still show up as actual test
// failures.
const originalConsoleError = console.error;
console.error = (...args: unknown[]) => {
	const first = args[0];
	if (typeof first === 'string' && first.includes('not wrapped in act')) {
		return;
	}
	originalConsoleError(...args);
};

// Node ≥22 ships an experimental `localStorage` global that is undefined unless
// the process runs with --localstorage-file. Vitest's happy-dom environment
// won't overwrite an existing global, so on those Node versions every module
// that touches localStorage at import time (the api singleton) explodes with
// "Cannot read properties of undefined". Backfill a plain in-memory Storage.
if (globalThis.localStorage === undefined) {
	const store = new Map<string, string>();
	const memoryStorage: Storage = {
		get length() {
			return store.size;
		},
		clear: () => store.clear(),
		getItem: (key: string) => store.get(key) ?? null,
		key: (index: number) => [...store.keys()][index] ?? null,
		removeItem: (key: string) => {
			store.delete(key);
		},
		setItem: (key: string, value: string) => {
			store.set(key, String(value));
		},
	};
	Object.defineProperty(globalThis, 'localStorage', {
		value: memoryStorage,
		configurable: true,
	});
}

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
