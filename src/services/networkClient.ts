/**
 * Minimal fetch-based NetworkClient for @sudobility/sudojo_client.
 *
 * The bot has no DI container, so this is the smallest implementation of the
 * `NetworkClient` interface from @sudobility/types that SudojoClient needs:
 * JSON in, JSON out, with an AbortController timeout.
 */

import {
  NetworkError,
  type NetworkClient,
  type NetworkRequestOptions,
  type NetworkResponse,
} from '@sudobility/types';

const DEFAULT_TIMEOUT_MS = 30000;

/** Fetch-based NetworkClient used by SudojoClient. */
export class FetchNetworkClient implements NetworkClient {
  private defaultTimeout: number;

  constructor(defaultTimeout: number = DEFAULT_TIMEOUT_MS) {
    this.defaultTimeout = defaultTimeout;
  }

  async request<T = unknown>(
    url: string,
    options: NetworkRequestOptions = {}
  ): Promise<NetworkResponse<T>> {
    const { method = 'GET', headers, body, signal } = options;
    const timeout = options.timeout ?? this.defaultTimeout;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const init: RequestInit = {
        method: method ?? 'GET',
        signal: signal ?? controller.signal,
      };
      if (headers) {
        init.headers = headers;
      }
      if (body) {
        init.body = body;
      }

      const response = await fetch(url, init);

      // sudojo_api answers JSON; parse it even when the content type is vague.
      const text = await response.text();
      let data: T;
      try {
        data = (text ? JSON.parse(text) : undefined) as T;
      } catch {
        data = text as T;
      }

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      if (!response.ok) {
        let message = `HTTP ${response.status}: ${response.statusText}`;
        if (data && typeof data === 'object') {
          const detail =
            (data as { error?: unknown; message?: unknown }).error ??
            (data as { message?: unknown }).message;
          if (typeof detail === 'string') {
            message += ` - ${detail}`;
          }
        }
        throw new NetworkError(message, response.status, response.statusText, data);
      }

      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        data,
        headers: responseHeaders,
        success: response.ok,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      if (error instanceof NetworkError) {
        throw error;
      }
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new NetworkError('Request timeout', 408, 'Request Timeout');
        }
        throw new NetworkError(error.message, 0, 'Network Error');
      }
      throw new NetworkError('Unknown network error', 0, 'Unknown Error');
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async get<T = unknown>(
    url: string,
    options: Omit<NetworkRequestOptions, 'method' | 'body'> = {}
  ): Promise<NetworkResponse<T>> {
    return this.request<T>(url, { ...options, method: 'GET' });
  }

  async post<T = unknown>(
    url: string,
    body?: unknown,
    options: Omit<NetworkRequestOptions, 'method'> = {}
  ): Promise<NetworkResponse<T>> {
    return this.request<T>(url, {
      ...options,
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', ...options.headers },
    });
  }

  async put<T = unknown>(
    url: string,
    body?: unknown,
    options: Omit<NetworkRequestOptions, 'method'> = {}
  ): Promise<NetworkResponse<T>> {
    return this.request<T>(url, {
      ...options,
      method: 'PUT',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', ...options.headers },
    });
  }

  async delete<T = unknown>(
    url: string,
    options: Omit<NetworkRequestOptions, 'method' | 'body'> = {}
  ): Promise<NetworkResponse<T>> {
    return this.request<T>(url, { ...options, method: 'DELETE' });
  }
}
