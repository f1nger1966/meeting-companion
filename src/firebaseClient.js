/**
 * firebaseClient.js — Firebase Storage (GCS) client for meeting recordings.
 *
 * Handles upload, signed URL generation, and deletion of recording MP4s
 * and transcript JSON files in Firebase Storage / GCS.
 *
 * In the open-source stack this replaces Recall.ai's S3 storage.
 * Recordings are uploaded here directly by the bot container callback
 * (POST /webhook/bot with event=recording.done).
 *
 * Storage paths:
 *   bots/{botId}/video.mp4
 *   bots/{botId}/transcript.json
 *
 * Required env vars:
 *   FIREBASE_SERVICE_ACCOUNT   JSON blob  OR
 *   FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY
 *   FIREBASE_STORAGE_BUCKET    e.g. your-project.appspot.com
 */

let admin;
let bucket;
let initialized = false;

function init() {
  if (initialized) return;
  try { admin = require('firebase-admin'); } catch {
    throw new Error('firebase-admin not installed. Run: npm install firebase-admin');
  }
  // Reuse existing app if initialised by db.js
  if (admin.apps.length > 0) {
    bucket = admin.storage().bucket();
    initialized = true;
    return;
  }
  // Standalone init (should not normally be reached — db.js inits first)
  let credential;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    credential = admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT));
  } else {
    credential = admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    });
  }
  admin.initializeApp({ credential, storageBucket: process.env.FIREBASE_STORAGE_BUCKET });
  bucket = admin.storage().bucket();
  initialized = true;
}

function isConfigured() {
  return !!(
    process.env.FIREBASE_SERVICE_ACCOUNT ||
    (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY)
  );
}

/**
 * Upload a recording buffer to Firebase Storage.
 * Returns { storagePath, signedUrl } — storagePath is stored in Firestore,
 * signedUrl is the 1-hour access URL returned to the client.
 */
async function uploadRecording(botId, data, filename = 'video.mp4', contentType = 'video/mp4') {
  init();
  const storagePath = `bots/${botId}/${filename}`;
  const file = bucket.file(storagePath);
  await file.save(data, { contentType, resumable: false });

  const [signedUrl] = await file.getSignedUrl({
    action:  'read',
    expires: Date.now() + 60 * 60 * 1000,  // 1 hour
  });

  console.log(`[Firebase] Recording uploaded: ${storagePath}`);
  return { storagePath, signedUrl };
}

/**
 * Generate a fresh signed URL for an existing GCS object.
 * Called by GET /bot/:botId/recording instead of the old Recall.ai pre-signed URL.
 */
async function getSignedUrl(storagePath) {
  init();
  const [url] = await bucket.file(storagePath).getSignedUrl({
    action:  'read',
    expires: Date.now() + 60 * 60 * 1000,  // 1 hour
  });
  return url;
}

/**
 * Delete all storage objects for a bot (MP4 + transcript).
 * Called by DELETE /bot/:botId and the 72-hour auto-cleanup job.
 */
async function deleteBotRecording(botId) {
  init();
  const [files] = await bucket.getFiles({ prefix: `bots/${botId}/` });
  await Promise.all(files.map(f => f.delete()));
  console.log(`[Firebase] Deleted storage for bot ${botId} (${files.length} files)`);
}

/**
 * Download an MP4 from a remote URL (e.g. bot container temp URL) and
 * upload it to Firebase Storage. Called from the recording.done webhook handler.
 */
async function downloadAndStore(botId, sourceUrl, filename = 'video.mp4') {
  const https = require('https');
  const http  = require('http');
  const protocol = sourceUrl.startsWith('https') ? https : http;

  console.log(`[Firebase] Downloading recording for bot ${botId}...`);
  const buffer = await new Promise((resolve, reject) => {
    const chunks = [];
    protocol.get(sourceUrl, res => {
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });

  console.log(`[Firebase] Downloaded ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);
  return uploadRecording(botId, buffer, filename, 'video/mp4');
}

module.exports = {
  isConfigured,
  uploadRecording,
  getSignedUrl,
  deleteBotRecording,
  downloadAndStore,
};
