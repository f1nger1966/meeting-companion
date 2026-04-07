let currentBotId = null;
let isAdminUser = false;

// ── Tab switching ─────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'history') loadHistory();
    if (btn.dataset.tab === 'calendar') initCalendar();
  });
});

// ── Handle redirect params from Google OAuth ──────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  const p = new URLSearchParams(window.location.search);
  if (p.get('connected')) showAlert('cal-alert', 'Google Calendar connected.', 'success');
  if (p.get('error')) showAlert('cal-alert', 'Auth error: ' + p.get('error'), 'error');
  if (p.toString()) history.replaceState({}, '', location.pathname);
  // On initial load, default to Schedule Bot tab — Google Calendar sync is optional.
  // This only runs once at page load; tab clicks work normally after this.
  initCalendar().then(() => {
    const userIsConnected = document.getElementById('landing').classList.contains('hidden');
    const calendarTabIsActive = document.querySelector('[data-tab="calendar"]')?.classList.contains('active');
    if (userIsConnected && calendarTabIsActive) {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      document.querySelector('[data-tab="schedule"]').classList.add('active');
      document.getElementById('tab-schedule').classList.add('active');
    }
  });
});

// ── Utilities ─────────────────────────────────────────────────────────────────
function showAlert(id, msg, type = 'info') {
  const el = document.getElementById(id);
  el.className = 'alert alert-' + type;
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 7000);
}

function statusBadge(code) {
  const m = {
    in_call_recording: ['green','Recording'], in_call_not_recording: ['yellow','In Call'],
    joining_call: ['yellow','Joining'], in_waiting_room: ['yellow','Lobby'],
    call_ended: ['gray','Ended'], done: ['gray','Done'],
    recording_done: ['gray','Done'], fatal: ['red','Failed'],
    created: ['purple','Scheduled'],
    media_expired: ['gray','Media Deleted'],
    auto_deleted:  ['gray','Auto-Deleted'],
    deleted:       ['gray','Deleted'],
  };
  const [c, l] = m[code] || ['gray', code || 'Unknown'];
  return `<span class="badge badge-${c}">${l}</span>`;
}

// Derive a meaningful status for bots where Recall.ai hasn't sent status_changes yet
function deriveStatus(bot) {
  const code = bot.status_changes?.at(-1)?.code;
  if (code) return code;
  if (bot.join_at) {
    return new Date(bot.join_at) > new Date() ? 'created' : 'expired';
  }
  return null;
}

function statusBadgeDerived(bot) {
  const code = deriveStatus(bot);
  if (code === 'expired') return `<span class="badge badge-gray">Expired</span>`;
  return statusBadge(code);
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { month:'short', day:'numeric', year:'numeric', hour:'2-digit', minute:'2-digit' });
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── Focus return helper — WCAG 2.1 AA ─────────────────────────────────────────
// Tracks the element that opened each modal so focus can return on close.
const _modalTrigger = { admin: null, notauth: null, details: null, help: null };

// ── Admin Panel Modal ─────────────────────────────────────────────────────────
function fmt$(n) { return '$' + (n == null || isNaN(n) ? 0 : +n).toFixed(2); }
function fmtAge(daysStored) {
  if (daysStored == null || isNaN(daysStored)) return '<span class="cost-free">Unknown</span>';
  if (daysStored < 7) return `<span class="cost-free">Free (${(7 - daysStored).toFixed(1)}d left)</span>`;
  if (daysStored < 8) return `<span class="cost-warn"><span aria-hidden="true">⚠</span> ${daysStored.toFixed(1)}d</span>`;
  return `<span class="cost-over"><span aria-hidden="true">&#9888;</span> ${daysStored.toFixed(1)}d</span>`;
}

function openAdminPanel() {
  if (!isAdminUser) {
    _modalTrigger.notauth = document.activeElement;
    document.getElementById('notauth-modal-overlay').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    document.querySelector('#notauth-modal-overlay .modal-close')?.focus();
    return;
  }
  _modalTrigger.admin = document.activeElement;
  // Inject the admin panel HTML structure then load data
  document.getElementById('admin-modal-body').innerHTML = `
    <div style="margin-bottom:1.75rem">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.25rem">
        <h2 style="font-size:1rem;font-weight:700;margin:0">User Usage</h2>
        <button class="btn btn-secondary btn-sm" onclick="loadAdminStats()">&#8635; Refresh</button>
      </div>
      <div id="admin-stats-content"><div class="empty-state"><span class="spinner"></span> Loading...</div></div>
    </div>
    <div style="margin-bottom:1.75rem">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.25rem">
        <h2 style="font-size:1rem;font-weight:700;margin:0">User Login Data</h2>
      </div>
      <div id="admin-login-content"><div class="empty-state"><span class="spinner"></span> Loading...</div></div>
    </div>
    <div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem">
        <h2 style="font-size:1rem;font-weight:700;margin:0">Recordings</h2>
        <button class="btn btn-danger btn-sm" id="btn-delete-sel" onclick="deleteSelectedBots()" disabled>Delete Selected</button>
      </div>
      <p style="font-size:0.8125rem;color:var(--text-muted);margin-bottom:1rem">
        Recordings older than 7 days incur storage costs. Tick and delete any your test users have forgotten to clean up.
      </p>
      <div id="admin-bots-content"><div class="empty-state"><span class="spinner"></span> Loading...</div></div>
    </div>
  `;
  document.getElementById('admin-modal-overlay').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  document.querySelector('#admin-modal-overlay .modal-close')?.focus();
  loadAdminStats();
  loadUserLoginData();
  loadAdminBots();
}

