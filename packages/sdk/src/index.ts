/**
 * Soroban Smart Block Explorer TypeScript SDK
 *
 * Thin fetch wrapper for consuming the Soroban Smart Block Explorer API.
 *
 * Note: Generated type definitions (api.types.ts) are produced by openapi-typescript.
 * Run `npm run generate-types` to generate them against docs/api/openapi.yaml.
 */

export interface ClientConfig {
  baseUrl?: string;
  apiKey?: string;
  bearerToken?: string;
  csrfToken?: string;
  timeout?: number;
  headers?: Record<string, string>;
}

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  params?: Record<string, string | number | boolean | undefined>;
}

export interface ResponseMetadata {
  status: number;
  statusText: string;
  headers: Headers;
  rateLimitLimit?: number;
  rateLimitRemaining?: number;
  rateLimitReset?: number;
  rateLimitTier?: string;
}

export interface ApiResponse<T> {
  data: T;
  meta: ResponseMetadata;
}

export class ExplorerApiClient {
  private baseUrl: string;
  private apiKey?: string;
  private bearerToken?: string;
  private csrfToken?: string;
  private timeout: number;
  private defaultHeaders: Record<string, string>;

  constructor(config: ClientConfig = {}) {
    this.baseUrl = config.baseUrl || 'http://localhost:3001';
    this.apiKey = config.apiKey;
    this.bearerToken = config.bearerToken;
    this.csrfToken = config.csrfToken;
    this.timeout = config.timeout || 30000;
    this.defaultHeaders = {
      'Content-Type': 'application/json',
      ...config.headers,
    };
  }

  /**
   * Fetch a CSRF token from the server.
   * Must be called before making state-changing requests (POST/PATCH/DELETE).
   */
  async fetchCsrfToken(): Promise<{ csrfToken: string }> {
    const response = await this.request<{ csrfToken: string }>('GET', '/api/csrf-token', {
      credentials: 'include',
    });
    this.csrfToken = response.data.csrfToken;
    return response.data;
  }

  /**
   * Make an HTTP request to the API.
   */
  async request<T>(
    method: string,
    endpoint: string,
    options: RequestOptions = {}
  ): Promise<ApiResponse<T>> {
    const url = this.buildUrl(endpoint, options.params);
    const headers = this.buildHeaders(method);
    const fetchOptions: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(this.timeout),
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    };

    let response: Response;
    try {
      response = await fetch(url, fetchOptions);
    } catch (error) {
      if (error instanceof TypeError && error.message.includes('Failed to fetch')) {
        throw new Error(`Network error: ${error.message}`);
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Request timeout after ${this.timeout}ms`);
      }
      throw error;
    }

    const data = await this.parseResponse<T>(response);
    const meta = this.extractMetadata(response);

    if (!response.ok) {
      throw new ApiError(response.status, response.statusText, data, meta);
    }

    return { data, meta };
  }

  /**
   * GET request helper.
   */
  async get<T>(
    endpoint: string,
    options: Omit<RequestOptions, 'body'> = {}
  ): Promise<ApiResponse<T>> {
    return this.request<T>('GET', endpoint, options);
  }

  /**
   * POST request helper.
   */
  async post<T>(
    endpoint: string,
    body?: unknown,
    options: Omit<RequestOptions, 'body'> = {}
  ): Promise<ApiResponse<T>> {
    return this.request<T>('POST', endpoint, { ...options, body });
  }

  /**
   * PATCH request helper.
   */
  async patch<T>(
    endpoint: string,
    body?: unknown,
    options: Omit<RequestOptions, 'body'> = {}
  ): Promise<ApiResponse<T>> {
    return this.request<T>('PATCH', endpoint, { ...options, body });
  }

  /**
   * DELETE request helper.
   */
  async delete<T>(
    endpoint: string,
    options: Omit<RequestOptions, 'body'> = {}
  ): Promise<ApiResponse<T>> {
    return this.request<T>('DELETE', endpoint, options);
  }

  private buildUrl(endpoint: string, params?: Record<string, string | number | boolean | undefined>): string {
    const url = new URL(endpoint, this.baseUrl);
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) {
          url.searchParams.append(key, String(value));
        }
      });
    }
    return url.toString();
  }

  private buildHeaders(method: string): Headers {
    const headers = new Headers(this.defaultHeaders);

    if (this.apiKey) {
      headers.set('X-API-Key', this.apiKey);
    }

    if (this.bearerToken) {
      headers.set('Authorization', `Bearer ${this.bearerToken}`);
    }

    if (['POST', 'PATCH', 'DELETE'].includes(method.toUpperCase()) && this.csrfToken) {
      headers.set('X-CSRF-Token', this.csrfToken);
    }

    return headers;
  }

  private async parseResponse<T>(response: Response): Promise<T> {
    const contentType = response.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      try {
        return (await response.json()) as T;
      } catch {
        throw new Error('Failed to parse JSON response');
      }
    }
    return (await response.text()) as unknown as T;
  }

  private extractMetadata(response: Response): ResponseMetadata {
    return {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      rateLimitLimit: this.parseHeaderAsNumber(response.headers.get('X-RateLimit-Limit')),
      rateLimitRemaining: this.parseHeaderAsNumber(response.headers.get('X-RateLimit-Remaining')),
      rateLimitReset: this.parseHeaderAsNumber(response.headers.get('X-RateLimit-Reset')),
      rateLimitTier: response.headers.get('X-RateLimit-Tier') || undefined,
    };
  }

  private parseHeaderAsNumber(value: string | null): number | undefined {
    if (!value) return undefined;
    const num = parseInt(value, 10);
    return isNaN(num) ? undefined : num;
  }

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  setBearerToken(token: string): void {
    this.bearerToken = token;
  }

  setCsrfToken(token: string): void {
    this.csrfToken = token;
  }
}

/**
 * API error response.
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    public statusText: string,
    public data: unknown,
    public meta: ResponseMetadata
  ) {
    super(`API Error ${status}: ${statusText}`);
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

/**
 * Create a default client instance.
 */
export function createClient(config?: ClientConfig): ExplorerApiClient {
  return new ExplorerApiClient(config);
}

export default ExplorerApiClient;
