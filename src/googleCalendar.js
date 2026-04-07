const { google } = require('googleapis');

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/userinfo.email',
];
const TEAMS_URL_REGEX = /https:\/\/teams\.(microsoft|live)\.com\/[^\s"<>]+/g;
const ZOOM_URL_REGEX  = /https:\/\/[a-z0-9-]+\.zoom\.us\/j\/[^\s"<>]+/g;
const MEET_URL_REGEX  = /https:\/\/meet\.google\.com\/[a-z0-9-]+/g;

function createOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.APP_URL}/auth/google/callback`
  );
}

function getAuthUrl(state) {
  const client = createOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    state,
  });
}

async function exchangeCodeForTokens(code) {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);
  return tokens;
}

async function getUpcomingMeetings(tokens) {
  const client = createOAuthClient();
  client.setCredentials(tokens);

  const calendar = google.calendar({ version: 'v3', auth: client });

  const timeMin = new Date().toISOString();
  const timeMax = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  // Paginate through ALL events in the window — maxResults 50 was silently
  // dropping events beyond the first page on busy calendars.
  let allEvents = [];
  let pageToken;
  do {
    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin,
      timeMax,
      maxResults: 250,        // Google Calendar API maximum per page
      singleEvents: true,
      orderBy: 'startTime',
      ...(pageToken ? { pageToken } : {}),
    });
    allEvents = allEvents.concat(response.data.items || []);
    pageToken = response.data.nextPageToken;
  } while (pageToken);

  return allEvents
    .map(event => {
      const searchText = [
        event.location || '',
        event.description || '',
        (event.conferenceData?.entryPoints || []).map(e => e.uri).join(' '),
      ].join(' ');

      const teamsMatches = searchText.match(TEAMS_URL_REGEX);
      const zoomMatches  = searchText.match(ZOOM_URL_REGEX);
      const meetMatches  = searchText.match(MEET_URL_REGEX);
      if (!teamsMatches && !zoomMatches && !meetMatches) return null;

      const meetingUrl = (teamsMatches || zoomMatches || meetMatches)[0];
      const platform   = teamsMatches ? 'teams' : zoomMatches ? 'zoom' : 'google_meet';

      return {
        eventId: event.id,
        title: event.summary || '(No title)',
        start: event.start?.dateTime || event.start?.date,
        end: event.end?.dateTime || event.end?.date,
        meetingUrl,
        platform,
      };
    })
    .filter(Boolean);
}

// Keep old name as alias for backward compatibility
const getUpcomingTeamsMeetings = getUpcomingMeetings;

async function getUserFirstName(tokens) {
  const client = createOAuthClient();
  client.setCredentials(tokens);
  const people = google.people({ version: 'v1', auth: client });
  const res = await people.people.get({ resourceName: 'people/me', personFields: 'names' });
  const name = res.data.names?.[0];
  return name?.givenName || name?.displayName?.split(' ')[0] || null;
}

// Returns the user's Google email.
// Method 0: oauth2.userinfo endpoint — standard OAuth2, always works with userinfo.email scope,
//            no extra Google API needs to be enabled in GCP. Primary method.
// Method 1: id_token JWT payload — instant decode, no API call, needs id_token present.
// Method 2: People API emailAddresses — requires People API enabled in GCP.
// Method 3: calendarList.list — last resort, uses already-enabled Calendar API.
async function getUserEmail(tokens) {
  const client = createOAuthClient();
  client.setCredentials(tokens);

  // Method 0: Standard OAuth2 userinfo endpoint (most reliable — no extra API needed)
  try {
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const res = await oauth2.userinfo.get();
    if (res.data.email) {
      console.log('[getUserEmail] from oauth2.userinfo:', res.data.email);
      return res.data.email;
    }
  } catch (e) {
    console.warn('[getUserEmail] oauth2.userinfo failed:', e.message);
  }

  // Method 1: id_token JWT payload
  if (tokens.id_token) {
    try {
      const payload = tokens.id_token.split('.')[1];
      const padded = payload + '='.repeat((4 - payload.length % 4) % 4);
      const decoded = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
      if (decoded.email) {
        console.log('[getUserEmail] from id_token:', decoded.email);
        return decoded.email;
      }
    } catch (e) {
      console.warn('[getUserEmail] id_token decode failed:', e.message);
    }
  }

  // Method 2: People API emailAddresses
  try {
    const people = google.people({ version: 'v1', auth: client });
    const res = await people.people.get({ resourceName: 'people/me', personFields: 'emailAddresses' });
    const email = res.data.emailAddresses?.[0]?.value || null;
    if (email) {
      console.log('[getUserEmail] from People API:', email);
      return email;
    }
  } catch (e) {
    console.warn('[getUserEmail] People API failed:', e.message);
  }

  // Method 3: calendarList.list last resort
  try {
    const calendar = google.calendar({ version: 'v3', auth: client });
    const res = await calendar.calendarList.list({ maxResults: 10 });
    const primary = (res.data.items || []).find(c => c.primary === true);
    const email = primary?.id || null;
    console.log('[getUserEmail] from calendarList:', email);
    return email;
  } catch (e) {
    console.warn('[getUserEmail] calendarList fallback failed:', e.message);
    return null;
  }
}

module.exports = {
  getAuthUrl,
  exchangeCodeForTokens,
  getUpcomingMeetings,
  getUpcomingTeamsMeetings,
  getUserFirstName,
  getUserEmail,
};
