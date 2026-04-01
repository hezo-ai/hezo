import type { MasterKeyState } from '@hezo/shared';
import { api } from './api';

interface StatusResponse {
	masterKeyState: MasterKeyState;
	version: string;
}

export async function checkStatus(): Promise<StatusResponse> {
	const res = await fetch('/api/status');
	return res.json();
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
