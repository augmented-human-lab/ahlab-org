// analytics-widget.js — fetches public visitor stats from the
// ahl-analytics-appscript proxy and renders into #ahl-stats-widget.
//
// The proxy URL is a Google Apps Script web-app deployment URL — it
// holds the GA Data API credentials server-side and returns a small,
// pre-aggregated, cache-warm JSON blob (~5 min TTL). The browser only
// ever sees the aggregated numbers, never any auth token.
//
// To configure:
//   1. Deploy ahl-analytics-appscript as a web app (see its README).
//   2. Paste the resulting /exec URL into PROXY_URL below.
//   3. Refresh the page — the widget replaces its loading state with
//      the live numbers.
//
// The widget is intentionally fail-soft: on network error or while
// PROXY_URL is unconfigured, it hides itself rather than showing a
// broken UI. That way it can ship to prod ahead of the proxy.
(function () {
  var PROXY_URL = 'https://script.google.com/macros/s/AKfycbw-4pL7gggjdlX-gl8Um_YUkRxjiJ6bmuop5wQX3DQiaMbEtPpPZBqQdA0a6zF-EWz1/exec';

  var mount = document.getElementById('ahl-stats-widget');
  if (!mount) return;

  // No proxy configured yet → hide the entire section so the page
  // doesn't show an awkward "Loading…" forever. Hiding the closest
  // <section> ancestor (if any) keeps the layout clean.
  if (!PROXY_URL) {
    var sec = mount.closest('section');
    if (sec) sec.style.display = 'none';
    else mount.style.display = 'none';
    return;
  }

  fetch(PROXY_URL, { method: 'GET', cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
    .then(render)
    .catch(function () {
      var sec = mount.closest('section');
      if (sec) sec.style.display = 'none';
    });

  function render(payload) {
    // Expected shape (kept loose so the widget tolerates missing fields):
    //   {
    //     realtime: { activeUsers: N, byCountry: [{country, users}, ...] },
    //     last7d:   { users: N, pageviews: N, byCountry: [...] },
    //     last30d:  { users: N, pageviews: N, byCountry: [...] },
    //     cachedAt: "2026-04-29T12:00:00Z"
    //   }
    var rt  = (payload && payload.realtime) || {};
    var w7  = (payload && payload.last7d)   || {};
    var m30 = (payload && payload.last30d)  || {};

    function num(n) {
      if (n == null) return 0;
      n = Number(n);
      return isFinite(n) ? n : 0;
    }
    function fmt(n) { return Number(n).toLocaleString('en-US'); }
    function countryCount(list) {
      return Array.isArray(list)
        ? list.filter(function (c) { return c && c.country; }).length
        : 0;
    }
    function topCountries(list, limit) {
      if (!Array.isArray(list) || !list.length) return '';
      return list.slice(0, limit || 3)
        .map(function (c) { return c.country; })
        .filter(Boolean)
        .join(', ');
    }

    var rtUsers      = num(rt.activeUsers);
    var w7Users      = num(w7.users);
    var m30Users     = num(m30.users);
    var m30Countries = countryCount(m30.byCountry);
    var rtList       = topCountries(rt.byCountry, 3);
    var m30List      = topCountries(m30.byCountry, 4);
    var w7List       = topCountries(w7.byCountry, 4);

    // Warm, human phrasing — the strip should read like a sentence a
    // visitor could quote, not like a dashboard. Collect every tier
    // the numbers can honestly support, then rotate through them so
    // both "live right now" and "this month's reach" can share the
    // strip without fighting for the slot.
    //
    // Thresholds are starting points — easy to tune in one place:
    //   Realtime — rt ≥ 1             : show whenever anyone is live
    //                                    (singular "reader" at exactly 1)
    //   Monthly  — 30d ≥ 200, ≥3 countries: reach + diversity
    //              else 30d ≥ 50      : reach with top countries
    //   Weekly   — 7d  ≥ 30           : weekly reach (only when 30d empty)
    //   else                            : hide entirely
    var slides = [];
    if (rtUsers >= 1) {
      var rtNoun = rtUsers === 1 ? 'reader' : 'readers';
      slides.push('<strong>' + fmt(rtUsers) + '</strong> ' + rtNoun
        + (rtList ? ' from ' + escapeHtml(rtList) : '')
        + ' exploring our work right now');
    }
    if (m30Users >= 200 && m30Countries >= 3) {
      slides.push('Read by <strong>' + fmt(m30Users) + '</strong> people across '
        + '<strong>' + m30Countries + '</strong> countries this month');
    } else if (m30Users >= 50) {
      slides.push('<strong>' + fmt(m30Users) + '</strong> visitors this month'
        + (m30List ? ' from ' + escapeHtml(m30List) : ''));
    } else if (w7Users >= 30) {
      slides.push('<strong>' + fmt(w7Users) + '</strong> visitors this past week'
        + (w7List ? ' from ' + escapeHtml(w7List) : ''));
    }

    if (!slides.length) {
      var sec = mount.closest('section');
      if (sec) sec.style.display = 'none';
      return;
    }

    mount.setAttribute('data-state', 'ready');

    if (slides.length === 1) {
      mount.innerHTML = '<div class="ahl-stats-strip">'
        + '<span class="ahl-stats-dot" aria-hidden="true"></span>'
        + '<span class="ahl-stats-text">' + slides[0] + '</span>'
        + '</div>';
      return;
    }

    // Multi-slide: render the carousel pips at the LEADING position
    // (replacing the green pulse — the active pip already conveys
    // "this is the current slide of N"), and auto-rotate every
    // ROTATE_MS with a short cross-fade. Hovering or focusing pauses;
    // clicking a pip jumps and restarts the cycle. Reduced-motion users
    // get instant swaps (no fade) but still get rotation — a content
    // swap isn't motion in the WCAG sense.
    var ROTATE_MS = 5000;
    var FADE_MS   = 220;
    var pipsHtml = slides.map(function (_, i) {
      return '<button type="button" class="ahl-stats-pip'
        + (i === 0 ? ' is-active' : '') + '" data-i="' + i + '" '
        + 'aria-label="Show stat ' + (i + 1) + ' of ' + slides.length + '"></button>';
    }).join('');

    mount.innerHTML = '<div class="ahl-stats-strip" data-rotating>'
      + '<span class="ahl-stats-pips" role="tablist" aria-label="Rotating stats">'
      + pipsHtml + '</span>'
      + '<span class="ahl-stats-text" data-rotator>' + slides[0] + '</span>'
      + '</div>';

    var strip  = mount.querySelector('.ahl-stats-strip');
    var textEl = mount.querySelector('[data-rotator]');
    var pips   = mount.querySelectorAll('.ahl-stats-pip');
    var reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    var idx = 0, timer = null, paused = false;

    function show(i) {
      idx = (i + slides.length) % slides.length;
      for (var k = 0; k < pips.length; k++) {
        pips[k].classList.toggle('is-active', k === idx);
      }
      if (reduced) {
        textEl.innerHTML = slides[idx];
        return;
      }
      textEl.style.opacity = '0';
      setTimeout(function () {
        textEl.innerHTML = slides[idx];
        textEl.style.opacity = '1';
      }, FADE_MS);
    }
    function tick()  { if (!paused) show(idx + 1); }
    function start() { stop(); timer = setInterval(tick, ROTATE_MS); }
    function stop()  { if (timer) { clearInterval(timer); timer = null; } }

    for (var k = 0; k < pips.length; k++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          show(parseInt(btn.getAttribute('data-i'), 10));
          start();
        });
      })(pips[k]);
    }
    strip.addEventListener('mouseenter', function () { paused = true; });
    strip.addEventListener('mouseleave', function () { paused = false; });
    strip.addEventListener('focusin',    function () { paused = true; });
    strip.addEventListener('focusout',   function () { paused = false; });

    start();
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
})();
