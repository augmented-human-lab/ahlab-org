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
      const yearPicked = state.year !== 'all';
      // The "Current" qualifier only makes sense for the all-time snapshot;
      // once a specific year is chosen the section is a point-in-time team,
      // so "Current Team" becomes just "Team" and the year reads inline
      // ("Team 2024") rather than as a slash breadcrumb.
      const base = yearPicked
        ? lbl.dataset.baseLabel.replace(/^Current\s+/, '')
        : lbl.dataset.baseLabel;
      let label = base;
      if (yearPicked)      label += ` ${state.year}`;
      if (activeRoleLabel) label += ` / ${activeRoleLabel}`;
      lbl.textContent = label;
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
      const yearPicked = state.year !== 'all';
      // Mirror the grid labels: "Current" is an all-time-only qualifier, and
      // a picked year reads inline ("Team 2024") rather than as a breadcrumb.
      const base = yearPicked
        ? (SEGMENT_LABEL[seg] || seg).replace(/^Current\s+/, '')
        : (SEGMENT_LABEL[seg] || seg);
      const crumb = yearPicked ? ` ${state.year}` : '';
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

  // ── Honeycomb hover detail ──────────────────────────────────
  // Instead of a chip pinned to each hex, a single detail card pinned to a
  // SCREEN CORNER shows the hovered person's name + title. Which corner is
  // chosen by the hex's quadrant within its cluster (data-quad, set in
  // layoutHive): top-left hexes surface top-left, etc. One element,
  // repositioned via .at-{tl,tr,bl,br} classes, reused across all hives.
  let hexHoverCard = null;
  function ensureHexHoverCard() {
    if (hexHoverCard) return hexHoverCard;
    hexHoverCard = document.createElement('div');
    hexHoverCard.className = 'hex-corner-card';
    hexHoverCard.setAttribute('aria-hidden', 'true');
    hexHoverCard.innerHTML =
      '<span class="hcc-name"></span><span class="hcc-role"></span>' +
      '<span class="hcc-period"></span>';
    document.body.appendChild(hexHoverCard);
    return hexHoverCard;
  }
  const QUAD_CLASS = { tl: 'at-tl', tr: 'at-tr', bl: 'at-bl', br: 'at-br' };
  if (hivesWrap) {
    hivesWrap.addEventListener('mouseover', e => {
      const hex = e.target.closest('.hex');
      if (!hex || !hivesWrap.contains(hex)) return;
      const card = ensureHexHoverCard();
      card.querySelector('.hcc-name').textContent = hex.dataset.name || '';
      card.querySelector('.hcc-role').textContent = hex.dataset.role || '';
      // Alumni get an extra bracketed period row (e.g. "[2002–2004]").
      const periodEl = card.querySelector('.hcc-period');
      if (hex.dataset.period) {
        periodEl.textContent = `[${hex.dataset.period}]`;
        periodEl.hidden = false;
      } else {
        periodEl.textContent = '';
        periodEl.hidden = true;
      }
      card.classList.remove('at-tl', 'at-tr', 'at-bl', 'at-br');
      card.classList.add(QUAD_CLASS[hex.dataset.quad] || 'at-tl');
      card.classList.add('is-visible');
    });
    hivesWrap.addEventListener('mouseout', e => {
      const hex = e.target.closest('.hex');
      if (!hex) return;
      // Ignore moves that stay within the same hex (child → child).
      if (e.relatedTarget && hex.contains(e.relatedTarget)) return;
      if (hexHoverCard) hexHoverCard.classList.remove('is-visible');
    });
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

    const coords = spiralAxial(n);

    // Unit-R (R=1) center of each hex. Measuring the ACTUAL filled cluster
    // — the spiral can leave the outer ring partly empty (e.g. 27 of 37
    // cells) — lets us size and center to what's really there rather than
    // to a theoretical full hexagon. Without this the empty top of the last
    // ring shows up as a lopsided gap (extra padding above the cluster).
    const uc = coords.map(c => ({
      x: Math.sqrt(3) * (c.q + c.r / 2),
      y: 1.5 * c.r,
    }));
    let minUx = Infinity, maxUx = -Infinity, minUy = Infinity, maxUy = -Infinity;
    uc.forEach(p => {
      if (p.x < minUx) minUx = p.x;
      if (p.x > maxUx) maxUx = p.x;
      if (p.y < minUy) minUy = p.y;
      if (p.y > maxUy) maxUy = p.y;
    });
    // Cluster extent in unit-R, including each edge hex's own half-size
    // (half-width √3/2, half-height 1).
    const uW = (maxUx - minUx) + Math.sqrt(3);
    const uH = (maxUy - minUy) + 2;

    // Fit R to the real cluster, then shrink it a touch so the outermost
    // hexes don't run under the fixed top nav / bottom filter bar (the stage
    // spans the full column height and tucks behind both). SHRINK leaves a
    // small margin all around the cluster while keeping it centred.
    const pad = 0;
    const SHRINK = 0.88;
    const availW = Math.max(80, w - pad * 2);
    const availH = Math.max(80, h - pad * 2);
    let R = Math.min(availW / uW, availH / uH) * SHRINK;
    R = Math.max(22, Math.min(92, R));

    const hexW = Math.sqrt(3) * R;
    const hexH = 2 * R;
    const midUx = (minUx + maxUx) / 2;
    const midUy = (minUy + maxUy) / 2;
    const cx = w / 2, cy = h / 2;

    const frag = document.createDocumentFragment();
    cards.forEach((card, i) => {
      const u = uc[i];
      const tx = (cx + (u.x - midUx) * R) - hexW / 2;
      const ty = (cy + (u.y - midUy) * R) - hexH / 2;
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
      hex.dataset.name = card.dataset.name || '';
      hex.dataset.role = card.dataset.role || '';
      if (card.dataset.period) hex.dataset.period = card.dataset.period;
      // Which quadrant of the cluster this hex sits in, measured from the
      // cluster centre (midUx/midUy). Drives which SCREEN corner the hover
      // detail card appears in: a hex up-and-left of centre → top-left
      // corner, etc. Ties (dead-centre) fall to the bottom/right side.
      const quadY = (u.y - midUy) < 0 ? 't' : 'b';
      const quadX = (u.x - midUx) < 0 ? 'l' : 'r';
      hex.dataset.quad = quadY + quadX;
      hex.innerHTML =
        `<span class="hex-inner" style="background-image:url('${photo.replace(/"/g, '&quot;')}')"></span>`;
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
    // Honeycomb view gets full-screen, scroll-snapped, vertically-centred
    // hives (CSS keys off body.view-honeycomb).
    document.body.classList.toggle('view-honeycomb', state.view === 'honeycomb');
    if (state.view === 'honeycomb') renderHoneycomb();
    else                             renderGrid();
    syncHeroChipClasses();
    syncRoleChipCounts();
    // Re-run the desktop indicators after the section DOM changes (view
    // switch, filter, year). Defined later inside the desktop-only block;
    // exposed on window so these cross-scope calls work (no-op on mobile).
    if (window.__peopleSegmentSpy) window.__peopleSegmentSpy();
    // (The shared year-rail mark repositions itself via a MutationObserver
    // on the rail's active-year class — see index-frame.js.)
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

    // Freeze the hero filter strip when ANY filter is applied — role, a
    // specific year, or a deselected segment. `.is-filtered` above only
    // tracks the role (it also dims non-active role chips), so pinning
    // rides on its own class instead of overloading that one. Theme CSS
    // turns `.hero.is-pinned` into a sticky top strip.
    const totalSegments = segmentPills ? segmentPills.querySelectorAll('.hero-chip').length : 0;
    const anyFilter = state.role !== 'all'
      || state.year !== 'all'
      || (totalSegments > 0 && state.segments.size < totalSegments);
    document.querySelector('.hero')?.classList.toggle('is-pinned', anyFilter);
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

  // ── Desktop selection marks (rotating AHL logos) ────────────────────
  // (The frame auto-hide + footer latch are shared across index pages and
  // live in index-frame.js.) Three spinning AHL circles flag the current
  // selection: one before the active nav item, one before the in-view
  // segment chip, one after the active year. Each glides to its target
  // (left/top transition) while the target text stays put.
  if (window.matchMedia('(min-width: 992px)').matches) {
    var segLogo  = document.getElementById('segmentLogo');
    var SECTION_TO_SEG = { pi: 'team', team: 'team', alumni: 'alumni', collaborators: 'collaborators' };
    var GAP = 6;   // px between a logo and the text it flanks
    var spyRaf = 0;

    function focusedSegment() {
      // Reference line ~40% down the viewport; the section crossing it (or
      // nearest to it) is "current".
      var refY = window.innerHeight * 0.4;
      var nodes = (state.view === 'honeycomb')
        ? hivesWrap.querySelectorAll('.hive-section')
        : sectionsWrap.querySelectorAll('.people-section:not(.hidden)');
      var covering = null, nearest = null, nearestD = Infinity;
      nodes.forEach(function (sec) {
        var r = sec.getBoundingClientRect();
        if (r.height === 0) return;
        if (r.top <= refY && r.bottom >= refY) covering = sec;
        var d = Math.abs((r.top + r.bottom) / 2 - refY);
        if (d < nearestD) { nearestD = d; nearest = sec; }
      });
      var sec = covering || nearest;
      if (!sec) return null;
      var key = (state.view === 'honeycomb') ? sec.dataset.segment : sec.dataset.sectionKey;
      return SECTION_TO_SEG[key] || key || null;
    }

    // Segment logo — sits just BEFORE the in-view segment chip.
    function updateSegmentLogo() {
      spyRaf = 0;
      if (!segLogo) return;
      var seg = focusedSegment();
      var target = null;
      document.querySelectorAll('#segmentPills .hero-chip').forEach(function (c) {
        var on = c.dataset.segment === seg;
        c.classList.toggle('seg-focused', on);
        if (on) target = c;
      });
      if (!target) { segLogo.classList.remove('is-visible'); return; }
      var r = target.getBoundingClientRect();
      segLogo.style.left = (r.left - segLogo.offsetWidth - GAP) + 'px';
      segLogo.style.top  = (r.top + r.height / 2 - segLogo.offsetHeight / 2) + 'px';
      segLogo.classList.add('is-visible');
    }
    window.__peopleSegmentSpy = function () {
      if (spyRaf) return;
      spyRaf = requestAnimationFrame(updateSegmentLogo);
    };
    window.addEventListener('scroll', window.__peopleSegmentSpy, { passive: true });
    window.addEventListener('resize', window.__peopleSegmentSpy, { passive: true });
    window.__peopleSegmentSpy();

    // (The year-rail mark is shared across index pages — created + tracked
    // by index-frame.js, which follows the rail's `.active` year.)

    // (The nav mark — before the active nav item — is now shared across all
    // pages and created by nav-include.js.)

    // Re-place the segment mark once the layout has settled (async web fonts
    // shift the chip positions after first paint).
    function repositionAll() { window.__peopleSegmentSpy(); }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(repositionAll);
    window.addEventListener('load', repositionAll);
    setTimeout(repositionAll, 1200);
  }
})();