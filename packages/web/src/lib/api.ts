import { readStored, removeStored, writeStored } from './safe-storage';

const TOKEN_KEY = 'hezo_token';

export interface ApiError {
	code: string;
	message: string;
	status: number;
}

export interface PaginationMeta {
	page: number;
	per_page: number;
	total: number;
}

class ApiClient {
	private token: string | null = readStored(TOKEN_KEY);

	getToken(): string | null {
		return this.token;
	}

	setToken(token: string) {
		this.token = token;
		writeStored(TOKEN_KEY, token);
	}

	clearToken() {
		this.token = null;
		removeStored(TOKEN_KEY);
	}

	private authHeaders(contentType = 'application/json'): Record<string, string> {
		const headers: Record<string, string> = { 'Content-Type': contentType };
		if (this.token) headers.Authorization = `Bearer ${this.token}`;
		return headers;
	}

	private async extractError(res: Response): Promise<ApiError> {
		const json = await res.json().catch(() => null);
		return {
			code: json?.error?.code ?? 'UNKNOWN',
			message: json?.error?.message ?? res.statusText,
			status: res.status,
		};
	}

	private async fetchJson<T>(method: string, path: string, body?: unknown): Promise<T> {
		const res = await fetch(path, {
			method,
			headers: this.authHeaders(),
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});

		if (!res.ok) throw await this.extractError(res);
		return (await res.json()) as T;
	}

	private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const json = await this.fetchJson<{ data?: T } & Record<string, unknown>>(method, path, body);
		return json.data !== undefined ? json.data : (json as T);
	}

	private withQuery(path: string, params?: Record<string, string | undefined>): string {
		if (!params) return path;
		const qs = new URLSearchParams();
		for (const [k, v] of Object.entries(params)) {
			if (v !== undefined) qs.set(k, v);
		}
		const str = qs.toString();
		return str ? `${path}?${str}` : path;
	}

	get<T>(path: string, params?: Record<string, string | undefined>) {
		return this.request<T>('GET', this.withQuery(path, params));
	}

	/** GET that preserves `{ data, meta }` pagination envelopes from the API. */
	async getPaginated<TItem>(
		path: string,
		params?: Record<string, string | undefined>,
	): Promise<{ data: TItem[]; meta: PaginationMeta }> {
		const json = await this.fetchJson<{ data?: TItem[]; meta?: PaginationMeta }>(
			'GET',
			this.withQuery(path, params),
		);
		const data = json.data ?? [];
		return {
			data,
			meta: json.meta ?? { page: 1, per_page: data.length, total: data.length },
		};
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
		return this.sendForm<T>('POST', path, formData);
	}

	async putForm<T>(path: string, formData: FormData): Promise<T> {
		return this.sendForm<T>('PUT', path, formData);
	}

	private async sendForm<T>(method: string, path: string, formData: FormData): Promise<T> {
		const headers: Record<string, string> = {};
		if (this.token) headers.Authorization = `Bearer ${this.token}`;

		const res = await fetch(path, {
			method,
			headers,
			body: formData,
		});
		if (!res.ok) throw await this.extractError(res);
		const json = await res.json();
		return json.data !== undefined ? json.data : json;
	}
}

export const api = new ApiClient();
