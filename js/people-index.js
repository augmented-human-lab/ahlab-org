// people-index.js
// ================
// Client-side orchestration for /people/. Four independent filters +
// two view modes, all coordinated through a single `state` object so
// every render path goes through `applyFilters()`:
//
//   1. Role-group filter  — hero chips (SRF/RF, RE/RA, Students, Interns).
//                            Existing behavior; preserved.
//   2. Year filter        — left-column year-nav. "All time" is the
//                            default; a specific year filters to people
//                            whose ahlab_stints[] overlap that year.
//   3. Segment filter     — right side of the toolbar. Team /
//                            Collaborators / Alumni multi-select.
//                            Disabled when a specific year is selected
//                            (year-view is intrinsically a team snapshot).
//   4. View mode          — left side of the toolbar. Grid (default)
//                            or Honeycomb.
//
// Data model: every .person-card carries data-section-key,
// data-stint-years, data-role-group (optional), data-name, data-role,
// data-photo. Build step (build-people.js) emits these. No network
// calls, no JSON fetch at runtime.
(function () {
  'use strict';

  // ── DOM refs ─────────────────────────────────────────────
  const rolePills        = document.getElementById('rolePills');
  const segmentPills     = document.getElementById('segmentPills');
  const heroRight        = document.querySelector('.hero-summary-right');
  const filterReset      = document.getElementById('filterReset');
  const heroSummary      = document.querySelector('.hero-summary');
  const yearNav          = document.getElementById('yearNav');
  const toolbar          = document.getElementById('peopleToolbar');
  const sectionsWrap     = document.getElementById('peopleSectionsWrap');
  const hivesWrap        = document.getElementById('peopleHives');
  const allSections      = sectionsWrap ? sectionsWrap.querySelectorAll('.people-section') : [];
  const allCards         = sectionsWrap ? sectionsWrap.querySelectorAll('.person-card')   : [];

  // Cache section base labels once for the breadcrumb-style
  // suffix ("Current Team / Students") behavior.
  allSections.forEach(s => {
    const lbl = s.querySelector('.section-label');
    if (lbl) lbl.dataset.baseLabel = lbl.textContent.trim();
  });

  // ── State ────────────────────────────────────────────────
  const state = {
    role: 'all',                                    // role-group key or 'all'
    year: 'all',                                    // 'all' or integer year string
    segments: new Set(['team', 'collaborators', 'alumni']), // active segments
    view: 'grid',                                   // 'grid' | 'honeycomb'
    // Name-search needle lives in QuickSearch (window.QuickSearch.needle);
    // matchesName() reads it via QuickSearch.matches().
  };

  // ── Filter predicates ────────────────────────────────────
  function matchesYear(card) {
    if (state.year === 'all') return true;
    const years = (card.dataset.stintYears || '').split(/\s+/).filter(Boolean);
    return years.indexOf(String(state.year)) !== -1;
  }

  function matchesSegment(card) {
    const seg = card.dataset.sectionKey;
    // PI is always shown — not a toggleable segment.
    if (seg === 'pi') return true;
    // When a year is picked, segment toggles are intentionally disabled
    // in the UI (chips are dimmed and click-handlers no-op). All segments
    // pass the segment gate in year mode; what matters is whether the
    // card's stints overlap the selected year (matchesYear).
    //
    // Visual grouping in year mode:
    //   - PI + Team + Alumni active that year → pooled into "Current
    //     Team / {year}" by the renderers
    //   - Collaborators active that year → stay in their own section
    //     (kept "separate and untouched" per the spec)
    if (state.year !== 'all') return true;
    return state.segments.has(seg);
  }

  function matchesRole(card) {
    if (state.role === 'all') return true;
    // Cards without a data-role-group attribute hide under any
    // specific role filter — matches pre-existing behavior.
    return card.dataset.roleGroup === state.role;
  }

  // Quick-search integration runs in MANUAL mode: the component owns
  // the palette UI + needle, but the page decides visibility because we
  // need the search to AND with the chip/year/segment filters. Each
  // keystroke calls applyFilters() via the onChange hook below.
  function matchesName(card) {
    return window.QuickSearch ? window.QuickSearch.matches(card.dataset.name || '') : true;
  }

  // Stash each card's original parent grid so we can restore the DOM
  // when leaving year-scoped mode. Year-scoped renders pool every active
  // person into the team section's grid (so an alumnus active in the
  // selected year appears under "Current Team / 2021" alongside today's
  // team), and we need to put them back when the user clears the year
  // filter or picks a different year.
  const cardOrigin = new WeakMap();
  allCards.forEach(card => cardOrigin.set(card, card.parentNode));

  // Locate the team section's grid — the move target for year-scoped
  // pooling. If the page somehow doesn't have a team section (no current
  // members), the move-pool logic short-circuits and renderGrid behaves
  // exactly as before.
  const teamSection = sectionsWrap?.querySelector('.people-section[data-section-key="team"]') || null;
  const teamGrid    = teamSection?.querySelector('.people-grid') || null;

  function cardVisible(card) {
    return matchesYear(card) && matchesSegment(card) && matchesRole(card) && matchesName(card);
  }

  // ── Render: Grid view ────────────────────────────────────
  function renderGrid() {
    hivesWrap.hidden = true;
    sectionsWrap.hidden = false;

    // Per-card visibility
    allCards.forEach(card => {
      card.classList.toggle('hidden', !cardVisible(card));
    });

    // Year-scoped DOM reflow: pool every visible non-team card into the
    // team grid so the page reads as a single "Current Team / {year}"
    // group — EXCEPT collaborators, which stay in their own section
    // (filtered by year via matchesYear, but never pooled into team).
    // We always restore-then-pool so switching between two years
    // (e.g. 2015 → 2018) doesn't leave hidden 2015 cards sitting in the
    // team grid — they go back to alumni first, then only 2018's actives
    // get pooled in. Restore is cheap (parentNode equality check skips
    // already-home cards). The per-section visibility pass below runs
    // AFTER this so visibleCount on each section reflects the post-move
    // DOM (alumni section ends up empty → hidden; collaborators section
    // shows its year-filtered subset).
    restoreCardOrigins();
    const yearScoped = state.year !== 'all';
    if (yearScoped && teamGrid) {
      allCards.forEach(card => {
        if (card.classList.contains('hidden')) return;
        if (card.parentNode === teamGrid) return;
        // Collaborators stay in their own section — they're not part of
        // the team timeline pooling.
        if (card.dataset.sectionKey === 'collaborators') return;
        teamGrid.appendChild(card);   // appendChild also detaches from old parent
      });
    }

    // Per-section visibility + label breadcrumb
    const activeRoleLabel = (state.role === 'all') ? ''
      : (document.querySelector(`#rolePills .hero-chip[data-group="${state.role}"]`)?.dataset.label || '');

    allSections.forEach(section => {
      const visibleCount = section.querySelectorAll('.person-card:not(.hidden)').length;
      section.classList.toggle('hidden', visibleCount === 0);
      const lbl = section.querySelector('.section-label');
      if (!lbl) return;
      const base = lbl.dataset.baseLabel;
      const crumbs = [];
      if (state.year !== 'all') crumbs.push(String(state.year));
      if (activeRoleLabel)       crumbs.push(activeRoleLabel);
      // In year-scoped mode the team section absorbs everyone, so its
      // label always reads "Current Team / {year}" — that's the "single
      // pool" framing. Other sections' labels still get the breadcrumb
      // suffix for free, but those sections will be hidden by the
      // visibleCount check above since their cards have moved out.
      lbl.textContent = crumbs.length ? `${base} / ${crumbs.join(' / ')}` : base;
    });
  }

  // Move every card back to the parent grid recorded at startup. Used
  // when leaving year-scoped mode (or moving between years — we restore
  // first, then the next renderGrid pass re-pools into the new year's
  // visible set). No-op for cards that haven't moved.
  function restoreCardOrigins() {
    allCards.forEach(card => {
      const home = cardOrigin.get(card);
      if (home && card.parentNode !== home) home.appendChild(card);
    });
  }

  // ── Render: Honeycomb view ───────────────────────────────
  // Builds one hive per active segment. A "hive" is a spiral axial
  // hexagonal layout with one hex per person (photo + hover label).
  // When a year is selected, only the Team hive renders since
  // collaborators/alumni are suppressed in year-scoped mode.
  function renderHoneycomb(animate = true) {
    sectionsWrap.hidden = true;
    hivesWrap.hidden = false;
    hivesWrap.innerHTML = '';

    // Which segments to render as hives?
    //   • All-time mode → whichever segments the user hasn't toggled off.
    //                     PI is always merged into Team (centered hex).
    //   • Year-scoped mode → Team (which now ABSORBS alumni active in
    //                     that year, plus PI) + Collaborators (kept
    //                     separate per spec — they're not pooled into
    //                     team). Segment toggles are disabled in year
    //                     mode so both always render.
    const segmentsToRender = (state.year !== 'all')
      ? ['team', 'collaborators']
      : ['team', 'collaborators', 'alumni'].filter(s => state.segments.has(s));

    const SEGMENT_LABEL = {
      team: 'Current Team',
      collaborators: 'Collaborators',
      alumni: 'Alumni',
    };

    // Bucket matching cards by segment. Two modes:
    //
    //   • All-time:    bucket each card by its stored section. PI merges
    //                  into the team hive at the front (centered hex).
    //   • Year-scoped: pool team + alumni + PI into the team bucket
    //                  (alumni active in the selected year are
    //                  conceptually team-for-that-year). Collaborators
    //                  stay in their own bucket and render as a separate
    //                  hive — they're not part of the team timeline.
    const buckets = { team: [], collaborators: [], alumni: [] };
    const yearScoped = state.year !== 'all';
    allCards.forEach(card => {
      if (!matchesYear(card) || !matchesRole(card)) return;
      const seg = card.dataset.sectionKey;
      if (yearScoped) {
        if (seg === 'pi')                               buckets.team.unshift(card); // PI at center
        else if (seg === 'team' || seg === 'alumni')    buckets.team.push(card);
        else if (buckets[seg])                          buckets[seg].push(card);    // collaborators stay separate
      } else {
        if (seg === 'pi') buckets.team.unshift(card);   // PI at center → prepend
        else if (buckets[seg]) buckets[seg].push(card);
      }
    });

    for (const seg of segmentsToRender) {
      const cards = buckets[seg] || [];
      if (cards.length === 0) continue;
      const wrap = document.createElement('section');
      wrap.className = 'hive-section';
      wrap.dataset.segment = seg;

      const label = document.createElement('div');
      label.className = 'section-label';
      const base = SEGMENT_LABEL[seg] || seg;
      const crumb = (state.year !== 'all') ? ` / ${state.year}` : '';
      label.textContent = base + crumb + `  (${cards.length})`;
      wrap.appendChild(label);

      const stage = document.createElement('div');
      stage.className = 'hive-stage';
      const hive  = document.createElement('div');
      hive.className = 'hive';
      stage.appendChild(hive);
      wrap.appendChild(stage);
      hivesWrap.appendChild(wrap);

      // Defer layout to after mount so clientWidth is measurable.
      // RAF because we just appended — layout isn't ready synchronously.
      requestAnimationFrame(() => layoutHive(hive, cards, animate));
    }
  }

  // ── Hive layout ──────────────────────────────────────────
  // Spiral axial layout: find smallest ring k that fits n hexes,
  // pick R so that k+0.5 rings fit in the container width/height,
  // emit one <a class="hex"> per card with translate positioning.
  //
  // `animate` controls the enter animation: true on the initial render
  // and on filter/year/segment changes (the hexes bloom in), false on
  // window resize where re-triggering the animation on every resize
  // tick would feel jarring.
  function layoutHive(hive, cards, animate = true) {
    const n = cards.length;
    if (n === 0) return;
    const w = hive.clientWidth  || 800;
    const h = hive.clientHeight || 480;

    // Smallest ring count that holds n cells
    let k = 0;
    while (1 + 3 * k * (k + 1) < n) k++;

    // Pick R (circumradius) so all rings fit with padding
    const pad = 16;
    const availW = Math.max(80, w - pad * 2);
    const availH = Math.max(80, h - pad * 2);
    const Rw = availW / (2 * Math.sqrt(3) * (k + 0.5));
    const Rh = availH / (3 * k + 2);
    let R = Math.min(Rw, Rh);
    R = Math.max(22, Math.min(92, R));

    const coords = spiralAxial(n);
    const cx = w / 2, cy = h / 2;

    const frag = document.createDocumentFragment();
    cards.forEach((card, i) => {
      const c = coords[i];
      const px = Math.sqrt(3) * R * (c.q + c.r / 2);
      const py = 1.5 * R * c.r;
      const hexW = Math.sqrt(3) * R;
      const hexH = 2 * R;
      const tx = (cx + px) - hexW / 2;
      const ty = (cy + py) - hexH / 2;
      const hex = document.createElement('a');
      // `entering` starts the hex at opacity 0 + scale(0.3). We clear the
      // class on the next animation frame below so the CSS transition on
      // .hex picks up the change and animates transform+opacity back to
      // the resting state. The --tx/--ty custom props let the entering
      // rule translate to the hex's *final* position during the fade —
      // without them the hex would snap from translate(0,0) to its
      // destination after the opacity fade, which looks jumpy.
      //
      // Skipped entirely when animate=false (resize path) — we just want
      // the hexes to land at their new positions without bloom.
      hex.className = animate ? 'hex entering' : 'hex';
      hex.href = card.getAttribute('href');
      hex.dataset.section = card.dataset.sectionKey;
      hex.style.width  = hexW + 'px';
      hex.style.height = hexH + 'px';
      hex.style.setProperty('--tx', tx + 'px');
      hex.style.setProperty('--ty', ty + 'px');
      hex.style.transform = `translate(${tx}px, ${ty}px)`;
      // Per-hex random stagger so the bloom arrives in a scattered wave
      // rather than a synchronized pop. Delay is applied via inline
      // `transitionDelay`, which the CSS transition on .hex honors. We
      // clear the delay on transitionend so future transitions (hover,
      // resize, year-change re-layout) fire immediately without inherited
      // stagger. 0–400ms range: short enough not to drag on large hives,
      // long enough to feel like distinct arrivals rather than one pop.
      if (animate) {
        const delay = Math.random() * 400;
        hex.style.transitionDelay = delay + 'ms';
        hex.addEventListener('transitionend', function clearDelay(e) {
          // Only clear once; opacity is the fastest of the three
          // transitioned properties so it fires first/reliably.
          if (e.propertyName !== 'opacity') return;
          hex.style.transitionDelay = '';
          hex.removeEventListener('transitionend', clearDelay);
        });
      }
      const photo = card.dataset.photo || '';
      hex.innerHTML =
        `<span class="hex-inner" style="background-image:url('${photo.replace(/"/g, '&quot;')}')"></span>` +
        `<span class="hex-label">${card.dataset.name || ''} · ${card.dataset.role || ''}</span>`;
      frag.appendChild(hex);
    });
    hive.innerHTML = '';
    hive.appendChild(frag);

    // Clear .entering on the next frame so the transition kicks in. Doing
    // this inside rAF (rather than synchronously after append) guarantees
    // the browser has laid out the hexes in their entering state at least
    // once — without that, some engines collapse the two style changes
    // into a single commit and skip the transition entirely.
    requestAnimationFrame(() => {
      hive.querySelectorAll('.hex.entering').forEach(el => el.classList.remove('entering'));
    });
  }

  // Spiral axial coordinates for n cells, starting at (0,0) and
  // walking outward through concentric hexagonal rings.
  function spiralAxial(n) {
    const coords = [{ q: 0, r: 0 }];
    if (n <= 1) return coords;
    const dirs = [ [1,0], [0,1], [-1,1], [-1,0], [0,-1], [1,-1] ];
    let ring = 1;
    while (coords.length < n) {
      let q = ring, r = 0;
      // Start at east position, walk 6 sides
      for (let side = 0; side < 6; side++) {
        const [dq, dr] = dirs[(side + 2) % 6];
        for (let step = 0; step < ring; step++) {
          coords.push({ q, r });
          if (coords.length >= n) return coords;
          q += dq; r += dr;
        }
      }
      ring++;
    }
    return coords;
  }

  // ── Render dispatcher ────────────────────────────────────
  function applyFilters() {
    syncToolbarEnabledState();
    if (state.view === 'honeycomb') renderHoneycomb();
    else                             renderGrid();
    syncHeroChipClasses();
    syncRoleChipCounts();
  }

  // Recount role-group chips ("4 Students", "12 Researchers", …) against
  // the current search needle. Each chip's count answers "if I clicked
  // this, how many people would I see?" — so we count cards in the role
  // group that match the search, ignoring the *currently active* role
  // chip and ignoring year/segment filters. Build-time text is stashed
  // on first run and restored when the needle clears.
  function syncRoleChipCounts() {
    const QS = window.QuickSearch;
    document.querySelectorAll('#rolePills .hero-chip').forEach(chip => {
      if (!chip.dataset.origText) chip.dataset.origText = chip.textContent;
      const needle = QS && QS.needle;
      if (!needle) {
        chip.textContent = chip.dataset.origText;
        chip.classList.remove('qs-empty');
        return;
      }
      const grp = chip.dataset.group;
      let n = 0;
      allCards.forEach(card => {
        if (card.dataset.roleGroup !== grp) return;
        if (QS.matches(card.dataset.name || '')) n++;
      });
      chip.textContent = n + ' ' + chip.dataset.label;
      chip.classList.toggle('qs-empty', n === 0);
    });
  }

  // Hero segment chips disable when a year is selected (year-view is
  // always a team snapshot). The CSS `.is-year-scoped` class on the
  // hero-summary-right dims all three and force-highlights Team.
  // Toolbar still owns the view-mode toggle.
  function syncToolbarEnabledState() {
    const yearPicked = state.year !== 'all';
    heroRight?.classList.toggle('is-year-scoped', yearPicked);

    // Segment chip active classes — suppressed entirely in year-scoped
    // mode (CSS handles the forced-active Team look via the parent's
    // .is-year-scoped class, so JS just clears individual states).
    segmentPills?.querySelectorAll('.hero-chip').forEach(chip => {
      if (yearPicked) {
        chip.classList.remove('is-active');
      } else {
        const on = state.segments.has(chip.dataset.segment);
        chip.classList.toggle('is-active', on);
        chip.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    });

    // View-mode toggle (now icon buttons in the year-nav)
    toolbar?.querySelectorAll('.view-btn').forEach(btn => {
      const on = btn.dataset.view === state.view;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function syncHeroChipClasses() {
    if (!heroSummary) return;
    heroSummary.classList.toggle('is-filtered', state.role !== 'all');
    document.querySelectorAll('#rolePills .hero-chip').forEach(chip => {
      chip.classList.toggle('is-active', state.role !== 'all' && chip.dataset.group === state.role);
    });
  }

  function syncYearNavActive() {
    if (!yearNav) return;
    yearNav.querySelectorAll('a').forEach(a => {
      a.classList.toggle('active', a.dataset.year === String(state.year));
    });
  }

  // ── Event wiring ─────────────────────────────────────────
  // Role-group pills (hero)
  function setRole(group) {
    state.role = (!group || group === 'all') ? 'all' : group;
    applyFilters();
  }
  rolePills?.addEventListener('click', e => {
    const chip = e.target.closest('.hero-chip');
    if (!chip) return;
    setRole(chip.dataset.group);
  });
  rolePills?.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const chip = e.target.closest('.hero-chip');
    if (!chip) return;
    e.preventDefault();
    setRole(chip.dataset.group);
  });
  filterReset?.addEventListener('click', () => setRole('all'));

  // Year nav (left column)
  yearNav?.addEventListener('click', e => {
    const a = e.target.closest('a[data-year]');
    if (!a) return;
    e.preventDefault();
    state.year = a.dataset.year;
    // Year selection intentionally does NOT clear the role filter;
    // users can combine them (e.g. "Students in 2019").
    syncYearNavActive();
    applyFilters();
  });

  // View-mode toggle — icon buttons in the year-nav
  toolbar?.addEventListener('click', e => {
    const btn = e.target.closest('.view-btn');
    if (!btn || btn.disabled) return;
    const view = btn.dataset.view;
    if (view) {
      state.view = view;
      applyFilters();
    }
  });

  // Hero segment chips — multi-select toggle. Ignored in year-scoped
  // mode (CSS already makes them pointer-events:none, but we also
  // guard in JS for keyboard users).
  function toggleSegment(seg) {
    if (!seg || state.year !== 'all') return;
    if (state.segments.has(seg)) {
      // Keep at least one segment active to avoid an empty page.
      if (state.segments.size > 1) state.segments.delete(seg);
    } else {
      state.segments.add(seg);
    }
    applyFilters();
  }
  segmentPills?.addEventListener('click', e => {
    const chip = e.target.closest('.hero-chip');
    if (!chip) return;
    toggleSegment(chip.dataset.segment);
  });
  segmentPills?.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const chip = e.target.closest('.hero-chip');
    if (!chip) return;
    e.preventDefault();
    toggleSegment(chip.dataset.segment);
  });

  // ── Quick name search ────────────────────────────────────
  // Manual-mode integration with the shared QuickSearch component
  // (/js/quick-search.js). The component owns the floating palette,
  // the global keyboard, and the needle state; we just hand it an
  // onChange callback that re-runs our combined filter pass and a
  // countItems hook that returns the post-filter visible count for
  // the palette's "N matches" badge.
  if (window.QuickSearch) {
    window.QuickSearch.attach({
      placeholder: 'Type a name…',
      onChange:    () => applyFilters(),
      countItems:  () => {
        let n = 0;
        allCards.forEach(c => { if (cardVisible(c)) n++; });
        return n;
      },
    });
  }

  // Relayout hives on resize (grid view needs no resize handling).
  // Passes animate=false — resize shouldn't trigger the bloom on every
  // viewport tick; hexes should just move to their new positions.
  let resizeRaf = 0;
  window.addEventListener('resize', () => {
    if (state.view !== 'honeycomb') return;
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => renderHoneycomb(false));
  });

  // ── Boot ─────────────────────────────────────────────────
  syncYearNavActive();
  applyFilters();

  // ── Scroll-reveal observer ──────────────────────────────
  // Cards and section labels carry `.rv` which starts them at
  // opacity:0 + translateY(28px) (see theme.css). The observer
  // adds `.vis` when they scroll into view so they fade up. This
  // was previously an inline <script> in the template — moved here
  // so all page logic lives in one file.
  var obs = new IntersectionObserver(function (entries, observer) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add('vis');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0, rootMargin: '0px 0px -40px 0px' });
  document.querySelectorAll('.rv').forEach(function (el) { obs.observe(el); });
})();