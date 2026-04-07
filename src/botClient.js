/**
 * botClient.js — HTTP client for the self-hosted screenappai/meeting-bot container.
 *
 * Drop-in replacement for recallClient.js. Exports the same interface so
 * server.js requires no structural changes beyond the import path.
 *
 * Environment variables:
 *   BOT_SERVICE_URL      Base URL of the deployed screenappai/meeting-bot container
 *                        e.g. https://meeting-bot-core.railway.app
 *
 * TODO (Phase 2): Wire each function to the actual screenappai/meeting-bot REST API.
 * The bot container's API endpoints will differ from Recall.ai's — update the
 * axios calls below once the bot container is deployed and its API is confirmed.
 *
 * Reference: https://github.com/screenappai/meeting-bot
 */

const axios = require('axios');

const BOT_SERVICE_URL = process.env.BOT_SERVICE_URL || 'http://localhost:4000';

const client = axios.create({
  baseURL: BOT_SERVICE_URL,
  headers: { 'Content-Type': 'application/json' },
  timeout: 15000,
});

// ── Platform detection helper ─────────────────────────────────────────────────
// Determines which recording config to request from the bot based on meeting URL.
// Google Meet: no meeting_captions support → video_mixed_layout MP4 only (+ Deepgram if key set)
// Teams / Zoom: native caption API available
function detectPlatform(meetingUrl) {
  if (/meet\.google\.com/i.test(meetingUrl))  return 'google_meet';
  if (/zoom\.us/i.test(meetingUrl))           return 'zoom';
  return 'teams';
}

// ── Bot lifecycle ─────────────────────────────────────────────────────────────

/**
 * Send a bot into a meeting.
 * TODO: Map payload shape to screenappai/meeting-bot's POST /bot endpoint.
 */
async function createBot(meetingUrl, botName = 'Meeting Notes Bot', webhookUrl, joinAt = null) {
  const platform = detectPlatform(meetingUrl);

  const payload = {
    meeting_url:  meetingUrl,
    bot_name:     botName,
    platform,
    webhook_url:  webhookUrl || null,
    join_at:      joinAt    || null,
    // Google Meet requires host recording consent — bot leaves after 120s if not granted
    ...(platform === 'google_meet' ? { consent_timeout_seconds: 120 } : {}),
    // Deepgram transcription for Google Meet if key is configured
    ...(platform === 'google_meet' && process.env.DEEPGRAM_API_KEY
      ? { deepgram_api_key: process.env.DEEPGRAM_API_KEY }
      : {}),
  };

  // TODO: replace stub response with actual API call once bot container is live
  // const response = await client.post('/bot', payload);
  // return response.data;

  console.warn('[BOT CLIENT] createBot() — stub response. Wire to bot container when deployed.');
  const stubId = `stub-${Date.now()}`;
  return { id: stubId, status: 'created', meeting_url: meetingUrl, ...payload };
}

/**
 * Get current status of a bot by ID.
 * TODO: Map to screenappai/meeting-bot's GET /bot/:id endpoint.
 */
async function getBot(botId) {
  // TODO: const response = await client.get(`/bot/${botId}`);
  //       return response.data;
  console.warn('[BOT CLIENT] getBot() — stub. Wire to bot container.');
  return { id: botId, status_changes: [] };
}

/**
 * List all bots.
 * TODO: Map to screenappai/meeting-bot's GET /bot endpoint.
 */
async function listBots() {
  // TODO: const response = await client.get('/bot');
  //       return response.data;
  console.warn('[BOT CLIENT] listBots() — stub. Wire to bot container.');
  return { results: [] };
}

/**
 * Instruct a bot to leave the meeting immediately.
 * TODO: Map to screenappai/meeting-bot's leave endpoint.
 */
async function leaveBot(botId) {
  // TODO: const response = await client.post(`/bot/${botId}/leave`);
  //       return response.data;
  console.warn('[BOT CLIENT] leaveBot() — stub. Wire to bot container.');
  return { ok: true };
}

/**
 * Delete a bot record from the bot service.
 * TODO: Map to screenappai/meeting-bot's DELETE /bot/:id endpoint.
 */
async function deleteBot(botId) {
  // TODO: await client.delete(`/bot/${botId}`);
  console.warn('[BOT CLIENT] deleteBot() — stub. Wire to bot container.');
}

/**
 * deleteRecording kept for API compatibility.
 * In the open-source stack, recordings are in Firebase Storage (GCS) and
 * deleted via firebaseClient.deleteRecording(). This is a no-op stub.
 */
async function deleteRecording(recordingId) {
  console.warn('[BOT CLIENT] deleteRecording() — no-op in open-source stack. Use firebaseClient.');
}

// ── Media retrieval (served from Firebase Storage / Firestore) ─────────────────
// These replace the Recall.ai pre-signed URL pattern.
// The bot container uploads recordings directly to GCS; server.js generates
// fresh signed URLs from the stored storageKey rather than asking the bot.

/**
 * Get transcript for a bot.
 * In the open-source stack, transcripts are stored inline in the Firestore
 * bot record (transcriptLines[]). This function retrieves them from there.
 * TODO: Replace with Firestore lookup once db.js Firestore migration is complete.
 */
async function getBotTranscript(botId) {
  const { getBotRecord } = require('./db');
  const record = await getBotRecord(botId);
  return record?.transcriptLines || [];
}

/**
 * Get a fresh signed URL for a bot's recording from Firebase Storage.
 * TODO: Generate GCS signed URL from record.storageKey once storage migration complete.
 */
async function getBotRecordingUrl(botId) {
  const { getBotRecord } = require('./db');
  const record = await getBotRecord(botId);

  // If we have a GCS storageKey, generate a signed URL (TODO: wire to firebaseClient)
  if (record?.storageKey) {
    // TODO:
    // const { getSignedUrl } = require('./firebaseClient');
    // return getSignedUrl(record.storageKey);
    console.warn('[BOT CLIENT] getBotRecordingUrl() — storageKey found but signed URL not yet wired.');
  }

  return record?.recordingUrl || null;
}

module.exports = {
  createBot,
  getBot,
  listBots,
  leaveBot,
  deleteBot,
  deleteRecording,
  getBotTranscript,
  getBotRecordingUrl,
};
