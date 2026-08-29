/**
 * index-frame.js — shared behaviours for the gradient-framed index pages
 * (/people/, /press/, /publications/, /projects/). Desktop-only.
 *
 *   1. Auto-hide: fade the four gradient frame edges out after 5s of mouse
 *      inactivity; snap them back on any mouse / keyboard / scroll / tab
 *      activity. Timing lives in index-frame.css via body.frame-idle.
 *
 *   2. Footer latch: the bottom filter bar is position:fixed, so it would
 *      otherwise float over the site footer at the end of the page. Instead
 *      we translate it up by however much the footer has entered the
 *      viewport, so the bar rides up on top of the footer and the footer
 *      shows cleanly with no occlusion.
 *
 * People adds its own segment-ball scroll-spy on top of this in
 * people-index.js; the ball is included in the fade group here (the
 * #segmentBall selector simply doesn't match on the other pages).
 */
(function () {
  'use strict';

  if (!window.matchMedia('(min-width: 992px)').matches) return;

  // ── 1. Auto-hide the frame on inactivity ────────────────────────────
  var idleTimer = 0;
  function wakeChrome() {
    document.body.classList.remove('frame-idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () { document.body.classList.add('frame-idle'); }, 5000);
  }
  ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'].forEach(function (ev) {
    window.addEventListener(ev, wakeChrome, { passive: true });
  });
  window.addEventListener('focus', wakeChrome);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) wakeChrome(); });
  wakeChrome();

  // ── 2. Footer latch for the docked bottom filter bar ────────────────
  // The filter hero is the .hero that contains the filter summary.
  var bar = null;
  var heroes = document.querySelectorAll('.hero');
  for (var i = 0; i < heroes.length; i++) {
    if (heroes[i].querySelector('.hero-summary')) { bar = heroes[i]; break; }
  }
  if (bar) {
    var footer = null;          // resolved lazily — footer-include.js mounts it async
    var latchRaf = 0;
    function latch() {
      latchRaf = 0;
      if (!footer) footer = document.querySelector('.site-footer');
      if (!footer) return;
      var over = window.innerHeight - footer.getBoundingClientRect().top;
      // Push the bar up by the amount the footer has scrolled into view, so
      // the bar's bottom edge rides exactly on the footer's top edge.
      bar.style.transform = over > 0 ? 'translateY(' + (-over) + 'px)' : '';
    }
    function scheduleLatch() {
      if (latchRaf) return;
      latchRaf = requestAnimationFrame(latch);
    }
    window.addEventListener('scroll', scheduleLatch, { passive: true });
    window.addEventListener('resize', scheduleLatch, { passive: true });
    // The footer mounts a beat after load; re-check for a short while.
    var tries = 0;
    var poll = setInterval(function () {
      if (!footer) footer = document.querySelector('.site-footer');
      if (footer || ++tries > 40) { clearInterval(poll); scheduleLatch(); }
    }, 100);
    scheduleLatch();
  }

  // ── 3. Year-rail selection mark ─────────────────────────────────────
  // A rotating AHL circle glides to sit just after the active year in the
  // left timeline rail — on every index page (people / press / publications
  // / projects). Each page marks its own active year with `.active`; this
  // just follows it. (People also adds nav + segment marks of its own in
  // people-index.js; those reuse the same .ahl-flip-logo styles.)
  var rail = document.getElementById('yearNav');
  if (rail) {
    var yearLogo = document.getElementById('yearLogo');
    if (!yearLogo) {
      yearLogo = document.createElement('div');
      yearLogo.id = 'yearLogo';
      yearLogo.className = 'ahl-flip-logo';
      yearLogo.setAttribute('aria-hidden', 'true');
      yearLogo.innerHTML = '<img src="https://cdn.ahlab.org/media/site/cropped-Group@2x-192x192.png" alt="">';
      document.body.appendChild(yearLogo);
    }
    var yRaf = 0;
    function placeYearLogo() {
      yRaf = 0;
      // A page may mark several years active (e.g. press highlights every
      // year in view) — flag the first one.
      var active = rail.querySelector('a.active');
      if (!active) { yearLogo.classList.remove('is-visible'); return; }
      var rng = document.createRange();
      rng.selectNodeContents(active);   // exact text box (handles centred "All")
      var r = rng.getBoundingClientRect();
      yearLogo.style.left = (r.right + 6) + 'px';
      yearLogo.style.top  = (r.top + r.height / 2 - yearLogo.offsetHeight / 2) + 'px';
      yearLogo.classList.add('is-visible');
    }
    function scheduleYearLogo() { if (yRaf) return; yRaf = requestAnimationFrame(placeYearLogo); }

    // Auto-scroll the rail so the active year(s) stay in view as the main
    // content scrolls past them: bring the bottommost active year up to the
    // bottom edge when scrolling down, the topmost down to the top edge when
    // scrolling back up. Insets account for the fixed nav (top) + docked
    // filter bar (bottom) overlapping the rail.
    function ensureYearVisible() {
      var actives = rail.querySelectorAll('a.active');
      if (!actives.length) return;
      var first = actives[0];
      var last  = actives[actives.length - 1];
      var topInset = 96, botInset = 84;
      var lastBottom = last.offsetTop + last.offsetHeight;
      if (lastBottom > rail.scrollTop + rail.clientHeight - botInset) {
        rail.scrollTo({ top: lastBottom - rail.clientHeight + botInset, behavior: 'smooth' });
      } else if (first.offsetTop < rail.scrollTop + topInset) {
        rail.scrollTo({ top: first.offsetTop - topInset, behavior: 'smooth' });
      }
    }

    window.addEventListener('scroll', scheduleYearLogo, { passive: true });
    window.addEventListener('resize', scheduleYearLogo, { passive: true });
    // The rail scrolls internally (overflow-y), which doesn't fire a window
    // scroll event — track its own scroll so the mark stays glued to its year.
    rail.addEventListener('scroll', scheduleYearLogo, { passive: true });
    // The active year can change without a scroll (filter click / scroll-spy
    // toggle): reposition the mark and auto-scroll the rail to keep it in view.
    var mutRaf = 0;
    new MutationObserver(function () {
      scheduleYearLogo();
      if (mutRaf) return;
      mutRaf = requestAnimationFrame(function () { mutRaf = 0; ensureYearVisible(); });
    }).observe(rail, { subtree: true, attributes: true, attributeFilter: ['class'] });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(scheduleYearLogo);
    window.addEventListener('load', scheduleYearLogo);
    scheduleYearLogo();
  }
})();
