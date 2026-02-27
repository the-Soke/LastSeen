// server/src/api/middlewares/uploadHandler.js
// ─────────────────────────────────────────────────────────────────────────────
//  Handles base64 photo payloads from the PWA form.
//  In development:  saves to local disk under /uploads/
//  In production:   uploads to S3-compatible storage (MinIO, AWS, Cloudflare R2)
//
//  Never stores the raw image path in a public-facing field without the hash.
//  All stored images use UUID filenames (no original filename from client).
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const UPLOAD_DIR = path.join(__dirname, '../../../../uploads');
const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5MB
const ALLOWED_MIMES  = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];

/**
 * Upload a base64-encoded image.
 * @param {string} base64String  - Full data URI: "data:image/jpeg;base64,..."
 * @param {string} storagePath   - Relative path hint, e.g. "reports/uuid"
 * @returns {{ url: string, hash: string }}
 */
async function uploadPhoto(base64String, storagePath) {
  // 1. Parse data URI
  const matches = String(base64String).match(
    /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+)(?:;[^,]*)?;base64,(.+)$/
  );
  if (!matches) throw new Error('Invalid base64 image format.');

  const mimeType = matches[1];
  const buffer   = Buffer.from(matches[2], 'base64');

  // 2. Validate
  if (!ALLOWED_MIMES.includes(mimeType)) {
    throw new Error(`Image type '${mimeType}' is not allowed.`);
  }
  if (buffer.length > MAX_SIZE_BYTES) {
    throw new Error('Image exceeds 5MB limit.');
  }

  // 3. Compute SHA-256 hash (for deduplication, not identification)
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');

  // 4. Determine extension
  const ext = mimeType.split('/')[1].replace('jpeg', 'jpg');
  const filename = `${hash}.${ext}`;

  let url;

  if (process.env.STORAGE_DRIVER === 's3') {
    url = await uploadToS3(buffer, filename, mimeType);
  } else {
    url = await saveToLocalDisk(buffer, filename);
  }

  return { url, hash };
}

// ─── Local disk (development) ─────────────────────────────────────────────────
async function saveToLocalDisk(buffer, filename) {
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    console.info('[Upload] Created uploads dir:', UPLOAD_DIR);
  }
  const filePath = path.join(UPLOAD_DIR, filename);
  fs.writeFileSync(filePath, buffer);
  console.info('[Upload] Saved photo to local disk:', filePath);
  return `/uploads/${filename}`;
}

// ─── S3-compatible (production) ───────────────────────────────────────────────
async function uploadToS3(buffer, filename, mimeType) {
  // Requires: npm install @aws-sdk/client-s3
  const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
  if (!process.env.S3_ACCESS_KEY || !process.env.S3_SECRET_KEY) {
    throw new Error('S3 credentials are missing. Set S3_ACCESS_KEY and S3_SECRET_KEY.');
  }

  const client = new S3Client({
    region:   process.env.S3_REGION   || 'us-east-1',
    endpoint: process.env.S3_ENDPOINT || undefined,
    credentials: {
      accessKeyId:     process.env.S3_ACCESS_KEY,
      secretAccessKey: process.env.S3_SECRET_KEY,
    }
  });

  const bucket = process.env.S3_BUCKET || 'lastseen-media';
  const key    = `photos/${filename}`;

  await client.send(new PutObjectCommand({
    Bucket:      bucket,
    Key:         key,
    Body:        buffer,
    ContentType: mimeType,
    // No public-read ACL — all access goes through signed URLs or the Node server
    ServerSideEncryption: 'AES256',
  }));

  const publicBase = String(process.env.S3_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (publicBase) {
    return `${publicBase}/${key}`;
  }

  // Fallback path if no public URL is configured.
  const endpoint = String(process.env.S3_ENDPOINT || '').trim().replace(/\/+$/, '');
  if (endpoint) {
    return `${endpoint}/${bucket}/${key}`;
  }
  return `https://${bucket}.s3.${process.env.S3_REGION || 'us-east-1'}.amazonaws.com/${key}`;
}

module.exports = { uploadPhoto };
