const crypto = require('crypto');

// AES-256-GCM encryption for sensitive identifiers stored on the Seller
// document (Aadhaar number, bank account number). Values are stored as
// "enc:v1:<iv>:<tag>:<ciphertext>" (base64 parts) so encrypted and legacy
// plaintext values can be told apart during migration.
const PREFIX = 'enc:v1:';

let warned = false;
function getKey() {
  if (process.env.FIELD_ENCRYPTION_KEY) {
    const key = Buffer.from(process.env.FIELD_ENCRYPTION_KEY, 'base64');
    if (key.length === 32) return key;
    console.error('[fieldCrypto] FIELD_ENCRYPTION_KEY must be 32 bytes, base64-encoded — falling back to a JWT_SECRET-derived key');
  } else if (!warned) {
    warned = true;
    console.warn('[fieldCrypto] FIELD_ENCRYPTION_KEY not set — deriving the encryption key from JWT_SECRET');
  }
  return crypto.createHash('sha256').update(`field-encryption:${process.env.JWT_SECRET || ''}`).digest();
}

const isEncrypted = (value) => typeof value === 'string' && value.startsWith(PREFIX);

function encrypt(plain) {
  if (plain == null || plain === '' || isEncrypted(plain)) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${data.toString('base64')}`;
}

function decrypt(value) {
  if (!isEncrypted(value)) return value;
  try {
    const [ivB64, tagB64, dataB64] = value.slice(PREFIX.length).split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch (err) {
    console.error('[fieldCrypto] failed to decrypt a value (wrong key?)', err.message);
    return null;
  }
}

// "XXXXXXXX1234" — enough for a seller/admin to recognise which account it
// is without exposing the full number in every API response.
function mask(value, visible = 4) {
  const plain = decrypt(value);
  if (!plain) return plain;
  const digits = String(plain);
  if (digits.length <= visible) return digits;
  return 'X'.repeat(digits.length - visible) + digits.slice(-visible);
}

const isMasked = (value) => typeof value === 'string' && /^X+[0-9A-Za-z]{0,4}$/.test(value);

module.exports = { encrypt, decrypt, mask, isMasked, isEncrypted };
