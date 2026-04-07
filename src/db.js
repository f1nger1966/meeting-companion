/**
 * db.js — Firestore persistence layer.
 *
 * Drop-in replacement for the SQLite db.js from recall-ai-teams-bot.
 * Exports the same interface so server.js requires no changes beyond
 * removing the --experimental-sqlite flag.
 *
 * Collections:
 *   bots/{botId}   — one document per bot, mirrors the old bot_records table
 *   users/{email}  — one document per authenticated user
 *
 * Composite indexes required in Firestore console before queries work:
 *   bots:  userEmail ASC, createdAt DESC
 *   bots:  status ASC, createdAt DESC   (admin panel)
 *
 * Required env vars: same as firebaseClient.js
 *   FIREBASE_SERVICE_ACCOUNT  (single JSON blob, easiest for Railway)
 *   OR  FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY
 */

let admin;
let db;
let initialized = false;

function init() {
  if (initialized) return;
  try { admin = require('firebase-admin'); } catch {
    throw new Error('firebase-admin not installed. Run: npm install firebase-admin');
  }

  if (admin.apps.length > 0) {
    db = admin.firestore();
    initialized = true;
    return;
  }

  let credential;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    credential = admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT));
  } else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    credential = admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    });
  } else {
    throw new Error('Firebase credentials not configured. Set FIREBASE_SERVICE_ACCOUNT or individual vars.');
  }

  admin.initializeApp({
    credential,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  });

  db = admin.firestore();
  initialized = true;
  console.log('[DB] Firestore connected — project:', process.env.FIREBASE_PROJECT_ID || 'from service account');
}

// ── Bot record API ────────────────────────────────────────────────────────────

/**
 * Upsert a bot record, merging incoming data with the existing document.
 * Mirrors the SQLite saveBotRecord() merge behaviour exactly.
 */
async function saveBotRecord(botId, data) {
  init();
  const now = new Date().toISOString();
  const ref = db.collection('bots').doc(botId);
  // Use merge:true so partial updates don't wipe existing fields
  await ref.set({ ...data, botId, updatedAt: now }, { merge: true });
}

/**
 * Get a single bot record by ID.
 * @returns {object|null}
 */
async function getBotRecord(botId) {
  init();
  const doc = await db.collection('bots').doc(botId).get();
  return doc.exists ? doc.data() : null;
}

/**
 * Get all bot records, ordered by most recent update.
 * @returns {object[]}
 */
async function getAllBotRecords() {
  init();
  const snap = await db.collection('bots').orderBy('updatedAt', 'desc').get();
  return snap.docs.map(d => d.data());
}

// ── User registry API ─────────────────────────────────────────────────────────

/**
 * Upsert a user record. firstName is preserved if not supplied.
 */
async function registerUser(email, firstName, active) {
  if (!email) return;
  init();
  const now = new Date().toISOString();
  const ref = db.collection('users').doc(email);
  const existing = (await ref.get()).data() || {};
  await ref.set({
    email,
    firstName:  firstName || existing.firstName || null,
    firstSeen:  existing.firstSeen  || now,
    lastSeen:   now,
    active:     !!active,
  }, { merge: true });
}

/**
 * Get a user record by email.
 * @returns {object|null}
 */
async function getUser(email) {
  init();
  const doc = await db.collection('users').doc(email).get();
  return doc.exists ? doc.data() : null;
}

/**
 * Get all users.
 * @returns {object[]}
 */
async function getAllUsers() {
  init();
  const snap = await db.collection('users').get();
  return snap.docs.map(d => d.data());
}

/**
 * Seed the in-memory userRegistry Map from Firestore on startup.
 * NOTE: This is now async (Firestore reads are async).
 * server.js calls this with await during startup.
 */
async function seedUserRegistry(registryMap) {
  const users = await getAllUsers();
  for (const user of users) {
    registryMap.set(user.email, user);
  }
  console.log(`[DB] Seeded ${users.length} users from Firestore`);
}

module.exports = {
  saveBotRecord,
  getBotRecord,
  getAllBotRecords,
  registerUser,
  getUser,
  getAllUsers,
  seedUserRegistry,
};
