/* ============================================================
   Rangmanch Attendance — Admin App
   Backed by a Google Sheet via the Apps Script API in api.js (see that
   file for API_URL setup). Data model mirrors the old Firestore one:
     admins  -> {uid, email, role:'owner'|'manager', clubs:[clubId,...]}
     clubs   -> {id, name, createdAt, createdBy}
     events  -> {id, clubId, name, description, startDate, endDate,
                 checkinOpen, checkinDate, createdAt, createdBy}
     students-> {id, clubId, eventId, name, year, rollNo, addedAt,
                 attendance: { "YYYY-MM-DD": true, ... }}
   No realtime push from Sheets, so lists poll every few seconds while
   their screen is open — near-instant without needing a paid backend.
   ============================================================ */

const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slug = s => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
// BUGFIX: was new Date().toISOString().slice(0,10), which reads the UTC date, not the
// visitor's local date. For timezones ahead of UTC (e.g. India, UTC+5:30) this made
// "today" report yesterday's date for the first few hours after local midnight, which
// threw off event status (upcoming/active/ended), the default attendance date, and the
// check-in date shown to admins. Build the string from local Date fields instead.
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const fmtDate = d => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
// Renders an optional "HH:MM" 24h time as a friendly 12h string, e.g. "14:05" -> "2:05 PM".
const fmtTime = t => t ? new Date(`2000-01-01T${t}:00`).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
// Appends " · start–end" to a date-range line when either time is set; omitted entirely
// for all-day events with no time picked.
const dateTimeRange = ev => `${esc(ev.startDate)} → ${esc(ev.endDate)}` + ((ev.startTime || ev.endTime) ? ` · ${esc(fmtTime(ev.startTime))}${ev.endTime ? ' – ' + esc(fmtTime(ev.endTime)) : ''}` : '');

function dateRange(start, end) {
  const out = []; let d = new Date(start + 'T00:00:00'); const last = new Date(end + 'T00:00:00');
  while (d <= last) { out.push(d.toISOString().slice(0, 10)); d.setDate(d.getDate() + 1); }
  return out;
}
function eventStatus(ev) {
  const t = todayStr();
  if (t < ev.startDate) return 'upcoming';
  if (t > ev.endDate) return 'ended';
  return 'active';
}
function statusPill(status) {
  const map = { active: ['ok', 'Active'], upcoming: ['warn', 'Upcoming'], ended: ['muted-pill', 'Ended'] };
  const [cls, label] = map[status];
  return `<span class="pill ${cls}">${label}</span>`;
}

