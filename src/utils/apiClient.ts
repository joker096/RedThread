import { Capacitor } from '@capacitor/core';
import { KeychainAccess, SecureStorage } from '@aparajita/capacitor-secure-storage';

type MobilePlatform = 'android' | 'ios';

interface MobileDeviceContext {
  platform: MobilePlatform;
  deviceId: string;
  deviceName: string;
}

interface MobileSessionPayload {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

type RefreshResult = 'refreshed' | 'invalid' | 'unavailable';

const REFRESH_TOKEN_KEY = 'vow.auth.refresh-token';
const DEVICE_ID_KEY = 'vow.auth.device-id';
const ACCESS_REFRESH_SKEW_MS = 60_000;
const AUTH_ENDPOINT = /^\/api\/mobile\/auth\/(?:login|register|verify-email|email-verification\/resend|password-reset\/(?:request|complete))$/;

const nativePlatform = Capacitor.getPlatform();
const isNative = Capacitor.isNativePlatform() &&
  (nativePlatform === 'android' || nativePlatform === 'ios');

let accessToken: string | null = null;
let accessTokenExpiresAt = 0;
let refreshInFlight: Promise<RefreshResult> | null = null;
let nativeFetch: typeof fetch | null = null;
let transportInstalled = false;

function apiBaseUrl(): string {
  const configured = (import.meta.env.VITE_API_BASE_URL || '').trim();
  if (!configured) throw new Error('mobile_api_base_url_not_configured');

  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error('mobile_api_base_url_invalid');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username || parsed.password || parsed.search || parsed.hash ||
      parsed.pathname !== '/') {
    throw new Error('mobile_api_base_url_invalid');
  }
  const insecureMobileDevelopment =
    import.meta.env.MODE === 'mobile-dev' &&
    import.meta.env.VITE_ALLOW_INSECURE_API === 'true';
  if (parsed.protocol !== 'https:' && import.meta.env.PROD && !insecureMobileDevelopment) {
    throw new Error('mobile_api_https_required');
  }
  return parsed.origin;
}

function apiPathFrom(input: RequestInfo | URL): string | null {
  const raw = input instanceof Request ? input.url : String(input);
  try {
    const parsed = new URL(raw, typeof window === 'undefined' ? 'https://localhost' : window.location.href);
    return parsed.pathname === '/api' || parsed.pathname.startsWith('/api/')
      ? parsed.pathname + parsed.search
      : null;
  } catch {
    return null;
  }
}

function nativeApiUrl(path: string): string {
  return new URL(path, apiBaseUrl() + '/').toString();
}

function dispatchSessionExpired(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('vow:session-expired'));
  }
}

async function secureGetString(key: string): Promise<string | null> {
  const value = await SecureStorage.get(key, false, false);
  return typeof value === 'string' ? value : null;
}

async function secureSetString(key: string, value: string): Promise<void> {
  await SecureStorage.set(
    key,
    value,
    true,
    false,
    KeychainAccess.whenUnlockedThisDeviceOnly
  );
}

async function secureRemove(key: string): Promise<void> {
  await SecureStorage.remove(key, false);
}

export function isNativeVowApp(): boolean {
  return isNative;
}

function createDeviceUuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0'));
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join('')
  ].join('-');
}

export async function getMobileDeviceContext(): Promise<MobileDeviceContext> {
  if (!isNative) throw new Error('native_device_context_unavailable');
  const platform = nativePlatform as MobilePlatform;
  let deviceId = await secureGetString(DEVICE_ID_KEY);
  if (!deviceId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId)) {
    deviceId = createDeviceUuid();
    await secureSetString(DEVICE_ID_KEY, deviceId);
  }
  return {
    platform,
    deviceId,
    deviceName: platform === 'android' ? 'Vow Android device' : 'Vow iOS device'
  };
}

export async function clearMobileSession(): Promise<void> {
  accessToken = null;
  accessTokenExpiresAt = 0;
  try {
    if (isNative) await secureRemove(REFRESH_TOKEN_KEY);
  } catch (error) {
    console.error('Could not clear the secure mobile session store:', error);
  }
}

async function persistMobileSession(payload: MobileSessionPayload): Promise<void> {
  if (!isNative ||
      typeof payload.accessToken !== 'string' ||
      !payload.accessToken.startsWith('vow_access_') ||
      typeof payload.refreshToken !== 'string' ||
      !payload.refreshToken.startsWith('vow_refresh_')) {
    throw new Error('invalid_mobile_session_response');
  }
  const expiry = Date.parse(payload.accessTokenExpiresAt);
  const refreshExpiry = Date.parse(payload.refreshTokenExpiresAt);
  if (!Number.isFinite(expiry) || !Number.isFinite(refreshExpiry) ||
      refreshExpiry <= Date.now() || expiry <= Date.now()) {
    throw new Error('invalid_mobile_session_expiry');
  }
  // Persist refresh credentials before publishing the in-memory access token.
  await secureSetString(REFRESH_TOKEN_KEY, payload.refreshToken);
  accessToken = payload.accessToken;
  accessTokenExpiresAt = expiry;
}

