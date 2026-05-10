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
//
// Expandable map panel: clicking the strip toggles a panel below that
// shows a choropleth world map (lazy-fetched from /assets/maps/world.svg)
// tinted by 30-day reader counts, plus a sortable country list with
// flag emojis. The SVG is only fetched on first expand to keep the
// initial page weight minimal — the strip works without ever expanding.
(function () {
  var PROXY_URL = 'https://script.google.com/macros/s/AKfycbw-4pL7gggjdlX-gl8Um_YUkRxjiJ6bmuop5wQX3DQiaMbEtPpPZBqQdA0a6zF-EWz1/exec';
  var MAP_URL   = '/assets/maps/world.svg';

  // GA-name → ISO-3166-1 alpha-2 (lowercase to match SVG path IDs).
  // Covers the long tail of countries that actually show up in the
  // analytics; aliases follow each canonical entry. The SVG also has
  // aria-label that we *could* parse, but a static table lets the
  // country list (with flag emojis) render before the SVG arrives.
  var COUNTRY_TO_ISO = {
    'Afghanistan':'af','Albania':'al','Algeria':'dz','Angola':'ao','Argentina':'ar','Armenia':'am',
    'Australia':'au','Austria':'at','Azerbaijan':'az','Bahrain':'bh','Bangladesh':'bd','Belarus':'by',
    'Belgium':'be','Bolivia':'bo','Bosnia & Herzegovina':'ba','Brazil':'br','Bulgaria':'bg','Cambodia':'kh',
    'Cameroon':'cm','Canada':'ca','Chile':'cl','China':'cn','Colombia':'co','Costa Rica':'cr',
    'Croatia':'hr','Cuba':'cu','Cyprus':'cy','Czechia':'cz','Czech Republic':'cz','Denmark':'dk',
    'Dominican Republic':'do','Ecuador':'ec','Egypt':'eg','El Salvador':'sv','Estonia':'ee','Ethiopia':'et',
    'Finland':'fi','France':'fr','Georgia':'ge','Germany':'de','Ghana':'gh','Greece':'gr',
    'Guatemala':'gt','Honduras':'hn','Hong Kong':'hk','Hungary':'hu','Iceland':'is','India':'in',
    'Indonesia':'id','Iran':'ir','Iraq':'iq','Ireland':'ie','Israel':'il','Italy':'it',
    'Ivory Coast':'ci',"Côte d'Ivoire":'ci','Jamaica':'jm','Japan':'jp','Jordan':'jo','Kazakhstan':'kz',
    'Kenya':'ke','Kuwait':'kw','Kyrgyzstan':'kg','Laos':'la','Latvia':'lv','Lebanon':'lb',
    'Libya':'ly','Lithuania':'lt','Luxembourg':'lu','Macao':'mo','Macau':'mo','Malaysia':'my',
    'Maldives':'mv','Malta':'mt','Mauritius':'mu','Mexico':'mx','Moldova':'md','Mongolia':'mn',
    'Montenegro':'me','Morocco':'ma','Mozambique':'mz','Myanmar (Burma)':'mm','Myanmar':'mm','Namibia':'na',
    'Nepal':'np','Netherlands':'nl','New Zealand':'nz','Nicaragua':'ni','Nigeria':'ng','North Korea':'kp',
    'North Macedonia':'mk','Norway':'no','Oman':'om','Pakistan':'pk','Panama':'pa','Paraguay':'py',
    'Peru':'pe','Philippines':'ph','Poland':'pl','Portugal':'pt','Puerto Rico':'pr','Qatar':'qa',
    'Romania':'ro','Russia':'ru','Saudi Arabia':'sa','Senegal':'sn','Serbia':'rs','Singapore':'sg',
    'Slovakia':'sk','Slovenia':'si','Somalia':'so','South Africa':'za','South Korea':'kr','Spain':'es',
    'Sri Lanka':'lk','Sudan':'sd','Sweden':'se','Switzerland':'ch','Syria':'sy','Taiwan':'tw',
    'Tajikistan':'tj','Tanzania':'tz','Thailand':'th','Trinidad & Tobago':'tt','Tunisia':'tn','Turkey':'tr',
    'Türkiye':'tr','Turkmenistan':'tm','Uganda':'ug','Ukraine':'ua','United Arab Emirates':'ae',
    'United Kingdom':'gb','United States':'us','USA':'us','Uruguay':'uy','Uzbekistan':'uz','Venezuela':'ve',
    'Vietnam':'vn','Yemen':'ye','Zambia':'zm','Zimbabwe':'zw'
  };
  function isoForCountry(name) { return COUNTRY_TO_ISO[name] || null; }
  function flagEmoji(iso2) {
    if (!iso2 || iso2.length !== 2) return '';
    var s = iso2.toUpperCase();
    var A = 0x1F1E6;
    return String.fromCodePoint(A + s.charCodeAt(0) - 65, A + s.charCodeAt(1) - 65);
  }

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

    // Build the shared shell: leading indicator (pips for multi-slide,
    // green pulse for single), then a toggle button containing the
    // current phrase + a chevron, then a hidden panel that the toggle
    // expands. The panel content is built lazily on first expand.
    var multi = slides.length > 1;
    var leading = multi
      ? ('<span class="ahl-stats-pips" role="tablist" aria-label="Rotating stats">'
         + slides.map(function (_, i) {
             return '<button type="button" class="ahl-stats-pip'
               + (i === 0 ? ' is-active' : '') + '" data-i="' + i + '" '
               + 'aria-label="Show stat ' + (i + 1) + ' of ' + slides.length + '"></button>';
           }).join('')
         + '</span>')
      : '<span class="ahl-stats-dot" aria-hidden="true"></span>';

    mount.innerHTML = ''
      + '<div class="ahl-stats-row">'
      +   leading
      +   '<button type="button" class="ahl-stats-toggle" '
      +     'aria-expanded="false" aria-controls="ahl-stats-panel">'
      +     '<span class="ahl-stats-text"' + (multi ? ' data-rotator' : '') + '>'
      +       slides[0]
      +     '</span>'
      +     '<span class="ahl-stats-chevron" aria-hidden="true"></span>'
      +   '</button>'
      + '</div>'
      + '<div id="ahl-stats-panel" class="ahl-stats-panel" aria-hidden="true">'
      +   '<div class="ahl-stats-panel-inner" data-panel-content></div>'
      + '</div>';

    var row        = mount.querySelector('.ahl-stats-row');
    var toggle     = mount.querySelector('.ahl-stats-toggle');
    var panel      = mount.querySelector('.ahl-stats-panel');
    var panelInner = mount.querySelector('[data-panel-content]');
    var panelLoaded = false;

    toggle.addEventListener('click', function () {
      var expanded = toggle.getAttribute('aria-expanded') === 'true';
      var next = !expanded;
      toggle.setAttribute('aria-expanded', next ? 'true' : 'false');
      panel.setAttribute('aria-hidden', next ? 'false' : 'true');
      mount.classList.toggle('is-expanded', next);
      if (next && !panelLoaded) {
        panelLoaded = true;
        renderPanel(panelInner, m30.byCountry || []);
      }
    });

    if (!multi) return;

    // Multi-slide rotator. Hovering or focusing the row pauses; clicking
    // a pip jumps and restarts the cycle. Reduced-motion users get
    // instant swaps (no fade) but still get rotation — a content swap
    // isn't motion in the WCAG sense.
    var ROTATE_MS = 5000, FADE_MS = 220;
    var textEl  = mount.querySelector('[data-rotator]');
    var pips    = mount.querySelectorAll('.ahl-stats-pip');
    var reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    var idx = 0, timer = null, paused = false;

    function show(i) {
      idx = (i + slides.length) % slides.length;
      for (var k = 0; k < pips.length; k++) {
        pips[k].classList.toggle('is-active', k === idx);
      }
      if (reduced) { textEl.innerHTML = slides[idx]; return; }
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
    row.addEventListener('mouseenter', function () { paused = true; });
    row.addEventListener('mouseleave', function () { paused = false; });
    row.addEventListener('focusin',    function () { paused = true; });
    row.addEventListener('focusout',   function () { paused = false; });

    start();
  }

  // ── Expanded panel: country list + lazy-loaded choropleth ─────────
  function renderPanel(container, countries) {
    var listed = countries.filter(function (c) {
      return c && c.country && c.country !== '(not set)';
    });
    var notSet = countries.find(function (c) {
      return c && c.country === '(not set)';
    });

    container.innerHTML = ''
      + '<div class="ahl-stats-mapwrap" data-map>'
      +   '<div class="ahl-stats-map-loading">Loading map…</div>'
      + '</div>'
      + '<ul class="ahl-stats-countries">'
      +   listed.map(function (c) {
            var iso = isoForCountry(c.country);
            return '<li class="ahl-stats-country">'
              + '<span class="ahl-stats-flag" aria-hidden="true">' + (iso ? flagEmoji(iso) : '🏳️') + '</span>'
              + '<span class="ahl-stats-cname">' + escapeHtml(c.country) + '</span>'
              + '<span class="ahl-stats-cnum">' + Number(c.users).toLocaleString('en-US') + '</span>'
              + '</li>';
          }).join('')
      + '</ul>'
      + (notSet
          ? '<p class="ahl-stats-foot">+ <strong>' + Number(notSet.users).toLocaleString('en-US')
            + '</strong> from undisclosed locations.</p>'
          : '')
      + '<p class="ahl-stats-attrib">'
      +   'Map: <a href="https://github.com/svg-maps/svg-maps" rel="noopener" target="_blank">SVG-Maps</a> · CC BY 4.0'
      + '</p>';

    var mapWrap = container.querySelector('[data-map]');
    fetch(MAP_URL, { cache: 'force-cache' })
      .then(function (r) { return r.ok ? r.text() : Promise.reject(r.status); })
      .then(function (svgText) {
        mapWrap.innerHTML = svgText;
        var svg = mapWrap.querySelector('svg');
        if (!svg) return;
        svg.setAttribute('class', 'ahl-stats-map');
        svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', 'World map of reader countries');
        tintMap(svg, listed);
      })
      .catch(function () {
        // Fall back: hide the loading indicator. The country list
        // already rendered, so the panel is still useful.
        mapWrap.style.display = 'none';
      });
  }

  function tintMap(svg, countries) {
    var max = 0;
    for (var i = 0; i < countries.length; i++) {
      if (countries[i].users > max) max = countries[i].users;
    }
    if (max <= 0) return;

    // Sqrt-scaled intensity (0.18..0.95) so small countries stay
    // visibly tinted instead of dissolving into the no-data gray.
    function intensityFor(users) {
      var t = Math.sqrt(Math.max(0, users) / max);
      return 0.18 + 0.77 * t;
    }

    var allPaths = svg.querySelectorAll('path[id]');
    for (var p = 0; p < allPaths.length; p++) {
      allPaths[p].setAttribute('fill', '#E5E7EB');
    }

    for (var c = 0; c < countries.length; c++) {
      var iso = isoForCountry(countries[c].country);
      if (!iso) continue;
      var path = svg.querySelector('path#' + iso);
      if (!path) continue;
      var i = intensityFor(countries[c].users);
      path.setAttribute('fill', 'rgba(97,0,255,' + i.toFixed(2) + ')');
      path.setAttribute('data-users',   countries[c].users);
      path.setAttribute('data-country', countries[c].country);
    }

    // Strip the SVG's id="us" / id="gb" / etc. after we've used them
    // for tinting — once injected into the document, those become
    // global IDs and can collide with other page elements (or be
    // returned by an unsuspecting document.getElementById elsewhere).
    for (var p2 = 0; p2 < allPaths.length; p2++) {
      allPaths[p2].removeAttribute('id');
    }

    // Hover tooltip — one floating div positioned by mousemove.
    var wrap = svg.parentNode;
    if (!wrap) return;
    wrap.style.position = wrap.style.position || 'relative';
    var tip = document.createElement('div');
    tip.className = 'ahl-stats-tip';
    tip.setAttribute('aria-hidden', 'true');
    wrap.appendChild(tip);

    svg.addEventListener('mouseover', function (e) {
      var t = e.target.closest('path[data-users]');
      if (!t) { tip.style.opacity = '0'; return; }
      tip.textContent = t.getAttribute('data-country')
        + ' — ' + Number(t.getAttribute('data-users')).toLocaleString('en-US');
      tip.style.opacity = '1';
    });
    svg.addEventListener('mousemove', function (e) {
      var rect = wrap.getBoundingClientRect();
      tip.style.left = (e.clientX - rect.left + 12) + 'px';
      tip.style.top  = (e.clientY - rect.top  + 12) + 'px';
    });
    svg.addEventListener('mouseleave', function () { tip.style.opacity = '0'; });
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
