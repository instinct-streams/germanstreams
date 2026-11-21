// Minimal HTTP helpers on top of global fetch. Zero dependencies.

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DEFAULT_HEADERS = {
  'User-Agent': USER_AGENT,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
  'Accept-Language': 'de-DE,de;q=0.9,en;q=0.7',
};

export class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const buildInit = ({ headers, method, body, timeoutMs }) => ({
  method: method ?? 'GET',
  body,
  redirect: 'manual',
  signal: AbortSignal.timeout(timeoutMs ?? 10_000),
  headers: { ...DEFAULT_HEADERS, ...headers },
});

// Follow redirects ourselves: some source sites chain 15+ hops (domain rotation),
// which exceeds undici's built-in limit.
export const fetchResponse = async (url, options = {}) => {
  let current = url;
  let { method, body } = options;
  for (let hop = 0; hop < 30; hop++) {
    const response = await fetch(current, buildInit({ ...options, method, body }));
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    if (response.status !== 307 && response.status !== 308) {
      method = 'GET';
      body = undefined;
    }
    current = new URL(location, current).href;
  }
  throw new HttpError(`redirect loop: ${url}`, 0);
};

export const fetchText = async (url, options = {}) => {
  const response = await fetchResponse(url, options);
  if (!response.ok) {
    throw new HttpError(`GET ${url} -> HTTP ${response.status}`, response.status);
  }
  const text = await response.text();
  return { text, finalUrl: response.url };
};

export const fetchJson = async (url, options = {}) => {
  const response = await fetchResponse(url, {
    ...options,
    headers: { Accept: 'application/json', ...options.headers },
  });
  if (!response.ok) {
    throw new HttpError(`JSON ${url} -> HTTP ${response.status}`, response.status);
  }
  return { json: await response.json(), finalUrl: response.url };
};

export const postForm = async (url, formFields, options = {}) => {
  const body = new URLSearchParams(formFields).toString();
  return fetchText(url, {
    ...options,
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...options.headers },
  });
};

export const postJson = async (url, payload, options = {}) => {
  const response = await fetchResponse(url, {
    ...options,
    method: 'POST',
    body: JSON.stringify(payload),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...options.headers },
  });
  if (!response.ok) {
    throw new HttpError(`POST ${url} -> HTTP ${response.status}`, response.status);
  }
  return { json: await response.json(), finalUrl: response.url };
};
