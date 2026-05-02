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
    // visitor could quote, not like a dashboard. Pick the strongest
    // tier the numbers actually support; refuse to brag when there's
    // nothing to brag about (hide rather than print something thin).
    //
    // Thresholds are starting points — easy to tune in one place:
    //   Tier A — realtime ≥ 5         : "live with company" framing
    //   Tier B — 30d ≥ 200, ≥3 countries: monthly reach + diversity
    //   Tier C — 30d ≥ 50              : monthly reach
    //   Tier D — 7d  ≥ 30              : weekly reach
    //   else                            : hide entirely
    //
    // Once GA accumulates real traffic the higher tiers will kick in
    // automatically. Until then the strip stays out of the way rather
    // than announcing "1 visitor right now".
    var phrase = '';
    if (rtUsers >= 5) {
      phrase = '<strong>' + fmt(rtUsers) + '</strong> readers'
             + (rtList ? ' from ' + escapeHtml(rtList) : '')
             + ' exploring our work right now';
    } else if (m30Users >= 200 && m30Countries >= 3) {
      phrase = 'Read by <strong>' + fmt(m30Users) + '</strong> people across '
             + '<strong>' + m30Countries + '</strong> countries this month';
    } else if (m30Users >= 50) {
      phrase = '<strong>' + fmt(m30Users) + '</strong> visitors this month'
             + (m30List ? ' from ' + escapeHtml(m30List) : '');
    } else if (w7Users >= 30) {
      phrase = '<strong>' + fmt(w7Users) + '</strong> visitors this past week'
             + (w7List ? ' from ' + escapeHtml(w7List) : '');
    } else {
      var sec = mount.closest('section');
      if (sec) sec.style.display = 'none';
      return;
    }

    mount.setAttribute('data-state', 'ready');
    mount.innerHTML = '<div class="ahl-stats-strip">'
      + '<span class="ahl-stats-dot" aria-hidden="true"></span>'
      + '<span>' + phrase + '</span>'
      + '</div>';
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
