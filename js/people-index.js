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
    // When a year is picked, only team + pi are relevant (year-view
    // is a team snapshot). Segment toggles are disabled in that mode.
    if (state.year !== 'all') return seg === 'team';
    return state.segments.has(seg);
  }

  function matchesRole(card) {
    if (state.role === 'all') return true;
    // Cards without a data-role-group attribute hide under any
    // specific role filter — matches pre-existing behavior.
    return card.dataset.roleGroup === state.role;
  }

  function cardVisible(card) {
    return matchesYear(card) && matchesSegment(card) && matchesRole(card);
  }

  // ── Render: Grid view ────────────────────────────────────
  function renderGrid() {
    hivesWrap.hidden = true;
    sectionsWrap.hidden = false;

    // Per-card visibility
    allCards.forEach(card => {
      card.classList.toggle('hidden', !cardVisible(card));
    });

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
      lbl.textContent = crumbs.length ? `${base} / ${crumbs.join(' / ')}` : base;
    });
  }

  // ── Render: Honeycomb view ───────────────────────────────
  // Builds one hive per active segment. A "hive" is a spiral axial
  // hexagonal layout with one hex per person (photo + hover label).
  // When a year is selected, only the Team hive renders since
  // collaborators/alumni are suppressed in year-scoped mode.
  function renderHoneycomb() {
    sectionsWrap.hidden = true;
    hivesWrap.hidden = false;
    hivesWrap.innerHTML = '';

    // Which segments to render as hives?
    // Year-scoped mode → just Team. All-time mode → whichever segments
    // the user hasn't toggled off (+ PI always merged into Team).
    const segmentsToRender = (state.year !== 'all')
      ? ['team']
      : ['team', 'collaborators', 'alumni'].filter(s => state.segments.has(s));

    const SEGMENT_LABEL = {
      team: 'Current Team',
      collaborators: 'Collaborators',
      alumni: 'Alumni',
    };

    // Bucket matching cards by segment. PI always merges into team.
    const buckets = { team: [], collaborators: [], alumni: [] };
    allCards.forEach(card => {
      if (!matchesYear(card) || !matchesRole(card)) return;
      const seg = card.dataset.sectionKey;
      if (seg === 'pi') buckets.team.unshift(card);   // PI at center → prepend
      else if (buckets[seg]) buckets[seg].push(card);
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
      requestAnimationFrame(() => layoutHive(hive, cards));
    }
  }

  // ── Hive layout ──────────────────────────────────────────
  // Spiral axial layout: find smallest ring k that fits n hexes,
  // pick R so that k+0.5 rings fit in the container width/height,
  // emit one <a class="hex"> per card with translate positioning.
  function layoutHive(hive, cards) {
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
      const hex = document.createElement('a');
      hex.className = 'hex';
      hex.href = card.getAttribute('href');
      hex.dataset.section = card.dataset.sectionKey;
      hex.style.width  = hexW + 'px';
      hex.style.height = hexH + 'px';
      hex.style.transform = `translate(${(cx + px) - hexW / 2}px, ${(cy + py) - hexH / 2}px)`;
      const photo = card.dataset.photo || '';
      hex.innerHTML =
        `<span class="hex-inner" style="background-image:url('${photo.replace(/"/g, '&quot;')}')"></span>` +
        `<span class="hex-label">${card.dataset.name || ''} · ${card.dataset.role || ''}</span>`;
      frag.appendChild(hex);
    });
    hive.innerHTML = '';
    hive.appendChild(frag);
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

  // Relayout hives on resize (grid view needs no resize handling).
  let resizeRaf = 0;
  window.addEventListener('resize', () => {
    if (state.view !== 'honeycomb') return;
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => renderHoneycomb());
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