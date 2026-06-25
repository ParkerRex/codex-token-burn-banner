import crypto from 'node:crypto';
import fs from 'node:fs/promises';

const REQUIRED_ENV = [
  ['X_API_KEY', 'X_POSTING_API_KEY', 'TWITTER_API_KEY'],
  ['X_API_SECRET', 'X_POSTING_API_SECRET', 'TWITTER_API_SECRET'],
  ['X_ACCESS_TOKEN', 'X_POSTING_ACCESS_TOKEN', 'TWITTER_ACCESS_TOKEN'],
  ['X_ACCESS_TOKEN_SECRET', 'X_POSTING_ACCESS_TOKEN_SECRET', 'TWITTER_ACCESS_TOKEN_SECRET'],
];

export function missingXCredentials(env = process.env) {
  return REQUIRED_ENV
    .filter((aliases) => !aliases.some((key) => env[key]))
    .map(([key]) => key);
}

export function getXCredentials(env = process.env) {
  const missing = missingXCredentials(env);
  if (missing.length) {
    throw new Error(`Missing X credentials: ${missing.join(', ')}`);
  }

  const [
    consumerKey,
    consumerSecret,
    token,
    tokenSecret,
  ] = REQUIRED_ENV.map((aliases) => aliases.map((key) => env[key]).find(Boolean));

  return {
    consumerKey,
    consumerSecret,
    token,
    tokenSecret,
  };
}

export async function updateProfileBanner(imagePath, options = {}) {
  const env = options.env ?? process.env;
  const credentials = getXCredentials(env);

  const baseUrl = (env.X_API_BASE_URL ?? 'https://api.x.com').replace(/\/$/, '');
  const url = `${baseUrl}/1.1/account/update_profile_banner.json`;
  const method = 'POST';
  const image = await fs.readFile(imagePath);
  const bodyParams = {
    banner: image.toString('base64'),
    width: '1500',
    height: '500',
    offset_top: '0',
    offset_left: '0',
  };
  const body = new URLSearchParams(bodyParams).toString();
  const authorization = oauthHeader({
    method,
    url,
    bodyParams,
    ...credentials,
  });

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body).toString(),
    },
    body,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`X banner update failed: HTTP ${response.status} ${text.slice(0, 500)}`);
  }
  return {
    status: response.status,
    body: text,
  };
}

export async function uploadTweetImage(imagePath, options = {}) {
  const env = options.env ?? process.env;
  const credentials = getXCredentials(env);

  const uploadBaseUrl = (env.X_UPLOAD_BASE_URL ?? 'https://upload.twitter.com').replace(/\/$/, '');
  const url = `${uploadBaseUrl}/1.1/media/upload.json`;
  const method = 'POST';
  const image = await fs.readFile(imagePath);
  const bodyParams = {
    media_category: 'tweet_image',
    media_data: image.toString('base64'),
  };
  const body = new URLSearchParams(bodyParams).toString();
  const authorization = oauthHeader({
    method,
    url,
    bodyParams,
    ...credentials,
  });

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body).toString(),
    },
    body,
  });

  const responseText = await response.text();
  let json = null;
  try {
    json = responseText ? JSON.parse(responseText) : null;
  } catch {}
  if (!response.ok) {
    throw new Error(`X media upload failed: HTTP ${response.status} ${responseText.slice(0, 500)}`);
  }
  return json;
}

export async function verifyCredentials(options = {}) {
  const env = options.env ?? process.env;
  const credentials = getXCredentials(env);
  const baseUrl = (env.X_API_BASE_URL ?? 'https://api.x.com').replace(/\/$/, '');
  const url = `${baseUrl}/1.1/account/verify_credentials.json?skip_status=true`;
  const method = 'GET';
  const authorization = oauthHeader({
    method,
    url,
    bodyParams: {},
    ...credentials,
  });

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: authorization,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`X credential verification failed: HTTP ${response.status} ${text.slice(0, 500)}`);
  }
  return JSON.parse(text);
}

export async function createTweet(text, options = {}) {
  const env = options.env ?? process.env;
  const credentials = getXCredentials(env);
  const baseUrl = (env.X_API_BASE_URL ?? 'https://api.x.com').replace(/\/$/, '');
  const url = `${baseUrl}/2/tweets`;
  const method = 'POST';
  const payload = { text };
  if (options.mediaIds?.length) {
    payload.media = { media_ids: options.mediaIds.map(String) };
  }
  const body = JSON.stringify(payload);
  const authorization = oauthHeader({
    method,
    url,
    bodyParams: {},
    ...credentials,
  });

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body).toString(),
    },
    body,
  });
  const responseText = await response.text();
  let json = null;
  try {
    json = responseText ? JSON.parse(responseText) : null;
  } catch {}
  if (!response.ok) {
    throw new Error(`X tweet failed: HTTP ${response.status} ${responseText.slice(0, 500)}`);
  }
  return json;
}

export function oauthHeader(input) {
  const oauthParams = {
    oauth_consumer_key: input.consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: input.token,
    oauth_version: '1.0',
  };
  const signatureParams = {
    ...input.bodyParams,
    ...queryParams(input.url),
    ...oauthParams,
  };
  const signatureBase = [
    input.method.toUpperCase(),
    percentEncode(normalizeUrl(input.url)),
    percentEncode(normalizeParams(signatureParams)),
  ].join('&');
  const signingKey = `${percentEncode(input.consumerSecret)}&${percentEncode(input.tokenSecret)}`;
  const signature = crypto
    .createHmac('sha1', signingKey)
    .update(signatureBase)
    .digest('base64');

  return 'OAuth ' + Object.entries({ ...oauthParams, oauth_signature: signature })
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${percentEncode(key)}="${percentEncode(value)}"`)
    .join(', ');
}

function normalizeUrl(urlValue) {
  const url = new URL(urlValue);
  url.search = '';
  url.hash = '';
  return url.toString();
}

function queryParams(urlValue) {
  const url = new URL(urlValue);
  const params = {};
  for (const [key, value] of url.searchParams.entries()) {
    if (params[key] === undefined) {
      params[key] = value;
    } else if (Array.isArray(params[key])) {
      params[key].push(value);
    } else {
      params[key] = [params[key], value];
    }
  }
  return params;
}

function normalizeParams(params) {
  return Object.entries(params)
    .flatMap(([key, value]) => {
      if (Array.isArray(value)) return value.map((item) => [key, item]);
      return [[key, value]];
    })
    .map(([key, value]) => [percentEncode(key), percentEncode(value)])
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => (
      leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey)
    ))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

function percentEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}
