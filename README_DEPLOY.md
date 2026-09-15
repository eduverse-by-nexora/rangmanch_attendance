# Rangmanch Attendance — v2 (Google Sheets backend, $0 forever)

Still zero-build plain HTML/CSS/JS. The backend is now a **Google Sheet + Apps Script**, not
Firebase — no Google Cloud project, no billing account, no credit card, ever. Just a Google
account. Deploy the static files to any static HTTPS host (Netlify, Vercel, GitHub Pages,
Firebase Hosting's free tier, Cloudflare Pages...).

## What's new vs the original
- **Unlimited clubs** — no longer hardcoded, create/manage clubs from the UI.
- **Events inside each club** — each event has its own name, description, start & end date.
- **Per-event roster** — every event has its own student list, added manually by an admin.
- **QR check-in tied to the roster** — members scan the QR, search their name in the pre-added
  roster, and mark themselves present. No free-text names, no impersonation-by-typo.
- **Manual attendance marking** — admins can tick/untick attendance for any student on any date
  inside the event's date range.
- **Analytics dashboard** — per-event stats, a day-by-day bar chart, a sortable per-student
  attendance % table.
- **History tab** — browse any past date in the event range.
- **CSV export** — one click exports roster + daily attendance matrix + attendance %.
- **Roles** — an `owner` (full access) and `manager` (only assigned clubs).
- **Responsive, dual-optimized layout** — sidebar/topbar + data tables on desktop; a horizontal
  club/tab strip and stacked card rows on mobile — see the two clearly separated `@media` blocks
  in `style.css`.
- **Free backend** — a Google Sheet is the database, a small Apps Script is the API. No paid
  tier, no rate-limit surprises for a club-sized app.

## Bug fixes & polish in this revision
- **Timezone bug**: "today" was computed from UTC, so for timezones ahead of UTC (e.g. India)
  the app could show yesterday's date for the first few hours after local midnight. Now computed
  from local date fields.
- **Stale History tab**: switching events didn't reset the selected history date, so it could
  show a date that didn't belong to the newly-opened event.
- **Missing access checks**: `listEvents` and `getEvent` in `Code.gs` didn't verify a manager
  actually has access to the requested club — a crafted request could read events for clubs they
  aren't assigned to. Fixed to match every other club-scoped endpoint.
- **Unvalidated attendance date**: `toggleAttendance` accepted any date via direct API calls, not
  just ones inside the event's range. Now validated server-side, matching the UI's date picker.
- **Unvalidated student year**: editing a student's year could silently store `NaN` if a
  non-numeric value was entered. Now validated on both ends.
- **CSV export corruption**: a roll number containing a comma broke the column alignment of the
  exported file. Roll numbers are now quoted/escaped like names already were.
- **Mobile layout bug**: on screens ≤800px, the page could overflow horizontally and force every
  section (stat cards, tables, buttons) wider than the viewport, because the sidebar+main flex
  container's `align-items:flex-start` (needed for the desktop side-by-side layout) was still
  active after switching to a stacked mobile layout. Fixed with a mobile-specific `align-items`
  override.
- **Redesigned styling**: separate, more deliberate mobile and desktop tuning (touch targets,
  safe-area padding, snap-scrolling strips on mobile; hover states and a persistent sidebar on
  desktop), plus hover/press animations throughout and a real click-ripple effect on buttons
  (new `effects.js`, respects `prefers-reduced-motion`).


## Files
- `index.html` + `app.js` — the admin dashboard (requires login).
- `checkin.html` + `checkin.js` — the lightweight public page members reach by scanning the QR.
- `api.js` — the one shared file both pages use to talk to your Apps Script backend. **The only
  file you need to edit** after deployment.
- `effects.js` — small shared script that powers the button click-ripple effect on both pages.
- `style.css` — shared styling, with a dedicated mobile `@media` block and a dedicated desktop
  `@media` block so each platform gets its own layout tuning.
- `Code.gs` — the Apps Script backend. Lives inside the Google Sheet, not on your static host.
- `404.html` — fallback page for bad links.

## One-time backend setup (Google Sheets + Apps Script)
1. Go to [sheets.google.com](https://sheets.google.com) and create a new **blank spreadsheet**.
   Name it something like "Rangmanch Attendance DB". (You never need to touch its rows by hand —
   the app creates and manages its own tabs.)
2. In the sheet, go to **Extensions → Apps Script**. A code editor opens in a new tab.
3. Delete the placeholder `function myFunction() {...}` code that's there by default.
4. Open `Code.gs` from this project, copy its entire contents, and paste them into the Apps
   Script editor. Save (Ctrl/Cmd+S).
5. Click **Deploy → New deployment**. Click the gear icon next to "Select type" and choose
   **Web app**.
6. Set:
   - **Execute as:** Me
   - **Who has access:** Anyone
7. Click **Deploy**. The first time, Google will ask you to authorize the script — click through
   **Advanced → Go to (project name) (unsafe)** if you see a warning (this warning appears
   because it's your own unpublished script, not because anything is actually unsafe).
8. Copy the **Web app URL** shown after deployment (looks like
   `https://script.google.com/macros/s/AKfycb.../exec`).

## One-time frontend setup
1. Open `api.js` and replace `PASTE_APPS_SCRIPT_WEB_APP_URL` with the Web app URL from step 8
   above (keep the quotes).
2. Deploy `index.html`, `checkin.html`, `style.css`, `api.js`, `effects.js`, `app.js`,
   `checkin.js`, and `404.html` to your static host, all in the same folder. (`Code.gs` is
   **not** part of this folder — it stays inside the Google Sheet's Apps Script project.)

## Becoming the owner (first login)
Open your deployed `index.html`. Since the Sheet has no admins yet, you'll see **"Create the
owner account"** instead of a login form — enter an email and password and you're the owner.
That's it, no separate console step. The Sheet automatically grows `Admins`, `Clubs`, `Events`,
`Students`, and `Meta` tabs on first use.

## Adding more admins
As the owner, go to **Manage Admins** in the app. Enter the new admin's email and a temporary
password, pick `manager` (and tick which clubs they manage) or `owner`, and click **Add admin** —
their login now exists, no extra step in any console.

## How it works day-to-day
- **Owner**: create clubs, create/assign managers.
- **Admin (owner or manager)**: open a club → create an event with a start/end date → open the
  Roster tab and add the students expected for that event → on the day, go to the Attendance tab
  and click "Open check-in" to generate a QR → members scan and pick their name → counts refresh
  automatically every few seconds. Use the Analytics tab for a live health check and the History
  tab to review any earlier date. Export CSV any time.

## About the "free" part
- **Google Sheets + Apps Script cost nothing** — no billing account required at any point, unlike
  Firebase which just has a free *tier* that can require a card on file for some features.
- Apps Script's free daily quota (roughly tens of thousands of requests, ~90 min of total script
  runtime/day) is far more than a single club needs.
- Trade-off vs Firestore: there's no push-based realtime. The admin app **polls** every ~4 seconds
  while a screen is open, so updates from other admins/check-ins appear within a few seconds
  instead of instantly. For a check-in table, that's imperceptible in practice.
- Trade-off: very heavy simultaneous writes (hundreds of people scanning in the same second) will
  briefly queue behind Apps Script's lock, adding a small delay per submission rather than
  failing — fine for realistic club sizes.

## Security notes
- Access control (who can read/write which club's data, and that the public check-in page can
  only flip *today's* attendance flag on an *existing* roster entry while check-in is open) is
  enforced inside `Code.gs` on the server side — the same rules the old `firestore.rules` file
  described, just written as plain code instead of Firestore's rules language.
- The QR/roster model stops random strangers from adding themselves, but a person can still hand
  their phone to a friend to check in on their behalf — name-based check-in cannot mathematically
  prevent proxy attendance.
- Session tokens are signed (HMAC-SHA256) with a secret Apps Script generates and stores for you
  on first run; they aren't stored in the Sheet.
- For stronger anti-proxy protection later, real member sign-in (college email / Google auth)
  would replace self-typed name selection — a bigger change to the trust model than this
  free-tier rebuild covers.
