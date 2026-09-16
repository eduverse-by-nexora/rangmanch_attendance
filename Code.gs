/* ============================================================
   Rangmanch Attendance — Apps Script backend (free Google Sheets database)
   Replaces Firebase Auth + Firestore. Deploy this bound to a Google Sheet
   as a Web App (Execute as: Me, Who has access: Anyone). See README_DEPLOY.md.

   Sheets (auto-created on first request):
     Admins   : id, email, passHash, salt, role, clubs, createdAt
     Clubs    : id, name, createdBy, createdAt
     Events   : id, clubId, name, description, startDate, endDate,
                checkinOpen, checkinDate, createdBy, createdAt
     Students : id, clubId, eventId, name, year, rollNo, attendance(JSON), addedAt
     Meta     : key, value
   ============================================================ */

const SHEETS = {
  Admins: ['id', 'email', 'passHash', 'salt', 'role', 'clubs', 'createdAt'],
  Clubs: ['id', 'name', 'createdBy', 'createdAt'],
  Events: ['id', 'clubId', 'name', 'description', 'startDate', 'endDate', 'checkinOpen', 'checkinDate', 'createdBy', 'createdAt', 'startTime', 'endTime'],
  Students: ['id', 'clubId', 'eventId', 'name', 'year', 'rollNo', 'attendance', 'addedAt'],
  // Tracks which physical device has already submitted a check-in for a given
  // event+checkinDate, so the *server* can refuse a second submission from the same
  // device — the old protection was only a client-side localStorage flag, which anyone
  // could bypass by clearing site data or opening a private tab.
  CheckinLog: ['id', 'eventId', 'checkinDate', 'deviceId', 'studentId', 'submittedAt'],
  Meta: ['key', 'value']
};

/* ---------------- HTTP entry points ---------------- */
function doGet(e) {
  return jsonOut_({ ok: true, message: 'Rangmanch Attendance API is running.' });
}

