/* ============================================================
   Rangmanch Attendance — shared UI effects
   Just the click ripple on buttons. Kept in its own tiny file so both
   app.js and checkin.js (which re-render large chunks of the DOM via
   innerHTML) get it for free via one delegated listener, instead of
   re-wiring a handler on every button every render.
   ============================================================ */
(function () {
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion) return;

  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('button');
    if (!btn || btn.disabled) return;
    var rect = btn.getBoundingClientRect();
    var size = Math.max(rect.width, rect.height) * 1.4;
    var span = document.createElement('span');
    span.className = 'ripple';
    span.style.width = span.style.height = size + 'px';
    span.style.left = (e.clientX - rect.left - size / 2) + 'px';
    span.style.top = (e.clientY - rect.top - size / 2) + 'px';
    btn.appendChild(span);
    span.addEventListener('animationend', function () { span.remove(); });
    // Safety net in case animationend doesn't fire (e.g. the button's re-rendered away).
    setTimeout(function () { span.remove(); }, 700);
  }, true);
})();