export async function saveMobileSession(payload: MobileSessionPayload): Promise<void> {
  await persistMobileSession(payload);
}

async function performRefresh(): Promise<RefreshResult> {
  let refreshToken: string | null;
  let device: MobileDeviceContext;
  try {
    refreshToken = await secureGetString(REFRESH_TOKEN_KEY);
    if (!refreshToken) return 'invalid';
    device = await getMobileDeviceContext();
    const response = await (nativeFetch || globalThis.fetch.bind(globalThis))(nativeApiUrl('/api/mobile/auth/refresh'), {
      method: 'POST',
      credentials: 'omit',
      headers: {
        Authorization: `Bearer ${refreshToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(device)
    });
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      await clearMobileSession();
      dispatchSessionExpired();
      return 'invalid';
    }
    if (!response.ok) return 'unavailable';
    const payload = await response.json() as MobileSessionPayload;
    await persistMobileSession(payload);
    return 'refreshed';
  } catch (error) {
    console.error('Mobile session refresh unavailable:', error);
    return 'unavailable';
  }
}

async function refreshMobileSession(): Promise<RefreshResult> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = performRefresh();
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

async function restoreMobileSession(): Promise<RefreshResult> {
  if (!isNative) return 'invalid';
  if (accessToken && accessTokenExpiresAt > Date.now() + ACCESS_REFRESH_SKEW_MS) {
    return 'refreshed';
  }
  return refreshMobileSession();
}

function createNativeRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  token: string | null
): Request {
  const source = input instanceof Request ? input : null;
  const path = apiPathFrom(input);
  if (!path) throw new Error('not_a_vow_api_request');
  const headers = new Headers(source?.headers);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  if (token) headers.set('Authorization', `Bearer ${token}`);
  else headers.delete('Authorization');

  const method = init?.method || source?.method || 'GET';
  const body = init?.body !== undefined ? init.body : source?.body;
  return new Request(nativeApiUrl(path), {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : body,
    credentials: 'omit',
    cache: init?.cache || source?.cache || 'default',
    redirect: init?.redirect || source?.redirect || 'follow',
    referrer: init?.referrer || source?.referrer || 'about:client',
    referrerPolicy: init?.referrerPolicy || source?.referrerPolicy || 'strict-origin-when-cross-origin',
    integrity: init?.integrity || source?.integrity || '',
    keepalive: init?.keepalive ?? source?.keepalive ?? false,
    signal: init?.signal || source?.signal
  });
}

export async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  if (!isNative) return globalThis.fetch(input, init);
  const transport = nativeFetch || globalThis.fetch.bind(globalThis);
  const path = apiPathFrom(input);
  if (!path) return transport(input, init);

  const authEndpoint = AUTH_ENDPOINT.test(path.split('?', 1)[0]);
  if (!authEndpoint && (!accessToken || accessTokenExpiresAt <= Date.now() + ACCESS_REFRESH_SKEW_MS)) {
    const restored = await restoreMobileSession();
    if (restored === 'unavailable') {
      return new Response(JSON.stringify({ error: 'session_refresh_unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  const request = createNativeRequest(input, init, accessToken);
  let response = await transport(request.clone());

  if (response.status === 401 && accessToken && !authEndpoint) {
    const refreshed = await refreshMobileSession();
    if (refreshed === 'refreshed' && accessToken) {
      const headers = new Headers(request.headers);
      headers.set('Authorization', `Bearer ${accessToken}`);
      response = await transport(new Request(request, { headers }));
    } else if (refreshed === 'unavailable') {
      return new Response(JSON.stringify({ error: 'session_refresh_unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
  return response;
}

export async function mobileAuthFetch(
  action: string,
  payload: Record<string, unknown>
): Promise<Response> {
  if (!isNative) throw new Error('mobile_auth_unavailable_on_web');
  const body = ['login', 'register'].includes(action)
    ? { ...payload, ...(await getMobileDeviceContext()) }
    : payload;
  try {
    const response = await apiFetch(`/api/mobile/auth/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (response.ok) {
      const result = await response.clone().json().catch(() => null);
      if (result?.accessToken && result?.refreshToken) {
        await persistMobileSession(result as MobileSessionPayload);
      }
    }
    return response;
  } finally {
    if (action === 'logout' || action === 'logout-all') {
      await clearMobileSession();
    }
  }
}

export function installNativeApiTransport(): void {
  if (!isNative || transportInstalled || typeof window === 'undefined') return;
  nativeFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    apiFetch(input, init)) as typeof window.fetch;
  transportInstalled = true;
}
