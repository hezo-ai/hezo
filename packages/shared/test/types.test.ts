import { describe, expect, it } from 'vitest';
import {
	ACTIVE_WAKEUP_STATUSES,
	API_BODY_MAX_BYTES,
	ATTACHMENT_MAX_BYTES,
	PROJECT_ICON_MAX_BYTES,
	SANDBOX_BACKEND_KIND,
	SANDBOX_BACKENDS,
	SandboxBackend,
	sandboxBackendNeedsApiKey,
	TERMINAL_WAKEUP_STATUSES,
	WakeupStatus,
} from '../src/types/common';
import {
	CONNECTOR_CAPABILITIES,
	getConnectorCapability,
} from '../src/types/connector-capabilities';
import { WsClientAction, WsMessageType } from '../src/types/websocket';

describe('websocket message enums', () => {
	it('exposes stable wire values', () => {
		expect(WsMessageType.RowChange).toBe('row_change');
		expect(WsMessageType.ChatMessageDelta).toBe('chat_message_delta');
		expect(WsClientAction.Subscribe).toBe('subscribe');
		expect(WsClientAction.Unsubscribe).toBe('unsubscribe');
	});
});

describe('connector capabilities', () => {
	it('looks up a known connector and its device-auth config', () => {
		const gh = getConnectorCapability('github');
		expect(gh?.displayName).toBe('GitHub');
		expect(gh?.allowedHosts).toContain('github.com');
		expect(gh?.scopes).toContain('repo');
		expect(gh?.deviceAuth?.clientIdEnv).toBe('GITHUB_OAUTH_CLIENT_ID');
	});

	it('returns undefined for an unknown connector', () => {
		expect(getConnectorCapability('does-not-exist')).toBeUndefined();
	});

	it('keeps every registry entry id in sync with its key', () => {
		for (const [key, cap] of Object.entries(CONNECTOR_CAPABILITIES)) {
			expect(cap.id).toBe(key);
			expect(cap.mcpServer.transport).toBeTruthy();
		}
	});
});

describe('API body ceiling', () => {
	// The ceiling is a DoS backstop, not a policy. If it ever drops to (or below)
	// a per-route cap, two things break at once: a route that answers a too-large
	// file with its own specific 400 starts returning an opaque 413 instead, and
	// a *valid* maximum-size upload is rejected because its multipart envelope
	// pushes the request past the file's own size.
	it('stays clear of every per-route cap', () => {
		for (const perRoute of [ATTACHMENT_MAX_BYTES, PROJECT_ICON_MAX_BYTES]) {
			expect(API_BODY_MAX_BYTES).toBeGreaterThan(perRoute);
			// Envelope overhead plus room for a route to raise its own cap without
			// silently colliding with this one.
			expect(API_BODY_MAX_BYTES).toBeGreaterThanOrEqual(perRoute * 2);
		}
	});
});

describe('wakeup status partitioning', () => {
	// The maintenance sweep deletes rows whose status is in
	// TERMINAL_WAKEUP_STATUSES, so a status that belongs in neither list would be
	// invisible to the scheduler's "still active" checks *and* to the sweep, and
	// one that lands in both would be deleted while still pending. Adding a
	// status must therefore be a deliberate choice, not a default.
	it('splits every WakeupStatus into exactly one of active or terminal', () => {
		const all = Object.values(WakeupStatus).sort();
		const partitioned = [...ACTIVE_WAKEUP_STATUSES, ...TERMINAL_WAKEUP_STATUSES].sort();
		expect(partitioned).toEqual(all);
		for (const status of ACTIVE_WAKEUP_STATUSES) {
			expect(TERMINAL_WAKEUP_STATUSES).not.toContain(status);
		}
	});

	it('treats deferred as active, since a cleared blocker re-queues it', () => {
		expect(ACTIVE_WAKEUP_STATUSES).toContain(WakeupStatus.Deferred);
		expect(TERMINAL_WAKEUP_STATUSES).not.toContain(WakeupStatus.Deferred);
	});
});

describe('sandbox backend kind', () => {
	// The credential requirement is a property of the *class* of backend, not of
	// any one provider: every remote container service is reached over the
	// internet behind an account. Four sites used to spell it
	// `=== SandboxBackend.Daytona`, so a second provider would have inherited
	// "needs no key" at all of them - the switch route would have skipped its
	// guard, the switcher would have passed no key to the preflight, and the
	// dialog would have offered no field to type one into.
	it('classifies every backend, so a new one cannot default into a branch', () => {
		for (const backend of SANDBOX_BACKENDS) {
			expect(SANDBOX_BACKEND_KIND[backend]).toMatch(/^(local|remote)$/);
		}
		expect(Object.keys(SANDBOX_BACKEND_KIND).sort()).toEqual([...SANDBOX_BACKENDS].sort());
	});

	it('asks for an API key on exactly the remote backends', () => {
		for (const backend of SANDBOX_BACKENDS) {
			expect(sandboxBackendNeedsApiKey(backend)).toBe(SANDBOX_BACKEND_KIND[backend] === 'remote');
		}
		expect(sandboxBackendNeedsApiKey(SandboxBackend.Docker)).toBe(false);
		expect(sandboxBackendNeedsApiKey(SandboxBackend.Daytona)).toBe(true);
	});
});