function doPost(e) {
  try {
    ensureSheets_();
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const action = body.action;
    const payload = body.payload || {};
    const publicActions = { bootstrapStatus: 1, register: 1, login: 1, checkinInfo: 1, checkinSubmit: 1 };
    const me = publicActions[action] ? null : requireAuth_(body.token);
    let data;
    switch (action) {
      case 'bootstrapStatus': data = actionBootstrapStatus(); break;
      case 'register': data = actionRegister(payload); break;
      case 'login': data = actionLogin(payload); break;
      case 'me': data = me; break;
      case 'listClubs': data = actionListClubs(); break;
      case 'createClub': data = actionCreateClub(me, payload); break;
      case 'listEvents': data = actionListEvents(me, payload); break;
      case 'getEvent': data = actionGetEvent(me, payload); break;
      case 'createEvent': data = actionCreateEvent(me, payload); break;
      case 'setCheckin': data = actionSetCheckin(me, payload); break;
      case 'listStudents': data = actionListStudents(me, payload); break;
      case 'addStudent': data = actionAddStudent(me, payload); break;
      case 'importStudents': data = actionImportStudents(me, payload); break;
      case 'editStudent': data = actionEditStudent(me, payload); break;
      case 'deleteStudent': data = actionDeleteStudent(me, payload); break;
      case 'toggleAttendance': data = actionToggleAttendance(me, payload); break;
      case 'listAdmins': data = actionListAdmins(me); break;
      case 'addAdmin': data = actionAddAdmin(me, payload); break;
      case 'removeAdmin': data = actionRemoveAdmin(me, payload); break;
      case 'checkinInfo': data = actionCheckinInfo(payload); break;
      case 'checkinSubmit': data = actionCheckinSubmit(payload); break;
      default: throw new Error('Unknown action: ' + action);
    }
    return jsonOut_({ ok: true, data: data });
  } catch (err) {
    return jsonOut_({ ok: false, error: String((err && err.message) || err) });
  }
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------------- sheet plumbing ---------------- */
// PERF: SpreadsheetApp.getActiveSpreadsheet() was being called fresh every single time
// sheet_() ran (several times per request), and ensureSheets_() re-checked/created all 5
// sheets on *every* request even once they already existed. Memoize the spreadsheet handle
// for this execution and cache the "sheets already exist" fact across executions (6h) so
// normal requests skip straight to reading/writing data instead of redoing setup work.
let _ss = null;
function ss_() { return _ss || (_ss = SpreadsheetApp.getActiveSpreadsheet()); }
// Bump this whenever SHEETS' columns change, so the cached "sheets are ready" flag below
// (from a previous deploy, before the schema changed) doesn't wrongly skip migration.
const SCHEMA_VERSION = '3';
function ensureSheets_() {
  const cache = CacheService.getScriptCache();
  if (cache.get('sheetsReady') === SCHEMA_VERSION) return;
  const ss = ss_();
  Object.keys(SHEETS).forEach(function (name) {
    let sh = ss.getSheetByName(name);
    if (!sh) {
      sh = ss.insertSheet(name);
      sh.getRange(1, 1, 1, SHEETS[name].length).setValues([SHEETS[name]]);
      sh.setFrozenRows(1);
    } else {
      // MIGRATION: a sheet that already existed before startTime/endTime were added to the
      // schema won't have those header columns yet. Append any headers from SHEETS[name]
      // that are missing, at the end, so existing columns/data keep their exact position
      // and nothing already in the sheet shifts or gets overwritten.
      const lastCol = sh.getLastColumn();
      const existingHeaders = lastCol > 0 ? sh.getRange(1, 1, 1, lastCol).getValues()[0] : [];
      const missing = SHEETS[name].filter(function (h) { return existingHeaders.indexOf(h) === -1; });
      if (missing.length) sh.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]);
    }
  });
  const def = ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1 && def.getLastRow() === 0) ss.deleteSheet(def);
  cache.put('sheetsReady', SCHEMA_VERSION, 21600);
}
function sheet_(name) { return ss_().getSheetByName(name); }
// BUGFIX: Google Sheets silently auto-converts text that looks like a date ("2026-10-21")
// or time ("14:30") into a real Date-typed cell. Apps Script then hands that back as a
// full JS Date object, which serializes to JSON as a complete UTC timestamp
// ("2026-10-21T18:30:00.000Z") instead of the clean string the rest of the app expects —
// that's the garbled value that was showing up under event names. Normalize every cell
// back to the plain string format its column name implies, every time a row is read, so
// it doesn't matter whether Sheets converted the cell or not.
function normalizeCell_(header, value) {
  if (!(value instanceof Date)) return value;
  const tz = Session.getScriptTimeZone() || 'Etc/UTC';
  if (/Date$/.test(header)) return Utilities.formatDate(value, tz, 'yyyy-MM-dd');
  if (/Time$/.test(header)) return Utilities.formatDate(value, tz, 'HH:mm');
  return value.toISOString();
}
function readAll_(name) {
  const sh = sheet_(name);
  const vals = sh.getDataRange().getValues();
  const headers = vals.shift();
  const out = [];
  vals.forEach(function (r, idx) {
    if (r[0] === '' || r[0] == null) return;
    const obj = {};
    headers.forEach(function (h, i) { obj[h] = normalizeCell_(h, r[i]); });
    obj.__row = idx + 2;
    out.push(obj);
  });
  return out;
}
function appendRow_(name, obj) {
  const headers = SHEETS[name];
  sheet_(name).appendRow(headers.map(function (h) { return obj[h] !== undefined ? obj[h] : ''; }));
  return obj;
}
function updateRow_(name, rowIndex, obj) {
  const headers = SHEETS[name];
  sheet_(name).getRange(rowIndex, 1, 1, headers.length)
    .setValues([headers.map(function (h) { return obj[h] !== undefined ? obj[h] : ''; })]);
}
function deleteRow_(name, rowIndex) { sheet_(name).deleteRow(rowIndex); }
function findById_(name, id) {
  const rows = readAll_(name);
  for (let i = 0; i < rows.length; i++) if (String(rows[i].id) === String(id)) return rows[i];
  return null;
}
function stripRow_(obj) {
  const o = {};
  Object.keys(obj).forEach(function (k) { if (k !== '__row') o[k] = obj[k]; });
  return o;
}
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ---------------- helpers ---------------- */
function safeParseJSON_(s) { try { return JSON.parse(s || '{}'); } catch (e) { return {}; } }
function slug_(s) { return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); }
function todayStr_() { return Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Etc/UTC', 'yyyy-MM-dd'); }
function getSecret_() {
  const props = PropertiesService.getScriptProperties();
  let s = props.getProperty('AUTH_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); props.setProperty('AUTH_SECRET', s); }
  return s;
}
function hashPassword_(password, salt) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, password + '::' + salt);
  return digest.map(function (b) { return ((b + 256) % 256).toString(16).padStart(2, '0'); }).join('');
}
function randomSalt_() { return Utilities.getUuid(); }
function makeToken_(uid) {
  const payload = { uid: uid, exp: Date.now() + 1000 * 60 * 60 * 24 * 30 };
  const b64 = Utilities.base64EncodeWebSafe(JSON.stringify(payload));
  const sig = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(b64, getSecret_()));
  return b64 + '.' + sig;
}
function verifyToken_(token) {
  if (!token) throw new Error('Not signed in.');
  const parts = String(token).split('.');
  if (parts.length !== 2) throw new Error('Invalid session.');
  const expectedSig = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(parts[0], getSecret_()));
  if (expectedSig !== parts[1]) throw new Error('Invalid session.');
  const payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString());
  if (!payload.exp || payload.exp < Date.now()) throw new Error('Session expired. Please sign in again.');
  return payload;
}
function meFromAdminRow_(a) {
  return { uid: a.id, email: a.email, role: a.role, clubs: a.clubs ? String(a.clubs).split(',').filter(Boolean) : [] };
}
function requireAuth_(token) {
  const payload = verifyToken_(token);
  const admin = findById_('Admins', payload.uid);
  if (!admin) throw new Error('Account no longer has access.');
  return meFromAdminRow_(admin);
}
function isOwner_(me) { return me.role === 'owner'; }
function requireOwner_(me) { if (!isOwner_(me)) throw new Error('Owner access required.'); }
function requireClubAccess_(me, clubId) {
  if (!(isOwner_(me) || me.clubs.indexOf(clubId) !== -1)) throw new Error('You do not have access to this club.');
}
function studentOut_(s) {
  const o = stripRow_(s);
  o.attendance = safeParseJSON_(s.attendance);
  o.year = Number(s.year);
  return o;
}