function closeAdminModal() {
  document.getElementById('admin-modal-overlay').classList.add('hidden');
  document.body.style.overflow = '';
  _modalTrigger.admin?.focus();
  _modalTrigger.admin = null;
}

function maybeCloseAdminModal(e) {
  if (e.target === document.getElementById('admin-modal-overlay')) closeAdminModal();
}

function closeNotAuthModal() {
  document.getElementById('notauth-modal-overlay').classList.add('hidden');
  document.body.style.overflow = '';
  _modalTrigger.notauth?.focus();
  _modalTrigger.notauth = null;
}

async function loadAdminStats() {
  const el = document.getElementById('admin-stats-content');
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span> Loading...</div>';
  try {
    const res = await fetch('/api/admin/stats');
    if (res.status === 403) { el.innerHTML = '<div class="alert alert-error">Access denied.</div>'; return; }
    const { users } = await res.json();
    if (!users.length) { el.innerHTML = '<div class="empty-state">No users have connected yet.</div>'; return; }
    users.sort((a, b) => (b.active - a.active) || (b.meetings - a.meetings));
    const totMeetings  = users.reduce((s, u) => s + u.meetings, 0);
    const totSummaries = users.reduce((s, u) => s + u.summaries, 0);
    const totMinutes   = users.reduce((s, u) => s + u.minutes, 0);
    const totTrans     = users.reduce((s, u) => s + u.transcriptionCost, 0);
    const totStorage   = users.reduce((s, u) => s + u.storageCost, 0);
    const rows = users.map(u => `
      <tr>
        <td>${esc(u.email)}${u.firstName ? `<br><span style="font-size:0.75rem;color:var(--text-muted)">${esc(u.firstName)}</span>` : ''}</td>
        <td>${u.active ? '<span class="badge badge-green"><span aria-hidden="true">&#9679;</span> Connected</span>' : '<span class="badge badge-gray">Disconnected</span>'}
            ${u.lastSeen ? `<br><span style="font-size:0.72rem;color:var(--text-muted)">${fmtDate(u.lastSeen)}</span>` : ''}</td>
        <td class="num">${u.meetings}</td>
        <td class="num">${u.summaries}</td>
        <td class="num">${u.minutes}</td>
        <td class="num">${fmt$(u.transcriptionCost)}</td>
        <td class="num">${fmt$(u.storageCost)}</td>
      </tr>`).join('');
    el.innerHTML = `<table class="admin-table">
      <thead><tr>
        <th scope="col">User</th><th scope="col">Status</th>
        <th scope="col" class="num">Meetings</th><th scope="col" class="num">Summaries</th><th scope="col" class="num">Minutes</th>
        <th scope="col" class="num">Transcription</th><th scope="col" class="num">Storage</th>
      </tr></thead>
      <tbody>${rows}
        <tr class="totals-row">
          <td colspan="2">Totals</td>
          <td class="num">${totMeetings}</td><td class="num">${totSummaries}</td><td class="num">${totMinutes}</td>
          <td class="num">${fmt$(totTrans)}</td><td class="num">${fmt$(totStorage)}</td>
        </tr>
      </tbody></table>`;
  } catch (err) {
    el.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
  }
}

async function loadUserLoginData() {
  const el = document.getElementById('admin-login-content');
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span> Loading...</div>';
  try {
    const res = await fetch('/api/admin/stats');
    if (res.status === 403) { el.innerHTML = '<div class="alert alert-error">Access denied.</div>'; return; }
    const { users } = await res.json();
    if (!users.length) { el.innerHTML = '<div class="empty-state">No users have connected yet.</div>'; return; }
    users.sort((a, b) => (b.active - a.active) || (new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0)));
    const rows = users.map(u => `
      <tr>
        <td>${esc(u.email)}</td>
        <td>${u.active
          ? '<span class="badge badge-green"><span aria-hidden="true">&#9679;</span> Connected</span>'
          : '<span class="badge badge-gray">Disconnected</span>'}</td>
        <td>${u.lastSeen ? fmtDate(u.lastSeen) : '<span style="color:var(--text-muted)">—</span>'}</td>
        <td class="num">${u.recordingsStored ?? 0}</td>
      </tr>`).join('');
    el.innerHTML = `<table class="admin-table">
      <thead><tr>
        <th scope="col">Email</th>
        <th scope="col">Status</th>
        <th scope="col">Last Login</th>
        <th scope="col" class="num">Recordings Stored</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  } catch (err) {
    el.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
  }
}

async function loadAdminBots() {
  const el = document.getElementById('admin-bots-content');
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span> Loading...</div>';
  try {
    const res = await fetch('/api/admin/bots');
    if (res.status === 403) { el.innerHTML = '<div class="alert alert-error">Access denied.</div>'; return; }
    const { bots } = await res.json();
    if (!bots.length) { el.innerHTML = '<div class="empty-state">No recordings found.</div>'; return; }
    const rows = bots.map(b => {
      const isDeleted = b.status === 'media_expired' || b.status === 'deleted';
      const rowClass = isDeleted ? '' : b.daysStored >= 8 ? 'warn-red' : b.daysStored >= 7 ? 'warn-amber' : '';
      const ageCell  = isDeleted
        ? `<span class="cost-free">Media deleted</span>`
        : fmtAge(b.daysStored);
      const costCell = isDeleted ? '<span style="color:var(--text-muted)">—</span>' : fmt$(b.totalCost);
      const statusLabel = b.status === 'media_expired' ? 'Media Deleted' : b.status;
      return `<tr class="${rowClass}" style="${isDeleted ? 'opacity:0.6' : ''}">
        <td><input type="checkbox" class="admin-cb bot-cb" data-id="${esc(b.botId)}" onchange="updateDeleteBtn()"></td>
        <td>${fmtDate(b.createdAt)}</td>
        <td class="num">${b.durationMinutes} min</td>
        <td class="num">${ageCell}</td>
        <td class="num">${costCell}</td>
        <td><span class="badge ${statusBadgeClass(b.status)}">${statusLabel}</span></td>
      </tr>`;
    }).join('');
    el.innerHTML = `<table class="admin-table">
      <thead><tr>
        <th scope="col" style="width:32px"><input type="checkbox" class="admin-cb" id="cb-all" onchange="toggleAllBots(this)" aria-label="Select all recordings"></th>
        <th scope="col">Date / Time</th><th scope="col" class="num">Duration</th>
        <th scope="col" class="num">Age</th><th scope="col" class="num">Est. Cost</th><th scope="col">Status</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  } catch (err) {
    el.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
  }
}

