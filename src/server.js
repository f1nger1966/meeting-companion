require('dotenv').config();
if (!process.env.SESSION_SECRET) throw new Error('SESSION_SECRET env var is required — generate with: openssl rand -hex 32');

const crypto    = require('crypto');
const express   = require('express');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const session   = require('express-session');
const path      = require('path');

const { createBot, getBot, listBots, leaveBot, deleteBot, getBotTranscript, getBotRecordingUrl } = require('./botClient');
const { saveBotRecord, getBotRecord, getAllBotRecords, registerUser: dbRegisterUser, getAllUsers, seedUserRegistry } = require('./db');
const { generateSummary }  = require('./aiSummary');
const { getAuthUrl, exchangeCodeForTokens, getUpcomingMeetings, getUserFirstName, getUserEmail } = require('./googleCalendar');
const { getSignedUrl, deleteBotRecording, downloadAndStore, isConfigured: firebaseConfigured } = require('./firebaseClient');

const app = express();

// ── Trust Railway / Cloud Run reverse proxy so secure cookies work ────────────
app.set('trust proxy', 1);

// ── HTTP security headers ─────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      scriptSrc:     ["'self'"],
      scriptSrcAttr: ["'unsafe-inline'"],
    },
  },
}));

app.use(express.json());

// ── Session middleware ───────────────────────────────────────────────────────
// TODO Phase 4: replace with @google-cloud/connect-firestore so sessions
// survive container restarts. In-memory is fine for testing.
app.use(session({
  secret:            process.env.SESSION_SECRET,
  resave:            false,
  saveUninitialized: false,
  cookie: {
    secure:   true,
    httpOnly: true,
    sameSite: 'lax',
    maxAge:   7 * 24 * 60 * 60 * 1000,  // 7 days
  },
}));

app.use(express.static(path.join(__dirname, 'public')));

const PORT        = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').toLowerCase();

// ── Rate limiters ─────────────────────────────────────────────────────────────
const botCreateLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests — please wait a moment and try again.' } });
const summaryLimiter   = rateLimit({ windowMs: 60_000, max: 5,  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many summary requests — please wait a moment.' } });

// ── User registry — seeded from Firestore on startup ─────────────────────────
const userRegistry = new Map();

function registerUser(email, firstName, active) {
  const existing = userRegistry.get(email) || {};
  const record = {
    email,
    firstName: firstName || existing.firstName || null,
    firstSeen: existing.firstSeen || new Date().toISOString(),
    lastSeen:  new Date().toISOString(),
    active,
  };
  userRegistry.set(email, record);
  dbRegisterUser(email, firstName, active);  // async, fire-and-forget
}

// ── Auth helpers ──────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.userEmail) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

async function requireAdmin(req, res, next) {
  if (!req.session.userEmail && req.session.googleTokens) {
    try {
      const email = (await getUserEmail(req.session.googleTokens) || '').toLowerCase();
      req.session.userEmail = email;
      if (email) registerUser(email, req.session.firstName, true);
    } catch (e) { console.warn('[ADMIN] Lazy-heal failed:', e.message); }
  }
  if ((req.session.userEmail || '').toLowerCase() !== ADMIN_EMAIL)
    return res.status(403).json({ error: 'Forbidden' });
  next();
}

function deriveFirstName(email) {
  if (!email) return null;
  const local = (email.split('@')[0] || '').split(/[._]/)[0];
  return local ? local.charAt(0).toUpperCase() + local.slice(1).toLowerCase() : null;
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Health check (Railway + Cloud Run) ───────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true }));

