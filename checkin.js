const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = document.getElementById('app');

let students = [], selectedId = null, clubId, eventId, evInfo;

function theme() { document.body.classList.toggle('dark', localStorage.theme === 'dark'); }

function shell(html) {
  app.innerHTML = `<div class="checkin-shell"><div class="checkin-logo">R</div>${html}</div>`;
}
function closedScreen(text) {
  shell(`<div class="card login center" style="margin:0"><h1>${esc(text || 'Check-in closed')}</h1>
    <p class="muted">This QR code is no longer active. Ask the organizer to open check-in again.</p></div>`);
}

// Distinct from closedScreen(): this is for when the *request itself* failed (timeout,
// network hiccup, server error) — previously any such failure silently showed the same
// "Check-in closed" message as a genuinely closed event, which was misleading.
function errorScreen() {
  shell(`<div class="card login center" style="margin:0"><h1>Couldn't load check-in</h1>
    <p class="muted">That took too long or something went wrong. Check your connection and try again.</p>
    <button class="primary" style="margin-top:14px" onclick="init()">Retry</button></div>`);
}

async function init() {
  theme();
  if (!CONFIGURED) { shell(`<div class="card center"><h1>Setup required</h1><p class="muted">This app has not been configured yet — paste the Apps Script Web App URL into api.js.</p></div>`); return; }
  const params = new URLSearchParams(location.search);
  clubId = params.get('c'); eventId = params.get('e');
  if (!clubId || !eventId) return closedScreen('Invalid check-in link');
  let info;
  try {
    info = await callApi('checkinInfo', { clubId, eventId });
  } catch (e1) {
    // One quiet retry: Apps Script occasionally has a slow/failed first request (cold
    // start), and a single automatic retry clears most of those without bothering the user.
    try { info = await callApi('checkinInfo', { clubId, eventId }); }
    catch (e2) { console.error(e2); return errorScreen(); }
  }
  if (!info.open) return closedScreen();
  evInfo = info.event;
  const lockKey = `checkin-${clubId}-${eventId}-${evInfo.checkinDate}`;
  if (localStorage.getItem(lockKey)) return shell(`<div class="card login center" style="margin:0">
    <h1 class="ok-text">Already submitted ✓</h1><p class="muted">This device already marked attendance for today.</p></div>`);
  students = info.students;
  renderForm();
}

function renderForm() {
  shell(`
    <div class="card login" style="margin:0">
      <h1>Mark attendance</h1>
      <p class="muted">${esc(evInfo.name)} · ${esc(evInfo.checkinDate)}</p>
      <label>Find your name</label>
      <input id="search" placeholder="Start typing your name…" autocomplete="off">
      <div id="list" class="search-list hidden"></div>
      <input type="hidden" id="selName">
      <button class="primary" style="width:100%;margin-top:14px" onclick="submitCheckin()" id="submitBtn" disabled>Submit attendance</button>
      <p class="error"></p>
      <p class="small muted center" style="margin-top:10px">Not on the list? Ask the organizer to add you to the roster first.</p>
    </div>`);
  $('#search').oninput = onSearch;
  $('#search').onfocus = onSearch;
}
function onSearch() {
  const q = $('#search').value.trim().toLowerCase();
  selectedId = null; $('#submitBtn').disabled = true;
  const list = $('#list');
  if (!q) { list.classList.add('hidden'); list.innerHTML = ''; return; }
  const matches = students.filter(s => s.name.toLowerCase().includes(q)).slice(0, 30);
  list.classList.remove('hidden');
  list.innerHTML = matches.map(s => `<div class="opt" data-id="${s.id}">${esc(s.name)} <small>${s.year} Year</small></div>`)
    .join('') || `<div class="opt muted">No matches.</div>`;
  list.querySelectorAll('.opt[data-id]').forEach(el => {
    el.onclick = () => {
      selectedId = el.getAttribute('data-id');
      const s = students.find(x => x.id === selectedId);
      $('#search').value = s.name;
      list.classList.add('hidden');
      $('#submitBtn').disabled = false;
    };
  });
}
async function submitCheckin() {
  if (!selectedId) return;
  const btn = $('#submitBtn'); btn.disabled = true; btn.textContent = 'Submitting…';
  const lockKey = `checkin-${clubId}-${eventId}-${evInfo.checkinDate}`;
  try {
    try { await callApi('checkinSubmit', { clubId, eventId, studentId: selectedId }); }
    catch (e1) { await callApi('checkinSubmit', { clubId, eventId, studentId: selectedId }); }
    localStorage.setItem(lockKey, '1');
    shell(`<div class="card login center" style="margin:0"><h1 class="ok-text">Attendance recorded ✓</h1>
      <p class="muted">Thanks — your attendance has been sent successfully.</p></div>`);
  } catch (e) {
    console.error(e);
    btn.disabled = false; btn.textContent = 'Submit attendance';
    const err = $('.error'); if (err) err.textContent = 'Could not submit. Please try again.';
  }
}

init();
