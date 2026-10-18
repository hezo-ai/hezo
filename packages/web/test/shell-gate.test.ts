import type { StatusResponse } from '@hezo/web/lib/auth';
import { type ShellGateInput, shellGate } from '@hezo/web/lib/shell-gate';
import { expect, test } from 'vitest';

// The one decision both the shell and the support chat read. The shell's own
// specs cover what each gate draws; this covers which gate a state lands on.

const UNLOCKED: StatusResponse = {
	masterKeyState: 'unlocked',
	passwordSet: true,
	version: '0.70.1',
};

const SIGNED_OUT = { isPending: false, isError: true };

function gate(input: Partial<ShellGateInput>) {
	return shellGate({
		status: UNLOCKED,
		statusLoading: false,
		statusFailed: false,
		session: { isPending: false, isError: false },
		ssoPhase: 'idle',
		...input,
	}).kind;
}

test('a booting server shows its boot phase before anything else', () => {
	const status: StatusResponse = { starting: true, phase: 'migrations', version: '0.70.1' };
	expect(
		shellGate({
			status,
			statusLoading: true,
			statusFailed: false,
			session: SIGNED_OUT,
			ssoPhase: 'idle',
		}),
	).toEqual({ kind: 'starting', status });
});

test('the first status load waits, and a failed or empty one is unreachable', () => {
	expect(gate({ status: undefined, statusLoading: true })).toBe('loading');
	expect(gate({ statusFailed: true })).toBe('unreachable');
	expect(gate({ status: undefined })).toBe('unreachable');
	expect(gate({ status: { version: '0.70.1' } })).toBe('unreachable');
});

test('a vault that is not unlocked names which way it is shut', () => {
	expect(gate({ status: { ...UNLOCKED, masterKeyState: 'unset' } })).toBe('vault-unset');
	expect(gate({ status: { ...UNLOCKED, masterKeyState: 'locked' } })).toBe('vault-locked');
});

test('an unlocked instance waits for the session probe, then lets a session in', () => {
	expect(gate({ session: { isPending: true, isError: false } })).toBe('loading');
	expect(gate({})).toBe('signed-in');
});

test('with no session, an identity in flight is waited for', () => {
	for (const ssoPhase of ['exchanging', 'holding', 'redeeming'] as const) {
		expect(gate({ session: SIGNED_OUT, ssoPhase })).toBe('signing-in');
	}
});

test('with no session, an issuer signs people in and the instance does not', () => {
	const sso = { issuer_url: 'https://control.example', logout_url: 'https://control.example/out' };
	expect(
		shellGate({
			status: { ...UNLOCKED, sso },
			statusLoading: false,
			statusFailed: false,
			session: SIGNED_OUT,
			ssoPhase: 'failed',
		}),
	).toEqual({ kind: 'issuer-redirect', issuerUrl: 'https://control.example' });
});

test('with no session and no issuer, a password is created once and then asked for', () => {
	expect(gate({ session: SIGNED_OUT, status: { ...UNLOCKED, passwordSet: false } })).toBe(
		'create-password',
	);
	expect(gate({ session: SIGNED_OUT })).toBe('sign-in');
});