/* ---------------- auth / bootstrap ---------------- */
function actionBootstrapStatus() { return { needsBootstrap: readAll_('Admins').length === 0 }; }

function actionRegister(payload) {
  return withLock_(function () {
    if (readAll_('Admins').length > 0) throw new Error('An owner account already exists. Please sign in.');
    const email = String(payload.email || '').trim().toLowerCase();
    const password = String(payload.password || '');
    if (!email || email.indexOf('@') === -1) throw new Error('Enter a valid email.');
    if (password.length < 8) throw new Error('Password must be at least 8 characters.');
    const salt = randomSalt_(), id = Utilities.getUuid();
    appendRow_('Admins', { id: id, email: email, passHash: hashPassword_(password, salt), salt: salt, role: 'owner', clubs: '', createdAt: new Date().toISOString() });
    return { token: makeToken_(id), me: { uid: id, email: email, role: 'owner', clubs: [] } };
  });
}

function actionLogin(payload) {
  const email = String(payload.email || '').trim().toLowerCase();
  const password = String(payload.password || '');
  const admin = readAll_('Admins').find(function (a) { return String(a.email).toLowerCase() === email; });
  if (!admin || hashPassword_(password, admin.salt) !== admin.passHash) throw new Error('Invalid email or password.');
  return { token: makeToken_(admin.id), me: meFromAdminRow_(admin) };
}