function theme() { document.body.classList.toggle('dark', localStorage.theme === 'dark'); }
function toggleTheme() { localStorage.theme = localStorage.theme === 'dark' ? 'light' : 'dark'; theme(); }
function msg(text, ok = false) {
  const e = $('.error'); if (!e) return;
  e.textContent = text; e.className = ok ? 'ok-text' : 'error';
}
function download(filename, content, type = 'text/csv') {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------------- state ---------------- */
let me = null; // {uid,email,role,clubs,token}
let state = {
  clubs: [], currentClubId: null, currentEventId: null,
  events: [], students: [], currentEvent: null,
  eventTab: 'roster', attnDate: todayStr(), histDate: null, admins: []
};
const timers = {};
function clearTimer(key) { if (timers[key]) { clearInterval(timers[key]); delete timers[key]; } }
function clearAllTimers() { Object.keys(timers).forEach(clearTimer); }
// Was 4000ms — that was hitting the Apps Script backend (which is inherently slow,
// often 1-3s+ per call) every 4 seconds even when nothing changed, adding to perceived
// lag and occasional throttling. 8000ms halves the background request volume while still
// refreshing often enough for live attendance/roster viewing.
const POLL_MS = 8000;

/* ---------------- boot ---------------- */
function setup() {
  if (!CONFIGURED) return setupMissing();
  theme();
  const token = localStorage.getItem('rmToken');
  if (!token) return checkBootstrapThenAuth();
  callApi('me', {}, token).then(m => { me = { ...m, token }; renderDashboard(); })
    .catch(() => { localStorage.removeItem('rmToken'); checkBootstrapThenAuth(); });
}
function setupMissing() {
  document.getElementById('app').innerHTML = `<div class="card login"><h1>Rangmanch Attendance</h1>
    <p class="muted">Deployment setup required</p>
    <p>Open <b>api.js</b> and paste your deployed Apps Script Web App URL into <b>API_URL</b>.
    See README_DEPLOY.md.</p></div>`;
}
async function checkBootstrapThenAuth() {
  try {
    const status = await callApi('bootstrapStatus', {});
    status.needsBootstrap ? renderRegister() : renderLogin();
  } catch (e) { renderLogin(); }
}

function isOwner() { return me && me.role === 'owner'; }
function canAccessClub(clubId) { return isOwner() || (me && me.clubs.includes(clubId)); }

/* ---------------- login / first-run owner setup ---------------- */
function renderRegister() {
  clearAllTimers();
  document.getElementById('app').innerHTML = `<div class="card login">
    <h1>Rangmanch Attendance</h1><p class="muted">First run — create the owner account</p>
    <form id="register">
      <label>Email</label><input id="rEm" type="email" required autocomplete="username">
      <label>Password</label><input id="rPw" type="password" minlength="8" required autocomplete="new-password">
      <button class="primary" style="width:100%">Create owner account</button>
      <p class="error"></p>
    </form></div>`;
  $('#register').onsubmit = async e => {
    e.preventDefault();
    try {
      const { token, me: m } = await callApi('register', { email: $('#rEm').value.trim(), password: $('#rPw').value });
      localStorage.setItem('rmToken', token); me = { ...m, token }; renderDashboard();
    } catch (x) { msg(x.message); }
  };
}
function renderLogin() {
  clearAllTimers();
  document.getElementById('app').innerHTML = `<div class="card login">
    <h1>Rangmanch Attendance</h1><p class="muted">Admin sign in</p>
    <form id="login">
      <label>Email</label><input id="em" type="email" required autocomplete="username">
      <label>Password</label><input id="pw" type="password" minlength="8" required autocomplete="current-password">
      <button class="primary" style="width:100%">Sign in</button>
      <p class="error"></p>
    </form></div>`;
  $('#login').onsubmit = async e => {
    e.preventDefault();
    try {
      const { token, me: m } = await callApi('login', { email: $('#em').value.trim(), password: $('#pw').value });
      localStorage.setItem('rmToken', token); me = { ...m, token }; renderDashboard();
    } catch (x) { msg(x.message || 'Invalid email or password.'); }
  };
}
function logout() {
  localStorage.removeItem('rmToken'); me = null; clearAllTimers(); checkBootstrapThenAuth();
}

/* ---------------- shell ---------------- */
function shell(bodyHtml) {
  document.getElementById('app').innerHTML = `
    <div class="topbar">
      <div class="brand"><span class="brand-dot"></span> Rangmanch Attendance</div>
      <div class="actions">
        <span class="email desktop-only">${esc(me.email)}${isOwner() ? ' · owner' : ''}</span>
        <button class="small" onclick="toggleTheme()">Theme</button>
        <button class="small" onclick="logout()">Logout</button>
      </div>
    </div>
    <div class="shell">
      <div class="sidebar"><div class="sidebar-inner">${sidebarItems()}</div></div>
      <main>${bodyHtml}</main>
    </div>`;
}
function sidebarItems() {
  let html = state.clubs.filter(c => canAccessClub(c.id)).map(c => `
    <div class="side-item ${state.currentClubId === c.id && !state.currentEventId ? 'active' : ''}"
         onclick="selectClub('${c.id}')">${esc(c.name)}</div>`).join('');
  if (isOwner()) {
    html += `<div class="side-item ${state.currentClubId === '__admins__' ? 'active' : ''}" onclick="renderAdminsPage()">
      <span>⚙ Manage Admins</span></div>`;
  }
  return html;
}

/* ---------------- dashboard (club list) ---------------- */
async function renderDashboard() {
  clearAllTimers();
  state.currentClubId = null; state.currentEventId = null;
  state.clubs = await callApi('listClubs', {}, me.token);
  const mine = state.clubs.filter(c => canAccessClub(c.id));
  shell(`
    <div class="row"><h1>Clubs</h1>
      ${isOwner() ? `<button class="primary" onclick="showNewClubForm()">+ New club</button>` : ''}
    </div>
    <div id="newClubForm"></div>
    ${mine.length ? `<div class="grid">${mine.map(clubCard).join('')}</div>`
      : `<div class="card empty">No clubs assigned to you yet.</div>`}
  `);
}
function clubCard(c) {
  return `<div class="card" style="cursor:pointer" onclick="selectClub('${c.id}')">
    <h2>${esc(c.name)}</h2><p class="muted small">Tap to view events</p></div>`;
}
function showNewClubForm() {
  $('#newClubForm').innerHTML = `<div class="card tight stack">
    <div class="field-inline">
      <input id="newClubName" placeholder="Club name" style="flex:1;margin:0">
      <button class="primary" onclick="createClub()">Create</button>
      <button class="ghost" onclick="$('#newClubForm').innerHTML=''">Cancel</button>
    </div><p class="error"></p></div>`;
}
async function createClub() {
  const name = $('#newClubName').value.trim();
  if (!name) return msg('Enter a club name.');
  try { await callApi('createClub', { name }, me.token); renderDashboard(); }
  catch (e) { msg(e.message); }
}

/* ---------------- club page (events list) ---------------- */
async function selectClub(clubId) {
  clearAllTimers();
  state.currentClubId = clubId; state.currentEventId = null;
  const club = state.clubs.find(c => c.id === clubId);
  shell(`<div class="row"><div>
      <div class="breadcrumb"><b onclick="renderDashboard()">Clubs</b> <span class="sep">/</span> ${esc(club.name)}</div>
      <h1>${esc(club.name)}</h1><p class="muted">Events for this club</p></div>
      <button class="primary" onclick="showNewEventForm()">+ New event</button>
    </div>
    <div id="newEventForm"></div>
    <div id="eventsList"><div class="empty">Loading…</div></div>`);
  await refreshEvents();
  timers.events = setInterval(refreshEvents, POLL_MS);
}
let eventsFetchInFlight = false;
async function refreshEvents() {
  // Guard against overlapping polls: if a previous listEvents call hasn't returned yet
  // (slow Apps Script response), skip this tick instead of queueing another request on
  // top of it — request pile-up was making things feel slower and more error-prone, not less.
  if (!state.currentClubId || eventsFetchInFlight) return;
  eventsFetchInFlight = true;
  try {
    state.events = await callApi('listEvents', { clubId: state.currentClubId }, me.token);
    renderEventsList();
  } catch (e) { console.error(e); }
  finally { eventsFetchInFlight = false; }
}
function renderEventsList() {
  const el = $('#eventsList'); if (!el) return;
  if (!state.events.length) { el.innerHTML = `<div class="card empty">No events yet. Create one above.</div>`; return; }
  el.innerHTML = `<div class="grid">${state.events.map(ev => `
    <div class="card" style="cursor:pointer" onclick="selectEvent('${ev.id}')">
      <div class="row"><h2>${esc(ev.name)}</h2>${statusPill(eventStatus(ev))}</div>
      <p class="muted small">${dateTimeRange(ev)}</p>
      ${ev.description ? `<p class="small">${esc(ev.description)}</p>` : ''}
    </div>`).join('')}</div>`;
}
function showNewEventForm() {
  $('#newEventForm').innerHTML = `<div class="card stack">
    <label>Event name</label><input id="evName" placeholder="e.g. Annual Workshop">
    <label>Description (optional)</label><input id="evDesc" placeholder="Short description">
    <div class="row"><div style="flex:1"><label>Start date</label><input id="evStart" type="date"></div>
      <div style="flex:1"><label>End date</label><input id="evEnd" type="date"></div></div>
    <div class="row"><div style="flex:1"><label>Start time</label><input id="evStartTime" type="time"></div>
      <div style="flex:1"><label>End time</label><input id="evEndTime" type="time"></div></div>
    <div class="field-inline">
      <button class="primary" onclick="submitNewEvent()">Create event</button>
      <button class="ghost" onclick="$('#newEventForm').innerHTML=''">Cancel</button>
    </div><p class="error"></p></div>`;
  $('#evStart').value = todayStr(); $('#evEnd').value = todayStr();
}
async function submitNewEvent() {
  const name = $('#evName').value.trim(), desc = $('#evDesc').value.trim();
  const start = $('#evStart').value, end = $('#evEnd').value;
  const startTime = $('#evStartTime').value, endTime = $('#evEndTime').value;
  if (!name) return msg('Enter an event name.');
  if (!start || !end) return msg('Select start and end dates.');
  if (end < start) return msg('End date must be after start date.');
  if (!startTime || !endTime) return msg('Select a start and end time.');
  if (start === end && endTime <= startTime) return msg('End time must be after start time.');
  try {
    const created = await callApi('createEvent', { clubId: state.currentClubId, name, description: desc, startDate: start, endDate: end, startTime, endTime }, me.token);
    state.events.push(created);
    state.events.sort((a, b) => String(b.startDate).localeCompare(String(a.startDate)));
    $('#newEventForm').innerHTML = '';
    renderEventsList();
  } catch (e) { msg(e.message); }
}

/* ---------------- event page ---------------- */
async function selectEvent(eventId) {
  clearTimer('students'); clearTimer('events');
  // BUGFIX: state.histDate used to persist across events, so opening History on a
  // different event kept showing a stale date (often one that isn't even in this
  // event's range) with no tab highlighted. Reset it whenever we switch events.
  state.currentEventId = eventId; state.eventTab = 'roster'; state.attnDate = todayStr(); state.histDate = null;
  state.currentEvent = await callApi('getEvent', { clubId: state.currentClubId, eventId }, me.token);
  renderEventPage();
  renderEventTabBody(); // initial render of the tab body (roster tab, before the first poll lands)
  await refreshStudents();
  timers.students = setInterval(refreshStudents, POLL_MS);
}
let studentsFetchInFlight = false;
async function refreshStudents() {
  // Same overlap guard as refreshEvents — skip a poll tick rather than stacking a second
  // in-flight request behind a slow one.
  if (!state.currentEventId || studentsFetchInFlight) return;
  studentsFetchInFlight = true;
  try {
    state.students = await callApi('listStudents', { clubId: state.currentClubId, eventId: state.currentEventId }, me.token);
    onStudentsUpdate();
  } catch (e) { console.error(e); }
  finally { studentsFetchInFlight = false; }
}
function renderEventPage() {
  const club = state.clubs.find(c => c.id === state.currentClubId);
  const ev = state.currentEvent;
  shell(`
    <div class="breadcrumb">
      <b onclick="renderDashboard()">Clubs</b> <span class="sep">/</span>
      <b onclick="selectClub('${club.id}')">${esc(club.name)}</b> <span class="sep">/</span> ${esc(ev.name)}
    </div>
    <div class="row"><div><h1>${esc(ev.name)}</h1>
      <p class="muted">${dateTimeRange(ev)} ${statusPill(eventStatus(ev))}</p></div>
      <button class="small" onclick="exportCSV()">⬇ Export CSV</button>
    </div>
    <div class="tabs">
      ${['roster', 'attendance', 'analytics', 'history'].map(t => `
        <button class="tab ${state.eventTab === t ? 'active' : ''}" onclick="setEventTab('${t}')">
          ${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}
    </div>
    <div id="eventTabBody"><div class="empty">Loading…</div></div>`);
}
function setEventTab(tab) { state.eventTab = tab; renderEventPage(); renderEventTabBody(); }
function renderEventTabBody() {
  const el = $('#eventTabBody'); if (!el) return;
  if (state.eventTab === 'roster') return renderRosterTab(el);
  if (state.eventTab === 'attendance') return renderAttendanceTab(el);
  if (state.eventTab === 'analytics') return renderAnalyticsTab(el);
  if (state.eventTab === 'history') return renderHistoryTab(el);
}
// Called whenever a poll refreshes the roster. Avoids nuking whatever the admin is mid-typing
// (roster search / add-student form) or re-drawing the QR needlessly — only the live data
// portions refresh; the full tab only re-renders on tab/event switches.
function onStudentsUpdate() {
  const el = $('#eventTabBody'); if (!el) return;
  if (state.eventTab === 'roster') return $('#rosterRows') ? filterRoster() : renderRosterTab(el);
  if (state.eventTab === 'attendance') return $('#attnRows') ? renderAttendanceRows() : renderAttendanceTab(el);
  if (state.eventTab === 'analytics') return renderAnalyticsTab(el);
  if (state.eventTab === 'history') return renderHistoryTab(el);
}

/* ---------------- roster tab ---------------- */
function renderRosterTab(el) {
  const rows = state.students.map(studentRowHtml).join('');
  el.innerHTML = `
    <div class="card stack">
      <h2>Add student to this event's list</h2>
      <div class="row">
        <input id="stName" placeholder="Full name" style="flex:2;margin:0">
        <select id="stYear" style="flex:1;margin:0">
          <option value="1">1st Year</option><option value="2">2nd Year</option><option value="3">3rd Year</option><option value="4">4th Year</option>
        </select>
        <input id="stRoll" placeholder="Roll no (optional)" style="flex:1;margin:0">
        <button class="primary" onclick="addStudent()">Add</button>
        <button class="ghost" onclick="showImportStudents()">Import list</button>
      </div><p class="error"></p>
      <div id="importStudentsBox"></div>
    </div>
    <div class="card">
      <div class="row"><h2>Roster (<span id="rosterCount">${state.students.length}</span>)</h2>
        <input id="rosterSearch" placeholder="Search name…" style="max-width:220px;margin:0" oninput="filterRoster()"></div>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Year</th><th>Roll no</th><th>Present days</th><th>Actions</th></tr></thead>
        <tbody id="rosterRows">${rows || `<tr><td colspan="5" class="empty">No students added yet.</td></tr>`}</tbody></table></div>
    </div>`;
}
function showImportStudents() {
  $('#importStudentsBox').innerHTML = `<div class="card stack" style="margin-top:10px">
    <h2>Import students</h2>
    <p class="muted small">Paste one student per line. Each line can be just a name, or "Name, Year, Roll no" (year and roll no optional). Duplicate names already on the roster are skipped automatically.</p>
    <textarea id="importText" rows="8" style="width:100%;font:inherit" placeholder="Utkarsh Agarwal, 2, 2028236&#10;Priya Sharma, 1&#10;Rahul Verma"></textarea>
    <div class="field-inline">
      <button class="primary" onclick="submitImportStudents()">Import</button>
      <button class="ghost" onclick="$('#importStudentsBox').innerHTML=''">Cancel</button>
    </div><p class="error" id="importError"></p></div>`;
}
function parseImportLine_(line) {
  const parts = line.split(',').map(p => p.trim());
  return { name: parts[0] || '', year: parts[1] || '', rollNo: parts[2] || '' };
}
async function submitImportStudents() {
  const raw = $('#importText').value;
  const rows = raw.split('\n').map(l => l.trim()).filter(Boolean).map(parseImportLine_).filter(r => r.name.length >= 2);
  const errEl = $('#importError');
  if (!rows.length) { errEl.textContent = 'Paste at least one valid name.'; return; }
  try {
    const result = await callApi('importStudents', { clubId: state.currentClubId, eventId: state.currentEventId, students: rows }, me.token);
    result.created.forEach(s => state.students.push(s));
    state.students.sort((a, b) => a.name.localeCompare(b.name));
    $('#importStudentsBox').innerHTML = '';
    onStudentsUpdate();
    const skippedNote = result.skipped.length ? ` (${result.skipped.length} skipped as duplicates/invalid: ${result.skipped.slice(0, 5).join(', ')}${result.skipped.length > 5 ? '…' : ''})` : '';
    msg(`Imported ${result.created.length} student(s).${skippedNote}`, true);
  } catch (e) { errEl.textContent = e.message; }
}
function studentRowHtml(s) {
  return `<tr><td data-label="Name">${esc(s.name)}</td><td data-label="Year">${esc(s.year)}</td>
    <td data-label="Roll no">${esc(s.rollNo || '—')}</td>
    <td data-label="Present days">${Object.values(s.attendance || {}).filter(Boolean).length}</td>
    <td data-label="Actions"><button class="small" onclick="editStudent('${s.id}')">Edit</button>
    <button class="small danger" onclick="deleteStudent('${s.id}')">Delete</button></td></tr>`;
}
function filterRoster() {
  const searchEl = $('#rosterSearch');
  const q = searchEl ? searchEl.value.trim().toLowerCase() : '';
  const filtered = state.students.filter(s => s.name.toLowerCase().includes(q));
  const countEl = $('#rosterCount'); if (countEl) countEl.textContent = state.students.length;
  $('#rosterRows').innerHTML = filtered.map(studentRowHtml).join('') || `<tr><td colspan="5" class="empty">No matches.</td></tr>`;
}
async function addStudent() {
  const name = $('#stName').value.trim().replace(/\s+/g, ' ');
  const year = Number($('#stYear').value);
  const rollNo = $('#stRoll').value.trim();
  if (name.length < 2) return msg('Enter a valid name.');
  if (state.students.some(s => s.name.toLowerCase() === name.toLowerCase())) return msg('This name is already on the list.');
  try {
    // The addStudent action already returns the created student, so update local state
    // from that instead of firing a second full listStudents round trip right after it —
    // this was doubling the wait on every add. The regular poll keeps things in sync.
    const created = await callApi('addStudent', { clubId: state.currentClubId, eventId: state.currentEventId, name, year, rollNo }, me.token);
    state.students.push(created);
    state.students.sort((a, b) => a.name.localeCompare(b.name));
    $('#stName').value = ''; $('#stRoll').value = ''; msg('Added.', true);
    onStudentsUpdate();
  } catch (e) { msg(e.message); }
}
async function editStudent(id) {
  const s = state.students.find(x => x.id === id); if (!s) return;
  const name = prompt('Name', s.name); if (name === null) return;
  if (!name.trim()) return alert('Name cannot be empty.');
  const yearRaw = prompt('Year (1/2/3)', s.year); if (yearRaw === null) return;
  // BUGFIX: Number(yearRaw) was stored unvalidated, so a non-numeric or out-of-range entry
  // (e.g. an empty string or "4") silently saved as NaN and rendered as "NaN" in the roster.
  const year = Number(yearRaw);
  if (![1, 2, 3].includes(year)) return alert('Year must be 1, 2, or 3.');
  const rollNo = prompt('Roll no (optional)', s.rollNo || '') || '';
  try {
    const updated = await callApi('editStudent', { clubId: state.currentClubId, eventId: state.currentEventId, studentId: id, name: name.trim(), year, rollNo: rollNo.trim() }, me.token);
    const idx = state.students.findIndex(x => x.id === id);
    if (idx !== -1) state.students[idx] = updated;
    state.students.sort((a, b) => a.name.localeCompare(b.name));
    onStudentsUpdate();
  } catch (e) { alert(e.message); }
}
async function deleteStudent(id) {
  if (!confirm('Remove this student from the event list? Their attendance record will be deleted.')) return;
  try {
    await callApi('deleteStudent', { clubId: state.currentClubId, eventId: state.currentEventId, studentId: id }, me.token);
    state.students = state.students.filter(x => x.id !== id);
    onStudentsUpdate();
  } catch (e) { alert(e.message); }
}

/* ---------------- attendance tab ---------------- */
function attendanceRowHtml(s) {
  const present = !!(s.attendance || {})[state.attnDate];
  return `<tr><td data-label="Name">${esc(s.name)}</td><td data-label="Year">${esc(s.year)}</td>
    <td data-label="Present">
      <button class="small ${present ? 'primary' : ''}" onclick="toggleAttendance('${s.id}','${state.attnDate}')">
        ${present ? '✓ Present' : 'Mark present'}</button>
    </td></tr>`;
}
function renderAttendanceRows() {
  const tbody = $('#attnRows'); if (!tbody) return;
  tbody.innerHTML = state.students.map(attendanceRowHtml).join('')
    || `<tr><td colspan="3" class="empty">No students in the roster yet — add some in the Roster tab.</td></tr>`;
  const countEl = $('#attnCount'); if (!countEl) return;
  const ev = state.currentEvent;
  const inRange = state.attnDate >= ev.startDate && state.attnDate <= ev.endDate;
  const presentCount = state.students.filter(s => (s.attendance || {})[state.attnDate]).length;
  countEl.textContent = inRange ? `${presentCount} / ${state.students.length} present on ${fmtDate(state.attnDate)}`
    : 'Selected date is outside the event range.';
}
function renderAttendanceTab(el) {
  const ev = state.currentEvent;
  const inRange = state.attnDate >= ev.startDate && state.attnDate <= ev.endDate;
  const rows = state.students.map(attendanceRowHtml).join('');
  const presentCount = state.students.filter(s => (s.attendance || {})[state.attnDate]).length;
  el.innerHTML = `
    <div class="card center">
      <h2>QR check-in</h2>
      <p class="muted">Members scan this to mark themselves present today from the event roster.</p>
      ${ev.checkinOpen ? `
        <div id="qr" class="qr"></div>
        <p><b>Open for ${esc(ev.checkinDate)}</b></p>
        <div class="field-inline center" style="justify-content:center">
          <button class="small" onclick="copyCheckinLink()">Copy link</button>
          <button class="small danger" onclick="closeCheckin()">Close check-in</button>
        </div>` : `
        <p class="muted small">Check-in is currently closed.</p>
        <button class="primary" onclick="openCheckin()" ${eventStatus(ev) === 'ended' ? 'disabled' : ''}>
          Open check-in for today (${todayStr()})</button>
        ${eventStatus(ev) === 'ended' ? '<p class="small muted">This event has ended.</p>' : ''}`}
    </div>
    <div class="card">
      <div class="row"><h2>Mark / review attendance</h2>
        <input type="date" id="attnDatePick" value="${state.attnDate}" min="${ev.startDate}" max="${ev.endDate}"
          style="width:auto;margin:0" onchange="changeAttnDate(this.value)"></div>
      <p class="muted small" id="attnCount">${inRange ? `${presentCount} / ${state.students.length} present on ${fmtDate(state.attnDate)}` : 'Selected date is outside the event range.'}</p>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Year</th><th>Present</th></tr></thead>
        <tbody id="attnRows">${rows || `<tr><td colspan="3" class="empty">No students in the roster yet — add some in the Roster tab.</td></tr>`}</tbody></table></div>
    </div>`;
  if (ev.checkinOpen) {
    const link = location.origin + location.pathname.replace(/index\.html$/, '') + `checkin.html?c=${state.currentClubId}&e=${state.currentEventId}`;
    $('#qr').innerHTML = '';
    new QRCode($('#qr'), { text: link, width: 220, height: 220 });
  }
}
function changeAttnDate(v) { state.attnDate = v; renderAttendanceTab($('#eventTabBody')); }
async function toggleAttendance(studentId, date) {
  try {
    // This fires on every single tap of "Mark present" — it was paying for a full
    // listStudents round trip after every toggle on top of the toggle itself, which is
    // the slowest, most noticeable spot in the app. toggleAttendance already returns the
    // updated student, so just patch it into local state instead of re-fetching everything.
    const updated = await callApi('toggleAttendance', { clubId: state.currentClubId, eventId: state.currentEventId, studentId, date }, me.token);
    const idx = state.students.findIndex(x => x.id === studentId);
    if (idx !== -1) state.students[idx] = updated;
    onStudentsUpdate();
  } catch (e) { alert(e.message); }
}
async function openCheckin() {
  state.currentEvent = await callApi('setCheckin', { clubId: state.currentClubId, eventId: state.currentEventId, open: true }, me.token);
  state.attnDate = todayStr();
  renderAttendanceTab($('#eventTabBody'));
}
async function closeCheckin() {
  if (!confirm('Close check-in? The QR will stop working.')) return;
  state.currentEvent = await callApi('setCheckin', { clubId: state.currentClubId, eventId: state.currentEventId, open: false }, me.token);
  renderAttendanceTab($('#eventTabBody'));
}
function copyCheckinLink() {
  const link = location.origin + location.pathname.replace(/index\.html$/, '') + `checkin.html?c=${state.currentClubId}&e=${state.currentEventId}`;
  navigator.clipboard?.writeText(link).then(() => alert('Check-in link copied.'), () => prompt('Copy this link:', link));
}

/* ---------------- analytics tab ---------------- */
function renderAnalyticsTab(el) {
  const ev = state.currentEvent;
  const allDates = dateRange(ev.startDate, ev.endDate);
  const elapsedDates = allDates.filter(d => d <= todayStr());
  const total = state.students.length;
  const perDateCounts = elapsedDates.map(d => state.students.filter(s => (s.attendance || {})[d]).length);
  const avgPct = elapsedDates.length && total
    ? Math.round(100 * perDateCounts.reduce((a, b) => a + b, 0) / (elapsedDates.length * total)) : 0;
  const perStudent = state.students.map(s => {
    const present = elapsedDates.filter(d => (s.attendance || {})[d]).length;
    const pct = elapsedDates.length ? Math.round(100 * present / elapsedDates.length) : 0;
    return { ...s, present, pct };
  }).sort((a, b) => a.pct - b.pct);

  el.innerHTML = `
    <div class="stat-grid">
      <div class="stat"><div class="num">${total}</div><div class="lbl">Students on roster</div></div>
      <div class="stat"><div class="num">${elapsedDates.length}/${allDates.length}</div><div class="lbl">Days elapsed / total</div></div>
      <div class="stat"><div class="num">${avgPct}%</div><div class="lbl">Average attendance</div></div>
      <div class="stat"><div class="num">${perStudent.filter(s => s.pct < 50).length}</div><div class="lbl">Students below 50%</div></div>
    </div>
    <div class="card">
      <h2>Attendance per day</h2>
      ${elapsedDates.length ? `<div class="bars">${elapsedDates.map((d, i) => {
        const pct = total ? Math.round(100 * perDateCounts[i] / total) : 0;
        return `<div class="bar-col" title="${d}: ${perDateCounts[i]}/${total}">
          <div class="bar" style="height:${Math.max(pct, 2)}%"></div>
          <div class="bar-label">${d.slice(5)}</div></div>`;
      }).join('')}</div>` : `<p class="empty">No elapsed days yet.</p>`}
    </div>
    <div class="card">
      <h2>Per-student attendance</h2>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Year</th><th>Present days</th><th>Attendance %</th></tr></thead>
        <tbody>${perStudent.map(s => `<tr>
          <td data-label="Name">${esc(s.name)}</td><td data-label="Year">${esc(s.year)}</td>
          <td data-label="Present">${s.present}/${elapsedDates.length}</td>
          <td data-label="Attendance %"><div class="row" style="gap:8px">
            <div class="attn-bar-track"><div class="attn-bar-fill" style="width:${s.pct}%"></div></div>
            <b class="small">${s.pct}%</b></div></td>
        </tr>`).join('') || `<tr><td colspan="4" class="empty">No students yet.</td></tr>`}</tbody></table></div>
    </div>`;
}

/* ---------------- history tab ---------------- */
function renderHistoryTab(el) {
  const ev = state.currentEvent;
  const allDates = dateRange(ev.startDate, ev.endDate).filter(d => d <= todayStr()).reverse();
  if (!state.histDate && allDates.length) state.histDate = allDates[0];
  el.innerHTML = `
    <div class="card">
      <h2>Browse past dates</h2>
      <div class="tabs">${allDates.map(d => `
        <button class="tab ${state.histDate === d ? 'active' : ''}" onclick="viewHistoryDate('${d}')">${d.slice(5)}</button>`).join('') || '<p class="muted">No elapsed dates yet.</p>'}</div>
    </div>
    <div id="histBody"></div>`;
  if (state.histDate) viewHistoryDate(state.histDate);
}
function viewHistoryDate(d) {
  state.histDate = d;
  const present = state.students.filter(s => (s.attendance || {})[d]);
  const absent = state.students.filter(s => !(s.attendance || {})[d]);
  const body = $('#histBody');
  if (!body) return;
  body.innerHTML = `
    <div class="card">
      <h2>${fmtDate(d)} — ${present.length}/${state.students.length} present</h2>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Year</th><th>Status</th></tr></thead>
        <tbody>${[...present.map(s => ({ s, ok: true })), ...absent.map(s => ({ s, ok: false }))]
          .sort((a, b) => a.s.name.localeCompare(b.s.name))
          .map(({ s, ok }) => `<tr><td data-label="Name">${esc(s.name)}</td><td data-label="Year">${esc(s.year)}</td>
            <td data-label="Status"><span class="pill ${ok ? 'ok' : 'muted-pill'}">${ok ? 'Present' : 'Absent'}</span></td></tr>`).join('')
          || `<tr><td colspan="3" class="empty">No students.</td></tr>`}</tbody></table></div>
    </div>`;
  const tabButtons = document.querySelectorAll('#eventTabBody .tabs .tab');
  tabButtons.forEach(b => b.classList.toggle('active', b.textContent.trim() === d.slice(5)));
}

/* ---------------- export ---------------- */
function exportCSV() {
  const ev = state.currentEvent;
  const dates = dateRange(ev.startDate, ev.endDate).filter(d => d <= todayStr());
  const header = ['Name', 'Year', 'Roll No', ...dates, 'Present Days', 'Attendance %'];
  const lines = [header.join(',')];
  // BUGFIX: rollNo was interpolated straight into the CSV row unquoted, so a roll number
  // containing a comma (or stray quote) silently corrupted the column alignment of the
  // exported file. Quote/escape it the same way the name field already is.
  const csvField = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  state.students.forEach(s => {
    const marks = dates.map(d => (s.attendance || {})[d] ? '1' : '0');
    const present = marks.filter(m => m === '1').length;
    const pct = dates.length ? Math.round(100 * present / dates.length) : 0;
    lines.push([csvField(s.name), s.year, csvField(s.rollNo || ''), ...marks, present, pct + '%'].join(','));
  });
  download(`${slug(ev.name)}_attendance.csv`, lines.join('\n'));
}

/* ---------------- admins management (owner only) ---------------- */
async function renderAdminsPage() {
  if (!isOwner()) return;
  clearTimer('students'); clearTimer('events');
  state.currentClubId = '__admins__'; state.currentEventId = null;
  state.admins = await callApi('listAdmins', {}, me.token);
  const clubOptions = state.clubs.map(c => c.id);
  shell(`
    <h1>Manage Admins</h1>
    <p class="muted">Create a login for a manager or another owner right here — set their email and a
    temporary password, no separate account-creation step needed.</p>
    <div class="card stack">
      <h2>Add admin</h2>
      <input id="admEmail" type="email" placeholder="Email">
      <input id="admPw" type="password" placeholder="Temporary password (min 8 characters)" minlength="8">
      <label>Role</label>
      <select id="admRole" onchange="$('#admClubsWrap').classList.toggle('hidden', this.value==='owner')">
        <option value="manager">Manager (assigned clubs only)</option><option value="owner">Owner (full access)</option>
      </select>
      <div id="admClubsWrap"><label>Clubs (for managers)</label>
      <div class="row">${clubOptions.map(id => `<label class="small" style="font-weight:400"><input type="checkbox" style="width:auto" class="admClub" value="${id}"> ${esc(state.clubs.find(c => c.id === id).name)}</label>`).join('') || '<span class="muted small">No clubs created yet.</span>'}</div></div>
      <button class="primary" onclick="addAdmin()">Add admin</button>
      <p class="error"></p>
    </div>
    <div class="card">
      <h2>Current admins</h2>
      <div class="table-wrap"><table><thead><tr><th>Email</th><th>Role</th><th>Clubs</th><th>Actions</th></tr></thead>
        <tbody>${state.admins.map(a => `<tr>
          <td data-label="Email">${esc(a.email)}</td>
          <td data-label="Role">${esc(a.role)}</td>
          <td data-label="Clubs">${a.role === 'owner' ? 'All' : (a.clubs || []).map(id => esc(state.clubs.find(c => c.id === id)?.name || id)).join(', ') || '—'}</td>
          <td data-label="Actions">${a.uid !== me.uid ? `<button class="small danger" onclick="removeAdmin('${a.uid}')">Remove</button>` : '<span class="small muted">You</span>'}</td>
        </tr>`).join('') || `<tr><td colspan="4" class="empty">No admins yet.</td></tr>`}</tbody></table></div>
    </div>`);
}
async function addAdmin() {
  const email = $('#admEmail').value.trim(), password = $('#admPw').value, role = $('#admRole').value;
  const clubs = Array.from(document.querySelectorAll('.admClub:checked')).map(c => c.value);
  if (!email) return msg('Enter an email.');
  if (password.length < 8) return msg('Password must be at least 8 characters.');
  try { await callApi('addAdmin', { email, password, role, clubs }, me.token); renderAdminsPage(); }
  catch (e) { msg(e.message); }
}
async function removeAdmin(uid) {
  if (!confirm('Remove this admin\'s access?')) return;
  try { await callApi('removeAdmin', { uid }, me.token); renderAdminsPage(); }
  catch (e) { alert(e.message); }
}

setup();