function statusBadgeClass(code) {
  if (!code) return 'badge-gray';
  if (['done','call_ended'].includes(code)) return 'badge-green';
  if (['cancelled','fatal'].includes(code)) return 'badge-red';
  if (['in_call_recording','in_call_not_recording'].includes(code)) return 'badge-blue';
  if (['media_expired','deleted','auto_deleted'].includes(code)) return 'badge-gray';
  return 'badge-yellow';
}

function toggleAllBots(cb) {
  document.querySelectorAll('.bot-cb').forEach(c => c.checked = cb.checked);
  updateDeleteBtn();
}

function updateDeleteBtn() {
  const any = document.querySelectorAll('.bot-cb:checked').length > 0;
  document.getElementById('btn-delete-sel').disabled = !any;
}

async function deleteSelectedBots() {
  const checked = [...document.querySelectorAll('.bot-cb:checked')];
  if (!checked.length) return;
  if (!confirm(`Delete ${checked.length} recording(s)? This cannot be undone.`)) return;
  const btn = document.getElementById('btn-delete-sel');
  btn.disabled = true;
  btn.textContent = 'Deleting...';
  const ids = checked.map(c => c.dataset.id);
  const results = await Promise.allSettled(ids.map(id =>
    fetch(`/api/admin/bot/${id}`, { method: 'DELETE' }).then(r => r.json())
  ));
  const failed = results.filter(r => r.status === 'rejected' || r.value?.error).length;
  btn.textContent = 'Delete Selected';
  if (failed) alert(`${failed} deletion(s) failed. Refreshing list.`);
  loadAdminBots();
}

// ── Help modal ────────────────────────────────────────────────────────────────
function openHelp() {
  _modalTrigger.help = document.activeElement;
  document.getElementById('help-overlay').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  document.querySelector('#help-overlay .modal-close')?.focus();
}
function closeHelp() {
  document.getElementById('help-overlay').classList.add('hidden');
  document.body.style.overflow = '';
  _modalTrigger.help?.focus();
  _modalTrigger.help = null;
}
function maybeCloseHelp(e) {
  if (e.target === document.getElementById('help-overlay')) closeHelp();
}
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    closeHelp();
    closeAdminModal();
    closeNotAuthModal();
    closeModal();
  }
});