// ── Deploy or schedule a bot ──────────────────────────────────────────────────
app.post('/bot/join', requireAuth, botCreateLimiter, async (req, res) => {
  const { meeting_url, bot_name, join_at, meeting_title } = req.body;
  if (!meeting_url) return res.status(400).json({ error: 'meeting_url is required' });

  const firstName      = req.session.firstName || deriveFirstName(req.session.userEmail);
  const defaultBotName = firstName ? `${firstName}'s Bot` : 'Meeting Notes Bot';
  const resolvedBotName = (bot_name && bot_name.trim()) ? bot_name.trim() : defaultBotName;

  try {
    const bot = await createBot(meeting_url, resolvedBotName, WEBHOOK_URL, join_at || null);
    await saveBotRecord(bot.id, {
      botId:        bot.id,
      meetingUrl:   meeting_url,
      botName:      resolvedBotName,
      meetingTitle: (meeting_title && meeting_title.trim()) ? meeting_title.trim() : null,
      userEmail:    req.session.userEmail || 'unknown',
      status:       'created',
      scheduledFor: join_at || null,
      createdAt:    new Date().toISOString(),
    });
    console.log(`[BOT] id=${bot.id} name="${resolvedBotName}"${join_at ? ` scheduled=${join_at}` : ' joining now'}`);
    const message = join_at ? 'BOT_SCHEDULED' : 'Bot is joining the meeting. Admit it from the lobby.';
    res.json({ botId: bot.id, status: 'created', message, scheduledFor: join_at || null, botName: resolvedBotName });
  } catch (err) {
    const msg = err.response?.data || err.message;
    console.error('[BOT CREATE ERROR]', msg);
    res.status(500).json({ error: msg });
  }
});

// ── Get bot status ────────────────────────────────────────────────────────────
app.get('/bot/:botId', requireAuth, async (req, res) => {
  try {
    const [bot, local] = await Promise.all([
      getBot(req.params.botId),
      getBotRecord(req.params.botId),
    ]);
    res.json({ botId: req.params.botId, status: bot.status_changes?.at(-1)?.code, statusHistory: bot.status_changes, ...(local || {}) });
  } catch (err) {
    console.error('[BOT STATUS]', err.message);
    res.status(500).json({ error: 'Failed to fetch bot status.' });
  }
});

// ── Get transcript ────────────────────────────────────────────────────────────
app.get('/bot/:botId/transcript', requireAuth, async (req, res) => {
  const { botId } = req.params;
  const local = await getBotRecord(botId);
  const owner = (local?.userEmail || '').toLowerCase();
  if (owner && owner !== req.session.userEmail.toLowerCase()) return res.status(403).json({ error: 'Access denied.' });
  try {
    const data = await getBotTranscript(botId);
    res.json(data);
  } catch (err) {
    console.error('[TRANSCRIPT]', err.message);
    res.status(500).json({ error: 'Failed to fetch transcript.' });
  }
});

// ── Get fresh recording URL (from Firebase Storage / GCS) ────────────────────
app.get('/bot/:botId/recording', requireAuth, async (req, res) => {
  const { botId } = req.params;
  const local = await getBotRecord(botId);
  const owner = (local?.userEmail || '').toLowerCase();
  if (owner && owner !== req.session.userEmail.toLowerCase()) return res.status(403).json({ error: 'Access denied.' });
  try {
    // Generate a fresh GCS signed URL from the stored storageKey
    if (local?.storageKey && firebaseConfigured()) {
      const url = await getSignedUrl(local.storageKey);
      return res.json({ url });
    }
    // Fallback: ask bot container directly (pre-storage-migration path)
    const url = await getBotRecordingUrl(botId);
    if (!url) return res.status(404).json({ error: 'No recording available yet.' });
    res.json({ url });
  } catch (err) {
    console.error('[RECORDING]', err.message);
    res.status(500).json({ error: 'Failed to fetch recording URL.' });
  }
});

