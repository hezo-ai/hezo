const TOKEN_KEY = 'hezo_token';

export interface ApiError {
	code: string;
	message: string;
	status: number;
}

class ApiClient {
	private token: string | null = localStorage.getItem(TOKEN_KEY);

	getToken(): string | null {
		return this.token;
	}

	setToken(token: string) {
		this.token = token;
		localStorage.setItem(TOKEN_KEY, token);
	}

	clearToken() {
		this.token = null;
		localStorage.removeItem(TOKEN_KEY);
	}

	private async extractError(res: Response): Promise<ApiError> {
		const json = await res.json().catch(() => null);
		return {
			code: json?.error?.code ?? 'UNKNOWN',
			message: json?.error?.message ?? res.statusText,
			status: res.status,
		};
	}

	private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (this.token) headers.Authorization = `Bearer ${this.token}`;

		const res = await fetch(path, {
			method,
			headers,
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});

		if (!res.ok) throw await this.extractError(res);

		const json = await res.json();
		return json.data !== undefined ? json.data : json;
	}

	get<T>(path: string, params?: Record<string, string | undefined>) {
		if (params) {
			const qs = new URLSearchParams();
			for (const [k, v] of Object.entries(params)) {
				if (v !== undefined) qs.set(k, v);
			}
			const str = qs.toString();
			if (str) path = `${path}?${str}`;
		}
		return this.request<T>('GET', path);
	}

	post<T>(path: string, body?: unknown) {
		return this.request<T>('POST', path, body);
	}

	patch<T>(path: string, body: unknown) {
		return this.request<T>('PATCH', path, body);
	}

	put<T>(path: string, body: unknown) {
		return this.request<T>('PUT', path, body);
	}

	delete<T>(path: string) {
		return this.request<T>('DELETE', path);
	}

	async postForm<T>(path: string, formData: FormData): Promise<T> {
		const headers: Record<string, string> = {};
		if (this.token) headers.Authorization = `Bearer ${this.token}`;
		const res = await fetch(path, { method: 'POST', headers, body: formData });
		if (!res.ok) throw await this.extractError(res);
		const json = await res.json();
		return json.data !== undefined ? json.data : json;
	}
}

export const api = new ApiClient();