// ── Schedule Bot ──────────────────────────────────────────────────────────────
async function deployBot() {
  const url = document.getElementById('meeting-url').value.trim();
  const name = document.getElementById('bot-name').value.trim();
  const joinAt = document.getElementById('join-at').value;
  const isValidMeetingUrl = url.includes('teams.microsoft.com') || url.includes('teams.live.com') || url.includes('zoom.us') || url.includes('meet.google.com');
  if (!url || !isValidMeetingUrl) { showAlert('schedule-alert', 'Please enter a valid Teams, Zoom, or Google Meet meeting URL.', 'error'); return; }

  const btn = document.getElementById('btn-deploy');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Working...';

  try {
    const body = { meeting_url: url, bot_name: name || undefined };
    if (joinAt) body.join_at = new Date(joinAt).toISOString();

    const res = await fetch('/bot/join', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(typeof data.error === 'object' ? JSON.stringify(data.error) : data.error);

    const msg = data.scheduledFor
      ? `Bot scheduled to join at ${fmtDate(data.scheduledFor)} (ID: ${data.botId})`
      : data.message + ' (ID: ' + data.botId + ')';
    showAlert('schedule-alert', msg, 'success');
    document.getElementById('meeting-url').value = '';
    document.getElementById('bot-name').value = '';
    document.getElementById('join-at').value = '';
  } catch (err) {
    showAlert('schedule-alert', 'Error: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Deploy Bot';
  }
}

// ── Google Calendar ───────────────────────────────────────────────────────────
let googleFirstName = null;
// Track scheduled bots per meeting URL: { teamsUrl -> { botId } }
const scheduledMeetings = new Map();
// Cache of current calendar meetings for overlap detection
let calendarMeetings = [];
async function initCalendar() {
  const res = await fetch('/api/google/status');
  const { connected, authenticated, isAdmin } = await res.json();
  isAdminUser = !!isAdmin;

  // "authenticated" = user has a session identity (email known, may have no calendar tokens)
  // "connected"     = user also has live Google Calendar tokens
  // Show landing only when the user has no identity at all.
  const inApp = authenticated || connected;
  document.getElementById('landing').classList.toggle('hidden', inApp);
  document.getElementById('tabs-nav').classList.toggle('hidden', !inApp);
  document.querySelectorAll('.tab-content').forEach(el => el.classList.toggle('hidden', !inApp));
  document.getElementById('tab-btn-history').classList.toggle('hidden', !inApp);
  document.getElementById('tab-btn-schedule').classList.toggle('hidden', !inApp);
  document.getElementById('btn-header-logout').classList.toggle('hidden', !inApp);
  // Calendar connect/connected banners reflect whether calendar tokens are present
  document.getElementById('cal-connect-banner').classList.toggle('hidden', connected);
  document.getElementById('cal-connected-banner').classList.toggle('hidden', !connected);
  if (!inApp) {
    document.getElementById('cal-list').innerHTML = '<div class="empty-state">Connect Google Calendar to see upcoming Teams and Zoom meetings.</div>';
    return;
  }
  if (!connected) {
    // User is authenticated but hasn't connected (or disconnected) Google Calendar
    document.getElementById('cal-list').innerHTML = '<div class="empty-state">Connect Google Calendar to see upcoming Teams and Zoom meetings.</div>';
    return;
  }
  if (connected) {
    // Fetch first name for bot naming — pre-populate Schedule Bot name input
    try {
      const pd = await fetch('/api/google/profile').then(r => r.json());
      if (pd.firstName) {
        googleFirstName = pd.firstName;
        const nameInput = document.getElementById('bot-name');
        if (nameInput && !nameInput.value) nameInput.placeholder = `${googleFirstName}'s Bot`;
      }
    } catch (_) {}

    // Pre-populate scheduledMeetings — three layered sources in priority order:
    // 1. /api/active-meeting-map  — server fetches individual bot data as fallback (most reliable)
    // 2. localStorage             — persists across page reloads + server restarts
    // 3. b.meeting_url from list  — already covered inside /api/active-meeting-map
    try {
      const mapRes = await fetch('/api/active-meeting-map').then(r => r.json());

      // allActiveBotIds = every bot still alive in Recall.ai (even if URL unresolved).
      // Used for localStorage pruning so we only discard truly gone bots.
      const allActiveBotIds = new Set([
        ...(mapRes.allActiveBotIds || []),
        ...(mapRes.map || []).map(e => e.botId),
      ]);

      // Layer 1: server-authoritative URL map (uses individual bot calls as fallback)
      (mapRes.map || []).forEach(({ botId, meetingUrl }) => {
        if (meetingUrl) scheduledMeetings.set(meetingUrl, { botId });
      });

      // Layer 2: localStorage — catches meetings scheduled in this browser.
      // Only prune entries whose bot is confirmed gone from Recall.ai entirely.
      const lsMap = JSON.parse(localStorage.getItem('botMeetingMap') || '{}');
      let lsChanged = false;
      Object.entries(lsMap).forEach(([botId, url]) => {
        if (allActiveBotIds.has(botId)) {
          if (!scheduledMeetings.has(url)) scheduledMeetings.set(url, { botId });
        } else {
          delete lsMap[botId]; // bot is gone from Recall.ai — safe to prune
          lsChanged = true;
        }
      });
      if (lsChanged) localStorage.setItem('botMeetingMap', JSON.stringify(lsMap));
    } catch (_) {}

    loadCalendarMeetings();
  }
}

async function loadCalendarMeetings() {
  const list = document.getElementById('cal-list');
  list.innerHTML = '<div class="empty-state"><span class="spinner"></span> Loading...</div>';
  try {
    const res = await fetch('/api/google/meetings');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    calendarMeetings = data.meetings || [];
    if (!calendarMeetings.length) {
      list.innerHTML = '<div class="empty-state">No upcoming Teams or Zoom meetings found in the next 30 days.</div>';
      return;
    }
    renderCalendarMeetings();
  } catch (err) {
    showAlert('cal-alert', err.message, 'error');
    list.innerHTML = '<div class="empty-state">Failed to load calendar events.</div>';
  }
}

function renderCalendarMeetings() {
  const list = document.getElementById('cal-list');
  list.innerHTML = calendarMeetings.map((m, idx) => {
    const scheduled = scheduledMeetings.get(m.meetingUrl);
    const platformBadge = m.platform === 'zoom'
      ? `<span class="badge badge-blue">Zoom</span>`
      : m.platform === 'google_meet'
      ? `<span class="badge badge-meet">Google Meet</span>`
      : `<span class="badge badge-purple">Teams</span>`;
    const actionHtml = scheduled
      ? `<button class="btn btn-secondary btn-sm" disabled style="opacity:0.7">&#10003; Scheduled</button>
         <button class="btn btn-danger btn-sm cal-cancel-btn" data-url="${esc(m.meetingUrl)}" data-bot-id="${esc(scheduled.botId)}">Cancel</button>`
      : `<button class="btn btn-primary btn-sm cal-schedule-btn"
           data-url="${esc(m.meetingUrl)}" data-title="${esc(m.title)}" data-start="${esc(m.start)}" data-end="${esc(m.end || '')}" data-idx="${idx}">
           Schedule Bot
         </button>`;
    return `<div class="meeting-item" data-url="${esc(m.meetingUrl)}">
      <div class="meeting-item-body">
        <div class="meeting-item-title">${esc(m.title)}</div>
        <div class="meeting-item-meta">${fmtDate(m.start)}${m.end ? ' &mdash; ' + fmtDate(m.end) : ''}</div>
        <div class="meeting-item-url">${esc(m.meetingUrl)}</div>
      </div>
      <div class="meeting-item-actions">${platformBadge}${actionHtml}</div>
    </div>`;
  }).join('');

  // Attach events via delegation (avoids quoting issues with apostrophes in names)
  list.querySelectorAll('.cal-schedule-btn').forEach(btn => {
    btn.addEventListener('click', () =>
      scheduleFromCalendar(btn.dataset.url, btn.dataset.title, btn.dataset.start, btn.dataset.end, parseInt(btn.dataset.idx)));
  });
  list.querySelectorAll('.cal-cancel-btn').forEach(btn => {
    btn.addEventListener('click', () => cancelCalendarBot(btn.dataset.url, btn.dataset.botId));
  });
}

async function scheduleFromCalendar(teamsUrl, title, startIso, endIso, idx) {
  // Check for overlapping meetings
  let overlapWarning = '';
  if (startIso && endIso) {
    const newStart = new Date(startIso), newEnd = new Date(endIso);
    calendarMeetings.forEach((m, i) => {
      if (i === idx || !scheduledMeetings.has(m.meetingUrl)) return;
      const s = new Date(m.start), e = new Date(m.end || m.start);
      if (newStart < e && newEnd > s) {
        overlapWarning = `\n\n⚠ Overlaps with "${m.title}". Both bots will be scheduled.`;
      }
    });
  }

  const timeLabel = startIso ? ` at ${fmtDate(new Date(new Date(startIso).getTime() - 60000))} (1 min early)` : '';
  const msg = `Schedule a bot for "${title}"${timeLabel}?${overlapWarning}`;
  if (!confirm(msg)) return;

  try {
    const botName = googleFirstName ? `${googleFirstName}'s Bot` : 'Meeting Notes Bot';
    const body = { meeting_url: teamsUrl, bot_name: botName, meeting_title: title };
    // Join 1 minute before meeting start
    if (startIso) body.join_at = new Date(new Date(startIso).getTime() - 60 * 1000).toISOString();

    const res = await fetch('/bot/join', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(typeof data.error === 'object' ? JSON.stringify(data.error) : data.error);

    const confirmMsg = data.scheduledFor
      ? `Bot scheduled to join at ${fmtDate(data.scheduledFor)}.`
      : data.message;
    showAlert('cal-alert', confirmMsg, 'success');

    // Mark this meeting as scheduled and re-render
    scheduledMeetings.set(teamsUrl, { botId: data.botId });
    // Persist to localStorage so state survives page reloads and server restarts
    const lsMap = JSON.parse(localStorage.getItem('botMeetingMap') || '{}');
    lsMap[data.botId] = teamsUrl;
    localStorage.setItem('botMeetingMap', JSON.stringify(lsMap));
    renderCalendarMeetings();
  } catch (err) {
    showAlert('cal-alert', 'Error: ' + err.message, 'error');
  }
}

async function cancelCalendarBot(teamsUrl, botId) {
  if (!confirm('Cancel this scheduled bot?')) return;
  try {
    const res = await fetch(`/bot/${botId}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(typeof data.error === 'object' ? JSON.stringify(data.error) : data.error);
    scheduledMeetings.delete(teamsUrl);
    // Remove from localStorage
    const lsMap = JSON.parse(localStorage.getItem('botMeetingMap') || '{}');
    delete lsMap[botId];
    localStorage.setItem('botMeetingMap', JSON.stringify(lsMap));
    renderCalendarMeetings();
    showAlert('cal-alert', 'Bot cancelled.', 'success');
  } catch (err) {
    showAlert('cal-alert', 'Error: ' + err.message, 'error');
  }
}

// Calendar-only disconnect — clears calendar tokens on server, stays in the app.
// The user keeps their session identity so Schedule Bot and Meeting History still work.
async function disconnectCalendar() {
  await fetch('/api/google/disconnect', { method: 'POST' }).catch(() => {});
  // Reset calendar UI to the "not connected" state
  document.getElementById('cal-connect-banner').classList.remove('hidden');
  document.getElementById('cal-connected-banner').classList.add('hidden');
  document.getElementById('cal-list').innerHTML = '<div class="empty-state">Connect Google Calendar to see upcoming Teams and Zoom meetings.</div>';
  scheduledMeetings.clear();
  localStorage.removeItem('botMeetingMap');
  calendarMeetings = [];
  // Stay in the app — switch to Schedule Bot tab
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.querySelector('[data-tab="schedule"]').classList.add('active');
  document.getElementById('tab-schedule').classList.add('active');
}

// Full logout — clears identity + calendar tokens, returns to the landing page.
async function logOut() {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  scheduledMeetings.clear();
  localStorage.removeItem('botMeetingMap');
  calendarMeetings = [];
  googleFirstName = null;
  isAdminUser = false;
  document.getElementById('btn-header-logout').classList.add('hidden');
  document.getElementById('tab-btn-history').classList.add('hidden');
  document.getElementById('tab-btn-schedule').classList.add('hidden');
  document.getElementById('landing').classList.remove('hidden');
  document.getElementById('tabs-nav').classList.add('hidden');
  document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
  // Reset active tab to Calendar so it's correct on next login
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.querySelector('[data-tab="calendar"]').classList.add('active');
}

// ── Meeting History ───────────────────────────────────────────────────────────
async function loadHistory() {
  const list = document.getElementById('history-list');
  list.innerHTML = '<div class="empty-state">Loading...</div>';
  try {
    const res = await fetch('/bots');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    const allBots = data.remote || [];
    const localMap = Object.fromEntries((data.local || []).map(l => [l.botId, l]));

    // Hide recordings whose media has been deleted — nothing useful left to show the user
    const HIDDEN_STATUSES = new Set(['media_expired', 'deleted']);
    const bots = allBots.filter(bot => {
      const status = deriveStatus(bot);
      const localStatus = (bot._local || localMap[bot.id] || {}).status;
      return !HIDDEN_STATUSES.has(status) && !HIDDEN_STATUSES.has(localStatus);
    });

    if (!bots.length) {
      list.innerHTML = '<div class="empty-state">No meetings yet. Deploy a bot from the Schedule Bot tab.</div>';
      return;
    }

    list.innerHTML = bots.map(bot => {
      const status = deriveStatus(bot);
      const local = bot._local || localMap[bot.id] || {};
      const costs = bot._costs || {};
      const isDone = ['call_ended','done','recording_done','fatal','expired'].includes(status);
      const isLive = ['joining_call','in_waiting_room','in_call_not_recording','in_call_recording'].includes(status);
      const isScheduled = status === 'created';

      const rawTitle = local.meetingTitle || local.botName || bot.bot_name || 'Meeting Bot';
      const displayDate = fmtDate(local.scheduledFor || local.createdAt || bot.join_at);
      const rawMeetingUrl = local.meetingUrl || bot.meeting_url;
      const meetingUrlForBadge = typeof rawMeetingUrl === 'string' ? rawMeetingUrl : '';
      const platformBadge = meetingUrlForBadge.includes('zoom.us')
        ? `<span class="badge badge-blue">Zoom</span>`
        : meetingUrlForBadge.includes('teams')
        ? `<span class="badge badge-purple">Teams</span>`
        : meetingUrlForBadge.includes('meet.google.com')
        ? `<span class="badge badge-meet">Google Meet</span>`
        : '';

      // Age + cost indicators — shown as a dedicated row below the date
      let ageMeta = '';
      if (costs.daysStored !== undefined && isDone) {
        const d = costs.daysStored;
        const free = costs.freeWindowHours / 24;
        const daysLeft = Math.max(0, free - d);
        let ageColor, ageLabel;
        if (d < 5)       { ageColor = 'var(--green)';  ageLabel = `Free — ${daysLeft.toFixed(1)}d left`; }
        else if (d < 7)  { ageColor = 'var(--yellow)'; ageLabel = `⚠ ${daysLeft.toFixed(1)}d left — delete soon`; }
        else             { ageColor = 'var(--red)';    ageLabel = `${d.toFixed(1)}d stored — incurring cost`; }
        const costLabel = costs.storageCost > 0 ? `$${costs.storageCost.toFixed(2)}` : '$0.00';
        ageMeta = `<div style="margin-top:0.3rem;display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;">
          <span style="font-size:0.8rem;font-weight:700;color:${ageColor};">Storage: ${ageLabel}</span>
          <span style="font-size:0.8rem;color:var(--text-muted);">· Est. ${costLabel}</span>
        </div>`;
      }

      // CIP button — three states: unsent, queued (consented but not yet picked up), ingested
      let cipBtn = '';
      if (isDone) {
        if (local.cipIngested) {
          cipBtn = `<button class="btn btn-secondary btn-sm" disabled style="opacity:0.7;color:var(--green)">&#10003; In CIP</button>`;
        } else if (local.cipConsented) {
          cipBtn = `<button class="btn btn-secondary btn-sm" disabled style="opacity:0.7">&#8635; Queued for CIP</button>`;
        } else {
          cipBtn = `<button class="btn btn-secondary btn-sm hist-cip-btn" data-bot-id="${bot.id}">Send to CIP</button>`;
        }
      }

      return `<div class="meeting-item" data-bot-id="${bot.id}">
        <div class="meeting-item-body">
          <div class="meeting-item-title">${esc(rawTitle)}</div>
          <div class="meeting-item-meta">${displayDate}</div>
          ${ageMeta}
          <div style="font-size:0.75rem;color:var(--text-muted)">ID: ${bot.id}</div>
        </div>
        <div class="meeting-item-actions">
          ${platformBadge}
          ${statusBadgeDerived(bot)}
          ${isDone ? `<button class="btn btn-secondary btn-sm hist-view-btn" data-bot-id="${bot.id}" data-title="${esc(rawTitle)}">View</button>` : ''}
          ${cipBtn}
          ${isDone ? `<button class="btn btn-danger btn-sm hist-delete-btn" data-bot-id="${bot.id}" data-meeting-url="${esc(local.meetingUrl || '')}">Delete</button>` : ''}
          ${isLive ? `<button class="btn btn-danger btn-sm hist-leave-btn" data-bot-id="${bot.id}" data-meeting-url="${esc(local.meetingUrl || '')}">Leave</button>` : ''}
          ${isScheduled ? `<button class="btn btn-danger btn-sm hist-cancel-btn" data-bot-id="${bot.id}" data-meeting-url="${esc(local.meetingUrl || '')}">Cancel</button>` : ''}
        </div>
      </div>`;
    }).join('');

    // Attach events via data attributes (safe with apostrophes in names)
    list.querySelectorAll('.hist-view-btn').forEach(btn => {
      btn.addEventListener('click', () => openDetails(btn.dataset.botId, btn.dataset.title));
    });
    list.querySelectorAll('.hist-cip-btn').forEach(btn => {
      btn.addEventListener('click', () => sendToCip(btn.dataset.botId, btn));
    });
    list.querySelectorAll('.hist-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => deleteHistoryBot(btn.dataset.botId, btn.dataset.meetingUrl));
    });
    list.querySelectorAll('.hist-leave-btn').forEach(btn => {
      btn.addEventListener('click', () => leaveBot(btn.dataset.botId, btn.dataset.meetingUrl));
    });
    list.querySelectorAll('.hist-cancel-btn').forEach(btn => {
      btn.addEventListener('click', () => cancelBot(btn.dataset.botId, btn.dataset.meetingUrl));
    });

  } catch (err) {
    showAlert('history-alert', err.message, 'error');
    list.innerHTML = '<div class="empty-state">Failed to load history.</div>';
  }
}

