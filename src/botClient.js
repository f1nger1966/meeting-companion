/**
 * botClient.js — HTTP client for the self-hosted meeting-bot-core container.
 *
 * Drop-in replacement for recallClient.js with the same exported interface.
 *
 * Bot API (screenappai/meeting-bot):
 *   POST /google/join      — join a Google Meet (fire-and-forget, returns 202)
 *   POST /microsoft/join   — join a Teams meeting
 *   POST /zoom/join        — join a Zoom meeting
 *   GET  /isbusy           — {success:true, data: 0|1}
 *   GET  /health           — health check
 *
 * No per-bot status or delete endpoint. The bot manages its own lifecycle.
 * Recording completion is notified via webhook to /webhook/bot.
 *
 * Environment variables:
 *   BOT_SERVICE_URL    Base URL of the deployed meeting-bot-core container
 *   BOT_BEARER_TOKEN   Shared token sent in bot join requests (any non-empty string)
 */

'use strict';

const crypto = require('crypto');
const axios  = require('axios');

const BOT_SERVICE_URL = process.env.BOT_SERVICE_URL || 'http://localhost:3000';

const client = axios.create({
  baseURL: BOT_SERVICE_URL,
  headers: { 'Content-Type': 'application/json' },
  timeout: 15000,
});

// ── Platform detection ────────────────────────────────────────────────────────
function detectPlatform(meetingUrl) {
  if (/meet\.google\.com/i.test(meetingUrl))  return 'google_meet';
  if (/zoom\.us/i.test(meetingUrl))           return 'zoom';
  return 'teams';
}

// ── Bot lifecycle ─────────────────────────────────────────────────────────────

/**
 * Send a bot into a meeting.
 * Generates a UUID botId, POSTs to the platform-specific /join endpoint,
 * and returns the botId immediately (bot runs asynchronously in the container).
 */
async function createBot(meetingUrl, botName = 'Meeting Notes Bot', webhookUrl, joinAt = null) {
  const platform = detectPlatform(meetingUrl);
  const botId    = crypto.randomUUID();

  const endpoint = platform === 'google_meet' ? '/google/join'
    : platform === 'zoom'                      ? '/zoom/join'
    :                                            '/microsoft/join';

  const payload = {
    bearerToken: process.env.BOT_BEARER_TOKEN || 'meeting-companion',
    url:         meetingUrl,
    name:        botName,
    teamId:      'meeting-companion',   // logical group identifier
    timezone:    'UTC',
    userId:      'companion-server',    // originating service identity
    botId,
  };

  const response = await client.post(endpoint, payload);

  if (!response.data.success) {
    throw new Error(response.data.error || 'Bot service rejected the join request');
  }

  // Bot is single-job: if busy the container returns 409
  console.log(`[BOT CLIENT] ${platform} bot accepted — botId=${botId}`);
  return { id: botId, status: 'created', meeting_url: meetingUrl, platform };
}

/**
 * Get current status of a bot.
 * The bot container has no per-bot status endpoint — we check /isbusy
 * for general availability and rely on Firestore for per-bot state.
 */
async function getBot(botId) {
  try {
    const response = await client.get('/isbusy');
    return {
      id:             botId,
      status_changes: [],
      isBusy:         !!response.data.data,
    };
  } catch (err) {
    console.warn('[BOT CLIENT] getBot /isbusy failed:', err.message);
    return { id: botId, status_changes: [] };
  }
}

/**
 * List all bots — not available in the bot container API.
 * Meeting history comes from Firestore via db.getAllBotRecords().
 */
async function listBots() {
  return { results: [] };
}

/**
 * Instruct a bot to leave. The container manages its own lifecycle
 * (inactivity timeout, meeting end). No remote leave endpoint exists.
 */
async function leaveBot(botId) {
  console.warn('[BOT CLIENT] leaveBot() — bot manages its own lifecycle. No remote endpoint.');
  return { ok: true };
}

/**
 * Delete a bot from the bot service. No remote delete endpoint exists;
 * the bot exits when the meeting ends. Firestore cleanup is handled by server.js.
 */
async function deleteBot(botId) {
  console.warn('[BOT CLIENT] deleteBot() — no remote endpoint. Firestore record updated by server.js.');
}

// ── Media retrieval ───────────────────────────────────────────────────────────
// Recordings are uploaded directly to GCS by the bot container.
// The webhook handler in server.js stores the GCS storage key in Firestore.
// server.js then generates fresh signed URLs from firebaseClient.getSignedUrl().

/**
 * Get transcript — stored inline in Firestore transcriptLines[] by the webhook handler.
 */
async function getBotTranscript(botId) {
  const { getBotRecord } = require('./db');
  const record = await getBotRecord(botId);
  return record?.transcriptLines || [];
}

/**
 * Get a fresh signed URL for the bot's GCS recording.
 * Falls back to storageKey → firebaseClient.getSignedUrl() in server.js.
 */
async function getBotRecordingUrl(botId) {
  const { getBotRecord } = require('./db');
  const record = await getBotRecord(botId);
  return record?.recordingUrl || null;
}

module.exports = {
  createBot,
  getBot,
  listBots,
  leaveBot,
  deleteBot,
  getBotTranscript,
  getBotRecordingUrl,
};
