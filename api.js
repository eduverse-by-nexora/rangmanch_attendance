/* ============================================================
   Rangmanch Attendance — API client
   Talks to the Google Apps Script Web App that sits on top of a Google
   Sheet (the free, no-cost replacement for Firebase). One config value
   to fill in after deploying Code.gs — see README_DEPLOY.md.
   ============================================================ */
const API_URL = 'https://script.google.com/macros/s/AKfycbz-JuFtL_8rzJHES5DQ_gsYNElP6BtThVisiVj-Yj6wVc4v4fScGUtkAeti-KMXW9g7eQ/exec';
const CONFIGURED = !API_URL.startsWith('PASTE_');

// Apps Script executions can occasionally hang (cold start, quota contention) with no
// network-level failure, which left callers waiting indefinitely with no feedback. Bound
// every request so a stuck call fails fast with a clear message instead of hanging.
// Lowered from 25000: a cold Apps Script instance almost always resolves well inside 12s,
// so a shorter per-try timeout combined with an automatic retry (below) gets a working
// response back to the user *faster* on average than one long 25s wait ever did.
const API_TIMEOUT_MS = 12000;

// Only actions that purely read data are safe to silently retry: if the first attempt's
// response just arrived late (rather than never reaching the server), retrying a read
// re-fetches the same data with no side effects. Actions that write are deliberately left
// out — e.g. retrying toggleAttendance after an unseen success would flip it right back,
// and retrying createEvent could create a duplicate. Those still get one clean attempt with
// the same clear error as before, just after a shorter wait.
const RETRYABLE_ACTIONS = new Set([
  'bootstrapStatus', 'me', 'listClubs', 'listEvents', 'getEvent',
  'listStudents', 'listAdmins', 'checkinInfo'
]);
const RETRY_DELAYS_MS = [400, 900]; // up to 2 retries (3 attempts total) for retryable actions

function sleep_(ms) { return new Promise(r => setTimeout(r, ms)); }

async function callApiOnce_(action, payload, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      // text/plain avoids a CORS preflight that Apps Script web apps can't answer;
      // the body is still parsed as JSON on the server.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, payload: payload || {}, token: token || null }),
      signal: controller.signal
    });
  } catch (e) {
    if (e.name === 'AbortError') { const err = new Error('The request took too long and was cancelled. Please try again.'); err.timedOut = true; throw err; }
    const err = new Error(e.message || 'Network error.'); err.timedOut = true; throw err;
  } finally {
    clearTimeout(timer);
  }
  let data;
  try { data = await res.json(); }
  catch (e) { throw new Error('The server did not return a valid response. Check the API_URL in api.js.'); }
  if (!data.ok) throw new Error(data.error || 'Request failed.');
  return data.data;
}

async function callApi(action, payload, token) {
  const retries = RETRYABLE_ACTIONS.has(action) ? RETRY_DELAYS_MS : [];
  for (let attempt = 0; ; attempt++) {
    try {
      return await callApiOnce_(action, payload, token);
    } catch (e) {
      const canRetry = e.timedOut && attempt < retries.length;
      if (!canRetry) throw e;
      await sleep_(retries[attempt]);
    }
  }
}