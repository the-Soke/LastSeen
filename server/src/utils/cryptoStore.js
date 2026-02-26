const crypto = require('crypto');

const PREFIX = 'enc:v1:';

function getKey() {
  const raw = process.env.DATA_ENCRYPTION_KEY || '';
  if (!raw) return null;
  // Accept any input length by hashing to a stable 32-byte key.
  return crypto.createHash('sha256').update(raw).digest();
}

function encryptText(value) {
  if (value === null || value === undefined || value === '') return value;
  const key = getKey();
  if (!key) return value;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(String(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${PREFIX}${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

function decryptText(value) {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return value;
  const key = getKey();
  if (!key) return value;

  const payload = value.slice(PREFIX.length);
  const [ivB64, tagB64, dataB64] = payload.split('.', 3);
  if (!ivB64 || !tagB64 || !dataB64) return value;

  const iv = Buffer.from(ivB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');
  const encrypted = Buffer.from(dataB64, 'base64url');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

module.exports = {
  encryptText,
  decryptText,
};