async function leaveBot(botId, meetingUrl) {
  if (!confirm('Tell this bot to leave the meeting?')) return;
  try {
    const res = await fetch(`/bot/${botId}/leave`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(typeof data.error === 'object' ? JSON.stringify(data.error) : data.error);
    showAlert('history-alert', 'Bot left the meeting.', 'success');
    if (meetingUrl) {
      scheduledMeetings.delete(meetingUrl);
      // Remove from localStorage by value
      const lsMap = JSON.parse(localStorage.getItem('botMeetingMap') || '{}');
      Object.keys(lsMap).forEach(k => { if (lsMap[k] === meetingUrl) delete lsMap[k]; });
      localStorage.setItem('botMeetingMap', JSON.stringify(lsMap));
    }
    setTimeout(loadHistory, 1000);
  } catch (err) {
    showAlert('history-alert', 'Error: ' + err.message, 'error');
  }
}

async function cancelBot(botId, meetingUrl) {
  if (!confirm('Cancel this scheduled bot?')) return;
  try {
    const res = await fetch(`/bot/${botId}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(typeof data.error === 'object' ? JSON.stringify(data.error) : data.error);
    showAlert('history-alert', 'Bot cancelled.', 'success');
    // Sync Google Calendar button state
    if (meetingUrl) {
      scheduledMeetings.delete(meetingUrl);
      // Remove from localStorage by value
      const lsMap = JSON.parse(localStorage.getItem('botMeetingMap') || '{}');
      Object.keys(lsMap).forEach(k => { if (lsMap[k] === meetingUrl) delete lsMap[k]; });
      localStorage.setItem('botMeetingMap', JSON.stringify(lsMap));
      if (calendarMeetings.length) renderCalendarMeetings();
    }
    setTimeout(loadHistory, 1000);
  } catch (err) {
    showAlert('history-alert', 'Error: ' + err.message, 'error');
  }
}

async function deleteHistoryBot(botId, meetingUrl) {
  if (!confirm('Permanently delete this recording from Recall.ai?\n\nThis will stop any ongoing storage costs but the recording cannot be recovered.')) return;
  try {
    const res = await fetch(`/api/bot/${botId}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(typeof data.error === 'object' ? JSON.stringify(data.error) : data.error);
    showAlert('history-alert', 'Recording deleted.', 'success');
    // Remove DOM row immediately for snappy feel
    const row = document.querySelector(`.meeting-item[data-bot-id="${botId}"]`);
    if (row) row.remove();
    // Sync scheduled state if this was also scheduled
    if (meetingUrl) {
      scheduledMeetings.delete(meetingUrl);
      const lsMap = JSON.parse(localStorage.getItem('botMeetingMap') || '{}');
      Object.keys(lsMap).forEach(k => { if (lsMap[k] === meetingUrl) delete lsMap[k]; });
      localStorage.setItem('botMeetingMap', JSON.stringify(lsMap));
      if (calendarMeetings.length) renderCalendarMeetings();
    }
  } catch (err) {
    showAlert('history-alert', 'Error: ' + err.message, 'error');
  }
}

async function sendToCip(botId, btn) {
  // Optimistic UI — disable immediately so user can't double-click
  if (btn) { btn.disabled = true; btn.textContent = 'Sending...'; }
  try {
    const res = await fetch(`/bot/${botId}/send-to-cip`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    if (data.status === 'already_ingested') {
      showAlert('history-alert', 'This recording is already in CIP.', 'info');
      if (btn) { btn.textContent = '✓ In CIP'; btn.style.color = 'var(--green)'; }
    } else {
      showAlert('history-alert', 'Recording queued for CIP — it will be ingested on the next sweep (within 1 hour).', 'success');
      if (btn) { btn.textContent = '↻ Queued for CIP'; }
    }
  } catch (err) {
    showAlert('history-alert', 'Error: ' + err.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Send to CIP'; }
  }
}

// ── Meeting Detail Modal ──────────────────────────────────────────────────────
async function openDetails(botId, title) {
  _modalTrigger.details = document.activeElement;
  currentBotId = botId;
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = '<div class="empty-state"><span class="spinner"></span> Loading...</div>';
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.querySelector('#modal-overlay .modal-close')?.focus();

  const [transcriptResult, recordingResult] = await Promise.allSettled([
    fetch(`/bot/${botId}/transcript`).then(r => r.json()),
    fetch(`/bot/${botId}/recording`).then(r => r.json()),
  ]);

  const transcript = transcriptResult.status === 'fulfilled' ? transcriptResult.value : null;
  const recording = recordingResult.status === 'fulfilled' ? recordingResult.value : null;
  const segs = Array.isArray(transcript) ? transcript : (transcript?.results || []);

  document.getElementById('modal-body').innerHTML = `
    <div style="margin-bottom:1.5rem">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem">
        <div class="section-label" style="margin-bottom:0">AI Summary</div>
        <button class="btn btn-secondary btn-sm" id="btn-gen-summary" onclick="generateAiSummary()">Generate Summary</button>
      </div>
      <div id="summary-section"><div style="padding:0.75rem;color:var(--text-muted);font-size:0.8125rem">Click "Generate Summary" to analyse this meeting with AI.</div></div>
    </div>
    <div style="margin-bottom:1.5rem">
      <div class="section-label">Recording</div>
      ${renderRecording(recording)}
    </div>
    <div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem">
        <div class="section-label" style="margin-bottom:0">Transcript</div>
        ${segs.length ? `<button class="btn btn-secondary btn-sm" onclick="downloadTranscript()">Download .txt</button>` : ''}
      </div>
      ${renderTranscript(transcript)}
    </div>`;
}

async function generateAiSummary() {
  const btn = document.getElementById('btn-gen-summary');
  const section = document.getElementById('summary-section');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Generating...';
  try {
    const res = await fetch(`/bot/${currentBotId}/summary`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    section.innerHTML = renderSummary(data);
  } catch (err) {
    section.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Regenerate';
  }
}

function renderSummary(data) {
  const decisions = (data.decisions || []).map(d => `<li>${esc(d)}</li>`).join('');
  const actions = (data.actionItems || []).map(a =>
    `<li><strong>${esc(a.owner)}:</strong> ${esc(a.action)}</li>`
  ).join('');
  return `<div style="background:var(--surface2);border-radius:8px;padding:1.25rem">
    <p style="font-size:0.9rem;line-height:1.6;margin-bottom:${decisions || actions ? '1rem' : '0'}">${esc(data.summary)}</p>
    ${decisions ? `<div style="margin-bottom:0.75rem"><div style="font-size:0.75rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:0.4rem">Decisions</div><ul style="padding-left:1.25rem;font-size:0.875rem;line-height:1.7">${decisions}</ul></div>` : ''}
    ${actions ? `<div><div style="font-size:0.75rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:0.4rem">Action Items</div><ul style="padding-left:1.25rem;font-size:0.875rem;line-height:1.7">${actions}</ul></div>` : ''}
  </div>`;
}

async function downloadTranscript() {
  try {
    const res = await fetch(`/bot/${currentBotId}/transcript`);
    const data = await res.json();
    const segs = Array.isArray(data) ? data : (data?.results || []);
    const lines = segs.map(seg => {
      const speaker = seg.participant?.name || 'Unknown';
      const words = (seg.words || []).map(w => w.text).join(' ').trim();
      const ts = seg.words?.[0]?.start_timestamp;
      const secs = typeof ts === 'object' ? ts?.relative : ts;
      const timeLabel = secs != null && !isNaN(secs)
        ? `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')}`
        : '';
      return words ? `${speaker}${timeLabel ? '  ' + timeLabel : ''}\n${words}\n` : null;
    }).filter(Boolean).join('\n');

    const blob = new Blob([lines], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `transcript-${currentBotId}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (err) {
    alert('Download failed: ' + err.message);
  }
}

function renderRecording(data) {
  const url = data?.url;
  if (!url) return '<div class="empty-state" style="padding:1rem">Recording not available.</div>';
  return `
    <video class="recording-player" controls preload="metadata">
      <source src="${esc(url)}" type="video/mp4" />
    </video>
    <p style="font-size:0.75rem;color:var(--text-muted);margin-top:0.4rem">Pre-signed URL expires in ~1 hour. Re-open this dialog for a fresh link.</p>`;
}

function renderTranscript(data) {
  const segs = Array.isArray(data) ? data : (data?.results || []);
  if (!segs?.length) return '<div class="empty-state" style="padding:1rem">Transcript not available.</div>';

  const lines = segs.map(seg => {
    const speaker = seg.participant?.name || 'Unknown';
    const words = seg.words || [];
    const text = words.map(w => w.text).join(' ').trim();
    const ts = words[0]?.start_timestamp != null ? fmtTranscriptTs(words[0].start_timestamp) : '';
    if (!text) return '';
    return `<div class="transcript-line">
      <div class="transcript-speaker">${esc(speaker)}<span class="transcript-ts">${ts}</span></div>
      <div class="transcript-text">${esc(text)}</div>
    </div>`;
  }).join('');

  return `<div class="transcript-viewer">${lines || '<div class="empty-state">No speech captured.</div>'}</div>`;
}

function fmtTranscriptTs(val) {
  const secs = typeof val === 'object' ? val?.relative : val;
  if (secs == null || isNaN(secs)) return '';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2,'0')}`;
}

function maybeCloseModal(e) { if (e.target === document.getElementById('modal-overlay')) closeModal(); }
function closeModal() {
  if (document.getElementById('modal-overlay').classList.contains('hidden')) return;
  document.getElementById('modal-overlay').classList.add('hidden');
  document.querySelectorAll('video').forEach(v => { v.pause(); v.src = ''; });
  _modalTrigger.details?.focus();
  _modalTrigger.details = null;
}
