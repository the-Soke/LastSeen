const crypto = require('crypto');

const COOKIE_NAME = 'lastseen_auth';

function b64urlEncode(value) {
  return Buffer.from(value).toString('base64url');
}

function b64urlDecode(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function hmac(content, secret) {
  return crypto.createHmac('sha256', secret).update(content).digest('base64url');
}

function getSecret() {
  return process.env.AUTH_SECRET || 'dev-auth-secret-change-me';
}

function signToken(payload) {
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = hmac(body, getSecret());
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.', 2);
  const expected = hmac(body, getSecret());
  const sigBuf = Buffer.from(sig || '');
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
  const data = JSON.parse(b64urlDecode(body));
  if (!data?.uid || !data?.exp) return null;
  if (Date.now() > Number(data.exp)) return null;
  return data;
}

function parseCookie(req, name) {
  const raw = req.headers.cookie || '';
  const parts = raw.split(';').map((p) => p.trim());
  for (const p of parts) {
    const idx = p.indexOf('=');
    if (idx === -1) continue;
    const key = p.slice(0, idx);
    const val = p.slice(idx + 1);
    if (key === name) return decodeURIComponent(val);
  }
  return null;
}

function buildAuthCookie(token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${60 * 60 * 24 * 7}`;
}

function clearAuthCookie() {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=0`;
}

module.exports = {
  COOKIE_NAME,
  signToken,
  verifyToken,
  parseCookie,
  buildAuthCookie,
  clearAuthCookie,
};
