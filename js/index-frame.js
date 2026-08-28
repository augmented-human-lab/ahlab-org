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
})();
