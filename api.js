/* ============================================================
   Rangmanch Attendance — API client
   Talks to the Google Apps Script Web App that sits on top of a Google
   Sheet (the free, no-cost replacement for Firebase). One config value
   to fill in after deploying Code.gs — see README_DEPLOY.md.
   ============================================================ */
const API_URL = 'https://script.google.com/macros/s/AKfycbz-JuFtL_8rzJHES5DQ_gsYNElP6BtThVisiVj-Yj6wVc4v4fScGUtkAeti-KMXW9g7eQ/exec';
const CONFIGURED = !API_URL.startsWith('PASTE_');

async function callApi(action, payload, token) {
  const res = await fetch(API_URL, {
    method: 'POST',
    // text/plain avoids a CORS preflight that Apps Script web apps can't answer;
    // the body is still parsed as JSON on the server.
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, payload: payload || {}, token: token || null })
  });
  let data;
  try { data = await res.json(); }
  catch (e) { throw new Error('The server did not return a valid response. Check the API_URL in api.js.'); }
  if (!data.ok) throw new Error(data.error || 'Request failed.');
  return data.data;
}
