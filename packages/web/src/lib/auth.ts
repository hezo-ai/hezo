import type { MasterKeyState } from '@hezo/shared';
import { api } from './api';

interface StatusResponse {
	masterKeyState: MasterKeyState;
	version: string;
}

export async function checkStatus(): Promise<StatusResponse> {
	const res = await fetch('/api/status');
	const body = (await res.json()) as StatusResponse & {
		error?: { code?: string; message?: string };
	};
	if (!res.ok) {
		const msg = body.error?.message ?? res.statusText;
		throw new Error(msg || `Status request failed (${res.status})`);
	}
	if (!body.masterKeyState) {
		throw new Error('Invalid status response from server');
	}
	return body;
}

export async function authenticate(masterKey: string): Promise<string> {
	const data = await api.post<{ token: string }>('/api/auth/token', { master_key: masterKey });
	api.setToken(data.token);
	return data.token;
}

export function logout() {
	api.clearToken();
}

export function isAuthenticated(): boolean {
	return api.getToken() !== null;
}