/* ---------------- clubs ---------------- */
function actionListClubs() {
  const clubs = readAll_('Clubs').map(stripRow_);
  clubs.sort(function (a, b) { return String(a.createdAt).localeCompare(String(b.createdAt)); });
  return clubs;
}
function actionCreateClub(me, payload) {
  requireOwner_(me);
  const name = String(payload.name || '').trim();
  if (!name) throw new Error('Enter a club name.');
  return withLock_(function () {
    const existing = readAll_('Clubs');
    let id = slug_(name) || ('club-' + Date.now()), n = 1;
    while (existing.some(function (c) { return c.id === id; })) id = slug_(name) + '-' + (++n);
    const club = { id: id, name: name, createdBy: me.uid, createdAt: new Date().toISOString() };
    appendRow_('Clubs', club);
    return stripRow_(club);
  });
}

/* ---------------- events ---------------- */
function actionListEvents(me, payload) {
  // BUGFIX: this was missing the requireClubAccess_ check that every other club-scoped
  // action has, so a manager restricted to certain clubs could still list the events of a
  // club they aren't assigned to just by sending its clubId directly.
  requireClubAccess_(me, payload.clubId);
  const events = readAll_('Events').filter(function (e) { return e.clubId === payload.clubId; }).map(stripRow_);
  events.sort(function (a, b) { return String(b.startDate).localeCompare(String(a.startDate)); });
  return events;
}
function actionGetEvent(me, payload) {
  requireClubAccess_(me, payload.clubId); // BUGFIX: same missing access check as actionListEvents.
  const ev = findById_('Events', payload.eventId);
  if (!ev || ev.clubId !== payload.clubId) throw new Error('Event not found.');
  return stripRow_(ev);
}
function actionCreateEvent(me, payload) {
  requireClubAccess_(me, payload.clubId);
  const name = String(payload.name || '').trim(), desc = String(payload.description || '').trim();
  const start = payload.startDate, end = payload.endDate;
  const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
  const startTime = String(payload.startTime || '').trim();
  const endTime = String(payload.endTime || '').trim();
  if (!name) throw new Error('Enter an event name.');
  if (!start || !end) throw new Error('Select start and end dates.');
  if (end < start) throw new Error('End date must be after start date.');
  if (!startTime || !endTime) throw new Error('Select a start and end time.');
  if (!timeRe.test(startTime)) throw new Error('Start time is invalid.');
  if (!timeRe.test(endTime)) throw new Error('End time is invalid.');
  if (start === end && endTime <= startTime) throw new Error('End time must be after start time.');
  return withLock_(function () {
    const ev = { id: Utilities.getUuid(), clubId: payload.clubId, name: name, description: desc, startDate: start, endDate: end, checkinOpen: false, checkinDate: '', createdBy: me.uid, createdAt: new Date().toISOString(), startTime: startTime, endTime: endTime };
    appendRow_('Events', ev);
    return stripRow_(ev);
  });
}
function actionSetCheckin(me, payload) {
  requireClubAccess_(me, payload.clubId);
  return withLock_(function () {
    const ev = findById_('Events', payload.eventId);
    if (!ev || ev.clubId !== payload.clubId) throw new Error('Event not found.');
    ev.checkinOpen = !!payload.open;
    if (payload.open) ev.checkinDate = todayStr_();
    updateRow_('Events', ev.__row, ev);
    return stripRow_(ev);
  });
}

