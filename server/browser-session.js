export const BROWSER_SESSION_COOKIE = 'ddz_browser_session';

export function browserSessionToken(cookieHeader) {
  const cookies = String(cookieHeader || '').split(';');
  for (const cookie of cookies) {
    const separator = cookie.indexOf('=');
    if (separator < 0) continue;
    const name = cookie.slice(0, separator).trim();
    if (name !== BROWSER_SESSION_COOKIE) continue;
    const value = cookie.slice(separator + 1).trim();
    return /^[A-Za-z0-9_-]{32,128}$/.test(value) ? value : '';
  }
  return '';
}

export function browserSessionCookie(token, secure = true) {
  const attributes = [
    `${BROWSER_SESSION_COOKIE}=${token}`,
    'Path=/',
    'Max-Age=2592000',
    'HttpOnly',
    'SameSite=Lax'
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

export function browserPlayerResult(result) {
  const { seatSessionToken, reconnectCode: _legacyReconnectCode, ...body } = result;
  return { body, token: seatSessionToken || '' };
}