// ── Generate AI summary ───────────────────────────────────────────────────────
app.post('/bot/:botId/summary', requireAuth, summaryLimiter, async (req, res) => {
  const { botId } = req.params;
  const local = await getBotRecord(botId);
  const owner = (local?.userEmail || '').toLowerCase();
  if (owner && owner !== req.session.userEmail.toLowerCase()) return res.status(403).json({ error: 'Access denied.' });
  if (local?.summary) return res.json(local.summary);

  try {
    const transcript = await getBotTranscript(botId);
    const segs = Array.isArray(transcript) ? transcript : (transcript?.results || []);
    const result = await generateSummary(segs);
    if (!result) return res.status(422).json({ error: 'Transcript is empty or too short to summarise.' });
    await saveBotRecord(botId, { summary: result });
    res.json(result);
  } catch (err) {
    console.error('[SUMMARY ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Leave a bot ───────────────────────────────────────────────────────────────
app.post('/bot/:botId/leave', requireAuth, async (req, res) => {
  const { botId } = req.params;
  const local = await getBotRecord(botId);
  const owner = (local?.userEmail || '').toLowerCase();
  if (owner && owner !== req.session.userEmail.toLowerCase()) return res.status(403).json({ error: 'Access denied.' });
  try {
    await leaveBot(botId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Delete a bot ──────────────────────────────────────────────────────────────
app.delete('/bot/:botId', requireAuth, async (req, res) => {
  const { botId } = req.params;
  const local = await getBotRecord(botId);
  const owner = (local?.userEmail || '').toLowerCase();
  const requester = req.session.userEmail.toLowerCase();
  // Only the owner or admin can delete; admin cannot read content but can delete
  if (owner && owner !== requester && requester !== ADMIN_EMAIL)
    return res.status(403).json({ error: 'Access denied.' });

  try {
    // Delete from bot service
    await deleteBot(botId).catch(e => console.warn('[DELETE] Bot service delete failed:', e.message));
    // Delete recordings from Firebase Storage
    if (firebaseConfigured()) {
      await deleteBotRecording(botId).catch(e => console.warn('[DELETE] Storage delete failed:', e.message));
    }
    // Remove Firestore record
    await saveBotRecord(botId, { status: 'deleted', deletedAt: new Date().toISOString() });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── List bots (meeting history) ───────────────────────────────────────────────
app.get('/bots', requireAuth, async (req, res) => {
  const sessionEmail = req.session.userEmail.toLowerCase();
  try {
    const allRecords = await getAllBotRecords();
    const isAdmin = sessionEmail === ADMIN_EMAIL;

    // Filter to records owned by this user (admin sees all)
    const owned = allRecords.filter(r => {
      const owner = (r.userEmail || '').toLowerCase();
      return isAdmin || owner === sessionEmail;
    });

    res.json({ bots: owned });
  } catch (err) {
    console.error('[BOTS LIST]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Webhook receiver — screenappai/meeting-bot events ────────────────────────
app.post('/webhook/bot', (req, res) => {
  // HMAC signature verification (BOT_WEBHOOK_SECRET shared with bot container)
  const webhookSecret = process.env.BOT_WEBHOOK_SECRET;
  if (webhookSecret) {
    const sig      = req.headers['x-bot-signature'];
    const expected = crypto.createHmac('sha256', webhookSecret).update(JSON.stringify(req.body)).digest('hex');
    if (!sig || sig !== expected) {
      console.warn('[WEBHOOK] Signature mismatch — request rejected');
      return res.sendStatus(401);
    }
  }

  const event = req.body;
  const botId = event.bot_id || event.data?.bot_id;
  console.log(`[WEBHOOK] event=${event.event} bot=${botId}`);

  if (!botId) return res.sendStatus(200);

  // Status event map — mirrors the Recall.ai event schema where possible
  const STATUS_EVENT_MAP = {
    'bot.done':                        'done',
    'bot.call_ended':                  'call_ended',
    'bot.fatal':                       'fatal',
    'bot.in_call_recording':           'in_call_recording',
    'bot.in_call_not_recording':       'in_call_not_recording',
    'bot.in_waiting_room':             'in_waiting_room',
    'bot.joining_call':                'joining_call',
    'bot.ready':                       'ready',
    'bot.recording_permission_denied': 'recording_permission_denied',  // Google Meet consent denied
  };

  (async () => {
    try {
      // Status updates
      if (STATUS_EVENT_MAP[event.event]) {
        await saveBotRecord(botId, { status: STATUS_EVENT_MAP[event.event] });
        console.log(`[STATUS] bot=${botId} → ${STATUS_EVENT_MAP[event.event]}`);
      }

      // Live transcript lines (streamed during call)
      if (event.event === 'transcript.data') {
        const words   = event.data?.words || [];
        const speaker = event.data?.speaker || 'Unknown';
        const text    = words.map(w => w.text).join(' ');
        if (text) {
          const record = (await getBotRecord(botId)) || {};
          const lines  = record.transcriptLines || [];
          lines.push({ speaker, text, ts: new Date().toISOString() });
          await saveBotRecord(botId, { transcriptLines: lines });
        }
      }

      // Recording complete — download from bot container and store in GCS
      if (event.event === 'recording.done') {
        await saveBotRecord(botId, { recordingDone: true });
        const recordingUrl = event.data?.recording_url;
        if (recordingUrl && firebaseConfigured()) {
          try {
            const { storagePath } = await downloadAndStore(botId, recordingUrl);
            await saveBotRecord(botId, { storageKey: storagePath, recordingUrl: null });
            console.log(`[WEBHOOK] Recording stored at ${storagePath}`);
          } catch (e) {
            console.error('[WEBHOOK] Recording storage failed:', e.message);
          }
        }
      }
    } catch (e) {
      console.error('[WEBHOOK] Handler error:', e.message);
    }
  })();

  res.sendStatus(200);
});

// ── Google OAuth ──────────────────────────────────────────────────────────────
app.get('/auth/google', (req, res) => res.redirect(getAuthUrl()));

app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing code');
  try {
    const tokens    = await exchangeCodeForTokens(code);
    const email     = (await getUserEmail(tokens) || '').toLowerCase();
    const firstName = await getUserFirstName(tokens).catch(() => null) || deriveFirstName(email);
    req.session.googleTokens = tokens;
    req.session.userEmail    = email;
    req.session.firstName    = firstName;
    registerUser(email, firstName, true);
    console.log(`[AUTH] Signed in: ${email}`);
    res.redirect('/');
  } catch (err) {
    console.error('[AUTH ERROR]', err.message);
    res.status(500).send('Authentication failed.');
  }
});

app.post('/auth/logout', (req, res) => {
  const email = req.session.userEmail;
  if (email) registerUser(email, null, false);
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/auth/status', (req, res) => {
  res.json({
    authenticated: !!req.session.userEmail,
    email:         req.session.userEmail || null,
    firstName:     req.session.firstName || null,
    isAdmin:       (req.session.userEmail || '').toLowerCase() === ADMIN_EMAIL,
  });
});

// ── Google Calendar ───────────────────────────────────────────────────────────
app.get('/calendar/meetings', requireAuth, async (req, res) => {
  if (!req.session.googleTokens) return res.status(401).json({ error: 'No Google tokens' });
  try {
    const meetings = await getUpcomingMeetings(req.session.googleTokens);
    res.json(meetings);
  } catch (err) {
    console.error('[CALENDAR]', err.message);
    res.status(500).json({ error: 'Failed to fetch meetings.' });
  }
});

// ── Admin — user list ─────────────────────────────────────────────────────────
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    res.json(await getAllUsers());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Startup ───────────────────────────────────────────────────────────────────
async function start() {
  // Seed user registry from Firestore (async in the open-source stack)
  await seedUserRegistry(userRegistry);

  app.listen(PORT, () => {
    console.log(`[SERVER] Meeting Companion running on port ${PORT}`);
    console.log(`[SERVER] Admin: ${ADMIN_EMAIL || '(not set)'}`);
    console.log(`[SERVER] Webhook URL: ${WEBHOOK_URL || '(not set)'}`);
    console.log(`[SERVER] Firebase: ${firebaseConfigured() ? 'configured' : 'NOT configured — set Firebase env vars'}`);
  });
}

start().catch(err => {
  console.error('[STARTUP] Fatal error:', err.message);
  process.exit(1);
});