/* ---------------- students / roster / attendance ---------------- */
function actionListStudents(me, payload) {
  requireClubAccess_(me, payload.clubId);
  const students = readAll_('Students').filter(function (s) { return s.eventId === payload.eventId; }).map(studentOut_);
  students.sort(function (a, b) { return a.name.localeCompare(b.name); });
  return students;
}
// BUGFIX: neither add nor edit validated `year` server-side, so a raw API call (or a bad
// client value) could store a NaN or out-of-range year that then rendered as "NaN" and
// skewed nothing but looked broken. Clamp it to the three valid values, same as the UI.
function normalizeYear_(y, fallback) {
  const n = Number(y);
  return [1, 2, 3].indexOf(n) !== -1 ? n : (fallback != null ? fallback : 1);
}
function actionAddStudent(me, payload) {
  requireClubAccess_(me, payload.clubId);
  const name = String(payload.name || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2) throw new Error('Enter a valid name.');
  return withLock_(function () {
    const existing = readAll_('Students').filter(function (s) { return s.eventId === payload.eventId; });
    if (existing.some(function (s) { return String(s.name).toLowerCase() === name.toLowerCase(); })) throw new Error('This name is already on the list.');
    const st = { id: Utilities.getUuid(), clubId: payload.clubId, eventId: payload.eventId, name: name, year: normalizeYear_(payload.year, 1), rollNo: String(payload.rollNo || '').trim(), attendance: '{}', addedAt: new Date().toISOString() };
    appendRow_('Students', st);
    return studentOut_(st);
  });
}
// Bulk version of actionAddStudent, for pasting in a whole class list at once. Writes every
// row with a single setValues() call inside one lock instead of one appendRow per student,
// so importing 50 names costs one sheet write instead of 50.
function actionImportStudents(me, payload) {
  requireClubAccess_(me, payload.clubId);
  const rows = Array.isArray(payload.students) ? payload.students : [];
  if (!rows.length) throw new Error('No students to import.');
  return withLock_(function () {
    const existing = readAll_('Students').filter(function (s) { return s.eventId === payload.eventId; });
    const seen = {};
    existing.forEach(function (s) { seen[String(s.name).toLowerCase()] = true; });
    const created = [];
    const skipped = [];
    rows.forEach(function (r) {
      const name = String((r && r.name) || '').trim().replace(/\s+/g, ' ');
      if (name.length < 2) { skipped.push(String((r && r.name) || '').trim() || '(blank)'); return; }
      const key = name.toLowerCase();
      if (seen[key]) { skipped.push(name); return; }
      seen[key] = true;
      created.push({ id: Utilities.getUuid(), clubId: payload.clubId, eventId: payload.eventId, name: name, year: normalizeYear_(r && r.year, 1), rollNo: String((r && r.rollNo) || '').trim(), attendance: '{}', addedAt: new Date().toISOString() });
    });
    if (created.length) {
      const headers = SHEETS.Students;
      const sh = sheet_('Students');
      sh.getRange(sh.getLastRow() + 1, 1, created.length, headers.length)
        .setValues(created.map(function (st) { return headers.map(function (h) { return st[h] !== undefined ? st[h] : ''; }); }));
    }
    return { created: created.map(studentOut_), skipped: skipped };
  });
}
function actionEditStudent(me, payload) {
  requireClubAccess_(me, payload.clubId);
  return withLock_(function () {
    const s = findById_('Students', payload.studentId);
    if (!s || s.eventId !== payload.eventId) throw new Error('Student not found.');
    if (payload.name != null) {
      const name = String(payload.name).trim();
      if (name.length < 2) throw new Error('Enter a valid name.');
      s.name = name;
    }
    if (payload.year != null) s.year = normalizeYear_(payload.year, s.year);
    if (payload.rollNo != null) s.rollNo = String(payload.rollNo).trim();
    updateRow_('Students', s.__row, s);
    return studentOut_(s);
  });
}
function actionDeleteStudent(me, payload) {
  requireClubAccess_(me, payload.clubId);
  return withLock_(function () {
    const s = findById_('Students', payload.studentId);
    if (!s || s.eventId !== payload.eventId) throw new Error('Student not found.');
    deleteRow_('Students', s.__row);
    return { deleted: true };
  });
}
function actionToggleAttendance(me, payload) {
  requireClubAccess_(me, payload.clubId);
  return withLock_(function () {
    const s = findById_('Students', payload.studentId);
    if (!s || s.eventId !== payload.eventId) throw new Error('Student not found.');
    // BUGFIX: the date picker only *visually* clamps to the event range via min/max — that
    // doesn't stop a direct API call from toggling an arbitrary date. Enforce it server-side too.
    const ev = findById_('Events', payload.eventId);
    if (!ev || !payload.date || payload.date < ev.startDate || payload.date > ev.endDate) {
      throw new Error('Date is outside the event range.');
    }
    const att = safeParseJSON_(s.attendance);
    att[payload.date] = !att[payload.date];
    s.attendance = JSON.stringify(att);
    updateRow_('Students', s.__row, s);
    return studentOut_(s);
  });
}

