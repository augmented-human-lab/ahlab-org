/* ============================================================
   nav-sequence.js
   Horizontal swipe / trackpad navigation between top-level pages.

   Triggered by:
   - Touch swipe (mobile/tablet, >120px horizontal motion)
   - Trackpad horizontal scroll (>180px accumulated, sustained)

   NOT triggered by:
   - Vertical scrolls
   - Mouse wheel (deltaMode === 1, line scrolling)
   - Gestures over elements that themselves horizontally scroll
     (year-nav, filter pills) — those handle their own scroll
   - On detail pages (/people/{slug}/, /projects/{slug}/) —
     this script is intentionally not loaded there

   The page transition uses View Transitions API where supported
   (Chrome/Edge/Safari), falls back to instant navigation in
   Firefox and older browsers.
   ============================================================ */

(function () {
  'use strict';

  // ── Sequence ────────────────────────────────────────────────
  // The order pages cycle through. Loops infinitely on both ends.
  const SEQUENCE = [
    '/',
    '/vision/',
    '/projects/',
    '/publications/',
    '/people/',
    '/press/',
    '/join/',
  ];

  // Find this page's index in the sequence. If we can't find it
  // (e.g. running on a detail page that accidentally loaded this
  // script), abort silently — never navigate from somewhere we
  // can't identify.
  function currentIndex() {
    const path = window.location.pathname;
    // Exact match first
    let i = SEQUENCE.indexOf(path);
    if (i >= 0) return i;
    // Try with/without trailing slash
    const norm = path.endsWith('/') ? path : path + '/';
    i = SEQUENCE.indexOf(norm);
    if (i >= 0) return i;
    // Special: '/' and '/home/' both map to index 0
    if (path === '/home' || path === '/home/') return 0;
    return -1;
  }

  const idx = currentIndex();
  if (idx < 0) return; // not part of the sequence — stay quiet

  function nextUrl(direction) {
    // direction: +1 (forward / right-to-left swipe) or -1 (back)
    const len = SEQUENCE.length;
    const next = ((idx + direction) % len + len) % len; // wrap both ways
    return SEQUENCE[next];
  }

  // ── Navigate with View Transitions (when supported) ─────────
  let navigating = false;
  function navigate(direction) {
    if (navigating) return;
    navigating = true;
    const url = nextUrl(direction);

    // Hint to the View Transitions handler about which way we're going.
    // The CSS in theme.css uses :root[data-vt-direction] to pick the
    // slide animation.
    document.documentElement.setAttribute('data-vt-direction', direction > 0 ? 'forward' : 'back');

    if (document.startViewTransition) {
      document.startViewTransition(() => {
        window.location.href = url;
      });
    } else {
      window.location.href = url;
    }
  }

  // ── Helpers ─────────────────────────────────────────────────
  // Walk up from `el` to see if any ancestor scrolls horizontally.
  // If so, the gesture should belong to that element, not us.
  function isInsideHScroller(el) {
    while (el && el !== document.body && el !== document.documentElement) {
      const cs = window.getComputedStyle(el);
      const ox = cs.overflowX;
      if ((ox === 'auto' || ox === 'scroll') && el.scrollWidth > el.clientWidth) {
        return true;
      }
      el = el.parentElement;
    }
    return false;
  }

  // ── Touch swipe handling ────────────────────────────────────
  let touchStartX = 0;
  let touchStartY = 0;
  let touchActive = false;

  document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    if (isInsideHScroller(e.target)) return;
    // Edge gestures are reserved by browsers for back/forward — skip them
    if (e.touches[0].clientX < 24 || e.touches[0].clientX > window.innerWidth - 24) return;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    touchActive = true;
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    if (!touchActive) return;
    touchActive = false;
    if (!e.changedTouches.length) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    // Must be predominantly horizontal AND >120px
    if (Math.abs(dx) < 120) return;
    if (Math.abs(dx) < Math.abs(dy) * 1.5) return;
    // Right swipe (positive dx) goes BACK in the sequence (intuitive: dragging the previous page in from the left)
    navigate(dx > 0 ? -1 : +1);
  }, { passive: true });

  // ── Trackpad horizontal scroll handling ─────────────────────
  // Trackpads emit wheel events with deltaX > 0 when the user swipes
  // sideways. We accumulate deltaX over a short window and trigger
  // when it crosses a threshold.
  //
  // We DON'T act on mouse wheels (which use deltaMode === 1, "line"
  // mode) because those are usually accidental side-clicks.
  //
  // The accumulator resets after a short idle period, so a slow
  // scroll won't accidentally trigger after many small movements.
  let accumX = 0;
  let lastWheelTime = 0;
  const THRESHOLD = 180;
  const RESET_MS = 250;

  document.addEventListener('wheel', (e) => {
    if (navigating) return;
    if (e.deltaMode !== 0) return; // only pixel-mode (trackpads), not line/page mode (mice)
    if (Math.abs(e.deltaX) < Math.abs(e.deltaY)) return; // predominantly vertical → ignore
    if (Math.abs(e.deltaX) < 2) return; // tiny movement → ignore
    if (isInsideHScroller(e.target)) return;

    const now = performance.now();
    if (now - lastWheelTime > RESET_MS) accumX = 0;
    lastWheelTime = now;

    accumX += e.deltaX;

    if (Math.abs(accumX) >= THRESHOLD) {
      // Positive deltaX = scrolling RIGHT = forward in sequence
      navigate(accumX > 0 ? +1 : -1);
      accumX = 0;
    }
  }, { passive: true });

  // ── Reset direction attribute on pageshow (back/forward cache) ──
  window.addEventListener('pageshow', () => {
    document.documentElement.removeAttribute('data-vt-direction');
    navigating = false;
  });
})();