/* ---------------- admin management (owner only) ---------------- */
function actionListAdmins(me) { requireOwner_(me); return readAll_('Admins').map(meFromAdminRow_); }
function actionAddAdmin(me, payload) {
  requireOwner_(me);
  const email = String(payload.email || '').trim().toLowerCase();
  const password = String(payload.password || '');
  const role = payload.role === 'owner' ? 'owner' : 'manager';
  const clubs = role === 'owner' ? [] : (payload.clubs || []);
  if (!email || email.indexOf('@') === -1) throw new Error('Enter a valid email.');
  if (password.length < 8) throw new Error('Password must be at least 8 characters.');
  return withLock_(function () {
    if (readAll_('Admins').some(function (a) { return String(a.email).toLowerCase() === email; })) throw new Error('An admin with this email already exists.');
    const salt = randomSalt_(), id = Utilities.getUuid();
    const row = { id: id, email: email, passHash: hashPassword_(password, salt), salt: salt, role: role, clubs: clubs.join(','), createdAt: new Date().toISOString() };
    appendRow_('Admins', row);
    return meFromAdminRow_(row);
  });
}
function actionRemoveAdmin(me, payload) {
  requireOwner_(me);
  if (payload.uid === me.uid) throw new Error('You cannot remove your own access.');
  return withLock_(function () {
    const a = findById_('Admins', payload.uid);
    if (!a) throw new Error('Admin not found.');
    deleteRow_('Admins', a.__row);
    return { deleted: true };
  });
}

/* ---------------- public check-in (no auth) ---------------- */
function actionCheckinInfo(payload) {
  const ev = findById_('Events', payload.eventId);
  if (!ev || ev.clubId !== payload.clubId || !ev.checkinOpen) return { open: false };
  const students = readAll_('Students').filter(function (s) { return s.eventId === payload.eventId; })
    .map(function (s) { return { id: s.id, name: s.name, year: Number(s.year) }; });
  return { open: true, event: { name: ev.name, checkinDate: ev.checkinDate }, students: students };
}
function actionCheckinSubmit(payload) {
  const deviceId = String(payload.deviceId || '').trim();
  if (!deviceId) throw new Error('Could not identify this device. Please reload the page and try again.');
  return withLock_(function () {
    const ev = findById_('Events', payload.eventId);
    if (!ev || ev.clubId !== payload.clubId || !ev.checkinOpen) throw new Error('Check-in is closed.');
    const s = findById_('Students', payload.studentId);
    if (!s || s.eventId !== payload.eventId) throw new Error('Student not found on roster.');
    // Server-side enforcement: one device may submit once per event+checkinDate, no matter
    // which student it tries to submit as. This is the real check — the client also keeps a
    // local flag for instant UX, but that alone can be cleared/bypassed, so it must not be
    // the only thing standing between one device and marking several different students.
    const already = readAll_('CheckinLog').some(function (r) {
      return r.eventId === payload.eventId && r.checkinDate === ev.checkinDate && r.deviceId === deviceId;
    });
    if (already) throw new Error('This device has already marked attendance for this session.');
    const att = safeParseJSON_(s.attendance);
    att[ev.checkinDate] = true;
    s.attendance = JSON.stringify(att);
    updateRow_('Students', s.__row, s);
    appendRow_('CheckinLog', { id: Utilities.getUuid(), eventId: payload.eventId, checkinDate: ev.checkinDate, deviceId: deviceId, studentId: payload.studentId, submittedAt: new Date().toISOString() });
    return { date: ev.checkinDate };
  });
}