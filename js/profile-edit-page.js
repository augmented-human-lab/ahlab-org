/**
 * profile-edit-page.js — per-field inline editor for the
 * /people/<slug>/edit/ pages.
 *
 * Page model:
 *   Every person has a duplicate of /people/<slug>/index.html
 *   emitted by build-people.js at /people/<slug>/edit/index.html.
 *   It's byte-identical to the public page EXCEPT:
 *     • <body data-edit-mode-page data-person-slug="…">
 *     • noindex meta + edited <title>
 *     • this script + profile-edit.css loaded at the bottom
 *
 *   Visiting the URL while NOT signed in as the owner → page
 *   shows a small banner ("Sign in as <name> to edit") and the
 *   pencils never appear; the rest of the page renders as the
 *   public read-only profile minus the sections we hide via CSS
 *   (expertise / projects grid / publications / events row are
 *   off-topic for editing).
 *
 * Per-field model:
 *   Each editable field gets its own pencil button injected via
 *   JS. Click pencil → that field enters edit mode:
 *     • pencil hidden
 *     • check icon appears
 *     • input / textarea / picker takes over the visible value
 *   Exit edit mode by either:
 *     • clicking the check icon, or
 *     • clicking anywhere outside that field's block.
 *   On exit we commit the typed value to the local dirty map and
 *   re-render the field's view-mode DOM with the new value, so
 *   the user sees their pending change immediately. The check
 *   icon disappears and the pencil comes back.
 *
 * Fields wired:
 *   profile_image       (overlay pencil → file picker)
 *   role                (inline <input>)
 *   bio                 (<textarea>; multi-paragraph split on
 *                        \n\n preserved on commit)
 *   featured_project    (search-as-you-type picker; on pick we
 *                        fetch the project record from cdn so we
 *                        can re-render the featured card with the
 *                        new thumbnail)
 *   linkedin / github / google_scholar
 *                       (single pencil on .profile-socials →
 *                        floating panel with the three URL inputs;
 *                        committed together by outside-click or ✓)
 *
 * Submit:
 *   Sticky bar at the bottom of the viewport, visible only when
 *   the dirty map is non-empty. Click → AHLImage.process the
 *   photo file if present (greyscale policy), then
 *   AHLPatch.submit({targetType:'profile', …}). The broker
 *   validates + queues for moderator review; the diff email
 *   (renderEmailProfileCard_ in email.js) renders the changes.
 */
(function () {
  'use strict';

  var body = document.body;
  if (!body.hasAttribute('data-edit-mode-page')) return;  // wrong page

  var pageSlug = body.getAttribute('data-person-slug') || '';
  var record   = null;     // canonical record from cdn
  var dirty    = {};       // map: field name → current value (or File)
  var editing  = null;     // currently-editing field key, or null
  // A role change is a two-step edit: pick the new title, then set an
  // effective date. It only becomes a pending change (role + ahlab_stints in
  // `dirty`) once the date is valid. { role, effective } while in progress.
  var roleChange   = null;
  var savedTimeline = null;   // { html, n } snapshot for restoring the graph

  // ── Auth gate ───────────────────────────────────────────────
  function whenAuthReady(cb) {
    if (window.AHLAuth) { window.AHLAuth.onChange(cb); return; }
    var t = setInterval(function () {
      if (!window.AHLAuth) return;
      clearInterval(t);
      window.AHLAuth.onChange(cb);
    }, 100);
  }
  whenAuthReady(function (user) {
    var ownerSlug = user && user.person && user.person.slug;
    if (!user) {
      showBanner('Sign in as the profile owner to edit this page.',
        '<button type="button" onclick="window.AHLAuth.login()">Sign in</button>');
      return;
    }
    if (ownerSlug !== pageSlug) {
      showBanner('You can only edit your own profile. ' +
        'You\'re signed in as ' + escapeHtml(user.name || user.email || '?') + '.', '');
      return;
    }
    activateOwnerMode();
  });

  function activateOwnerMode() {
    document.documentElement.classList.add('is-edit-mode');
    showBanner('Editing your profile. Changes require moderator approval.',
      '<a href="/people/' + encodeURIComponent(pageSlug) + '/" class="bnr-link">View public profile</a>');
    fetchRecord(pageSlug).then(function (rec) {
      record = rec || {};
      injectPencils();
      injectSubmitBar();
    });
  }
  function fetchRecord(slug) {
    return fetch('https://cdn.ahlab.org/data/people/' + encodeURIComponent(slug) + '.json',
        { cache: 'default' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  // ── Pencil + check icons ────────────────────────────────────
  function pencilSVG() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>' +
      '</svg>';
  }
  function checkSVG() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" ' +
      'stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M5 13l4 4L19 7"/></svg>';
  }
  function makePencil(label, onClick) {
    return makeIconBtn('pe-pencil', label, pencilSVG(), onClick);
  }
  function makeCheck(label, onClick) {
    return makeIconBtn('pe-check', label, checkSVG(), onClick);
  }
  function makeIconBtn(cls, label, svg, onClick) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = cls;
    btn.setAttribute('aria-label', label);
    btn.title = label;
    btn.innerHTML = svg;
    btn.addEventListener('click', function (e) {
      e.stopPropagation();   // outside-click handler shouldn't
                             // immediately re-commit
      onClick(e);
    });
    return btn;
  }

  // ── Outside-click commit machinery ──────────────────────────
  // One global mousedown listener; if we're in edit mode and the
  // click target is outside the editing block, commit the field.
  // Using mousedown (not click) so the commit happens before any
  // focus / blur side-effects that follow a click.
  document.addEventListener('mousedown', function (e) {
    if (!editing) return;
    var blockEl = editing.blockEl;
    if (!blockEl) return;
    if (blockEl.contains(e.target)) return;        // click inside
    editing.commit();
  });

  // Helper for fields to enter edit mode. The caller passes:
  //   key       — field name (matches the broker's schema)
  //   blockEl   — the DOM region the user is editing (the outside-click
  //               handler treats clicks INSIDE this as "still editing")
  //   render    — function that mutates blockEl to show the editing UI
  //               and returns a `commit()` callback
  function enterEditMode(key, blockEl, render) {
    if (editing) editing.commit();   // commit whatever's in flight
    var commit = render();
    editing = { key: key, blockEl: blockEl, commit: function () {
      // Idempotent — multiple outside-clicks/check-clicks shouldn't
      // double-fire the per-field commit.
      if (!editing || editing.key !== key) return;
      editing = null;
      try { commit(); } catch (e) { /* swallow */ }
    } };
  }

  // ── Pencil injection per field ──────────────────────────────
  function injectPencils() {
    addPhotoPencil();
    addRolePencil();
    addBioPencil();
    addFeaturedProjectPencil();
    addSocialsPencil();
    // (external_links pencil removed per UX spec — bio/role/social
    // cover the visible editing surface; if we want to bring it
    // back, restore addExternalLinksPencil from git history.)
  }

  // ── Photo ───────────────────────────────────────────────────
  // No real "edit mode" — click the pencil → file picker → image
  // preview replaces the current src + dirty.profile_image set.
  function addPhotoPencil() {
    var wrap = document.querySelector('.profile-photo');
    if (!wrap) return;
    var img = wrap.querySelector('img');
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    input.addEventListener('change', function () {
      var f = input.files && input.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () { if (img) img.src = reader.result; };
      reader.readAsDataURL(f);
      dirty.profile_image = f;
      refreshSubmitBar();
    });
    wrap.appendChild(input);
    var btn = makePencil('Change photo', function () { input.click(); });
    btn.classList.add('pe-pencil-photo');
    wrap.appendChild(btn);
    wrap.classList.add('pe-has-pencil');
  }

  // ── Role ────────────────────────────────────────────────────
  // Positions are picked from the lab's canonical list rather than typed
  // free-form, so titles stay consistent with the role-group filters and
  // stint semantics. (Principal Investigator is a fixed designation and is
  // deliberately not self-selectable here.)
  var LAB_POSITIONS = [
    'Senior Research Fellow',
    'Research Fellow',
    'Postdoctoral Researcher',
    'Research Engineer',
    'Research Associate',
    'Research Assistant',
    'PhD Candidate',
    'PhD Student',
    'Master Student',
    'Visiting Student',
    'Research Visitor',
    'Research Attachment',
    'Intern',
  ];
  function addRolePencil() {
    var el = document.querySelector('.profile-role');
    if (!el) return;
    mountReadMode(el, function () { return roleViewHTML(getCurrentRole()); }, onPencilClick);
    function onPencilClick() {
      enterEditMode('role', el, function () {
        var current = getCurrentRole();
        var picker = document.createElement('div');
        picker.className = 'pe-featured-picker pe-role-picker';
        picker.innerHTML =
          '<input type="text" class="pe-featured-search pe-role-search" ' +
            'placeholder="Search positions…" autocomplete="off">' +
          '<ul class="pe-featured-suggestions pe-role-suggestions" role="listbox"></ul>';
        el.innerHTML = '';
        el.appendChild(picker);
        var input = picker.querySelector('input');
        var list  = picker.querySelector('ul');
        function pickRole(role) {
          var v = String(role || '').trim();
          // A role change drives a stint transition, gated on an effective
          // date — so picking a NEW title opens the effective-date field and
          // is NOT counted as a pending change until that date is set. Picking
          // the current title (or clearing) cancels any in-progress change.
          var isChange = v && v !== currentEffectiveRole();
          roleChange = isChange ? { role: v, effective: '' } : null;
          editing && editing.commit();   // close the picker (renders the role text)
          if (isChange) showEffectiveDateField();
          else          removeEffectiveDateField();
          syncRoleChangeDirty();         // no dirty role/stints until a valid date
        }
        renderRoleSuggestions(list, '', current, pickRole);
        input.addEventListener('input', function () {
          renderRoleSuggestions(list, input.value, current, pickRole);
        });
        input.addEventListener('keydown', function (e) {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          // Enter picks the first (or only) match; with none, close unchanged.
          var first = list.querySelector('.pe-featured-suggestion[data-role]');
          if (first) pickRole(first.getAttribute('data-role'));
          else editing && editing.commit();
        });
        setTimeout(function () { input.focus(); }, 0);
        return function commitRole() {
          el.innerHTML = roleViewHTML(getCurrentRole());
          attachPencil(el, 'Edit role', onPencilClick);
        };
      });
    }
  }
  function renderRoleSuggestions(list, query, selectedRole, onPick) {
    var q = String(query || '').trim().toLowerCase();
    var matches = LAB_POSITIONS.filter(function (r) {
      return !q || r.toLowerCase().indexOf(q) !== -1;
    });
    list.innerHTML = '';
    if (!matches.length) {
      var empty = document.createElement('li');
      empty.className = 'pe-featured-empty';
      empty.textContent = 'No positions match "' + query + '".';
      list.appendChild(empty);
      return;
    }
    matches.forEach(function (r) {
      var li = document.createElement('li');
      li.className = 'pe-featured-suggestion';
      if (r === selectedRole) li.classList.add('is-selected');
      li.setAttribute('data-role', r);
      li.innerHTML = '<span class="pe-featured-title">' + escapeHtml(r) + '</span>';
      li.addEventListener('mousedown', function (e) {
        e.preventDefault();    // keep focus stability
        onPick(r);
      });
      list.appendChild(li);
    });
  }
  function getCurrentRole() {
    if (roleChange) return roleChange.role;     // pending-change preview
    if ('role' in dirty) return String(dirty.role || '');
    return String(record && record.role || '');
  }
  // The role the site currently shows for this person — derived from the
  // most recent open stint (mirrors build/lib/stints.js effectiveRole), with
  // the flat `role` as the fallback. Used to decide whether a picked title is
  // actually a change.
  function currentEffectiveRole() {
    var filled = ((record && record.ahlab_stints) || []).filter(stintFilled)
      .slice().sort(function (a, b) { return String(a.start).localeCompare(String(b.start)); });
    if (!filled.length) return String(record && record.role || '');
    var open = filled.slice().reverse().filter(function (s) { return s.end == null; })[0];
    var pick = open || filled[filled.length - 1];
    return String((pick && pick.role) || (record && record.role) || '');
  }

  // ── Role-change (promotion) machinery ───────────────────────
  // Shows an effective-date field under the role; only once a valid date is
  // entered does the change register (role + a projected ahlab_stints that
  // closes the current open stint and opens a new one), and the Then→Now
  // graph re-renders live to add the new node.
  function showEffectiveDateField() {
    var el = document.querySelector('.profile-role');
    if (!el) return;
    removeEffectiveDateField();
    var openStart = currentOpenStintStart();
    var minAttr = toDateAttr(openStart);
    var wrap = document.createElement('span');
    wrap.className = 'pe-role-effective';
    wrap.innerHTML =
      '<span class="pe-role-effective-label">Effective date</span>' +
      '<input type="date" class="pe-role-effective-input"' +
        (minAttr ? ' min="' + escapeHtml(minAttr) + '"' : '') +
        ' max="' + effectiveMaxDate() + '">';
    // Sit the field inline on the same line as the role.
    el.appendChild(wrap);
    var input = wrap.querySelector('input');
    input.value = roleChange && roleChange.effective ? roleChange.effective : '';
    input.addEventListener('input', function () {
      roleChange && (roleChange.effective = input.value);
      wrap.classList.toggle('is-invalid', !!input.value && !isValidEffective(input.value));
      syncRoleChangeDirty();
    });
    setTimeout(function () { input.focus(); }, 0);
  }
  function removeEffectiveDateField() {
    var w = document.querySelector('.pe-role-effective');
    if (w) w.remove();
  }
  // The start date of the current open stint (the one a promotion closes).
  function currentOpenStintStart() {
    var open = ((record && record.ahlab_stints) || []).filter(function (s) {
      return s && s.end == null && stintFilled(s);
    }).slice().sort(function (a, b) { return String(a.start).localeCompare(String(b.start)); });
    return open.length ? String(open[open.length - 1].start) : '';
  }
  // Normalize an ISO partial ("2025", "2025-06", "2025-06-15") to a full
  // YYYY-MM-DD for a date input's min/max attribute.
  function toDateAttr(iso) {
    var s = String(iso || '');
    if (/^\d{4}$/.test(s)) return s + '-01-01';
    if (/^\d{4}-\d{2}$/.test(s)) return s + '-01';
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    return '';
  }
  // Format a Date as a LOCAL YYYY-MM-DD (toISOString would shift by the UTC
  // offset and land on the wrong day in +ve timezones).
  function ymdLocal(d) {
    return d.getFullYear() + '-' +
      ('0' + (d.getMonth() + 1)).slice(-2) + '-' +
      ('0' + d.getDate()).slice(-2);
  }
  // Upper bound for the effective date: the end of NEXT month, so an upcoming
  // promotion can be recorded a little early. (day 0 of the month after next
  // = the last day of next month.)
  function effectiveMaxDate() {
    var now = new Date();
    return ymdLocal(new Date(now.getFullYear(), now.getMonth() + 2, 0));
  }
  function isValidEffective(date) {
    if (!date) return false;
    var openStart = currentOpenStintStart();
    // Must fall strictly after the current role began (else the new stint
    // would sort before it and the derived role wouldn't flip).
    if (openStart && String(date) <= String(openStart)) return false;
    // No further into the future than the end of next month.
    if (String(date) > effectiveMaxDate()) return false;
    return true;
  }
  // Reflect the in-progress role change into `dirty` + the live graph. Sets
  // dirty.role and dirty.ahlab_stints only when the effective date is valid;
  // otherwise clears them (so "Submit for review" stays disabled).
  function syncRoleChangeDirty() {
    if (roleChange && isValidEffective(roleChange.effective)) {
      dirty.role = roleChange.role;
      dirty.ahlab_stints = projectPromotionStints(roleChange.role, roleChange.effective);
      renderTimelinePreview(dirty.ahlab_stints);
    } else {
      delete dirty.role;
      delete dirty.ahlab_stints;
      restoreTimeline();
    }
    refreshSubmitBar();
  }
  // Close the current open stint at `effective` and append a new open stint
  // with the new role — the canonical promotion transition (mirrors the
  // welcome-form merge and build/lib/stints.js semantics).
  function projectPromotionStints(newRole, effective) {
    var base = ((record && record.ahlab_stints) || []).map(function (s) {
      return { role: s.role, start: s.start, end: s.end };   // shallow clone
    });
    base.forEach(function (s) {
      if (s.end == null && s.start && String(s.start) <= String(effective)) s.end = effective;
    });
    base.push({ role: newRole, start: effective, end: null });
    return base;
  }

  // ── Live Then→Now graph preview ─────────────────────────────
  // Re-renders the AHL side of the timeline from a projected stint array so a
  // promotion shows up immediately: the previous "Now" node becomes a past
  // node and a new "Now" node carries the new role. Mirrors buildTimeline in
  // build-people.js for the current-member case (self-edit is a current
  // member). The first change snapshots the original markup so we can restore.
  function renderTimelinePreview(projectedStints) {
    var track = document.querySelector('.profile-timeline .tl-track');
    if (!track) return;
    if (!savedTimeline) {
      savedTimeline = { html: track.innerHTML, n: track.style.getPropertyValue('--tl-n') };
    }
    var filled = (projectedStints || []).filter(stintFilled)
      .slice().sort(function (a, b) { return String(a.start).localeCompare(String(b.start)); });
    var career0 = (record && record.career && record.career[0]) || {};
    var before = { org: career0.org || '', role: career0.role || '', period: career0.period || '' };
    var ahl = filled.map(function (s) {
      return { org: 'AHL', role: s.role || '', period: formatStintPeriodJS(s), open: s.end == null };
    });
    var nodes = [before].concat(ahl);
    var currentIdx = nodes.length - 1;
    for (var i = nodes.length - 1; i >= 0; i--) { if (nodes[i].open) { currentIdx = i; break; } }
    var N = nodes.length;
    track.style.setProperty('--tl-n', String(N));
    track.innerHTML = nodes.map(function (n, idx) {
      return timelineNodeHTML(n, idx, N, currentIdx);
    }).join('');
  }
  function restoreTimeline() {
    if (!savedTimeline) return;
    var track = document.querySelector('.profile-timeline .tl-track');
    if (track) {
      track.innerHTML = savedTimeline.html;
      if (savedTimeline.n) track.style.setProperty('--tl-n', savedTimeline.n);
      else track.style.removeProperty('--tl-n');
    }
    savedTimeline = null;
  }
  function timelineNodeHTML(n, i, N, currentIdx) {
    var header = i === N - 1 ? 'Now' : 'Then';
    var isEmpty = !n.org && !n.role && !n.period;
    var cls = 'tl-node' + (isEmpty ? ' is-empty' : '') + (i === currentIdx ? ' is-current' : '');
    if (isEmpty) {
      return '<div class="' + cls + '" title="Before AHL — not added yet">' +
        '<div class="tl-col-header">' + escapeHtml(header) + '</div>' +
        '<div class="tl-dot"></div><div class="tl-label">—</div></div>';
    }
    var duration = formatDurationJS(n.period);
    return '<div class="' + cls + '">' +
      '<div class="tl-col-header">' + escapeHtml(header) + '</div>' +
      '<div class="tl-dot"></div>' +
      '<div class="tl-label">' +
        (n.org ? '<div class="tl-org">' + escapeHtml(n.org) + '</div>' : '') +
        (n.role ? '<div class="tl-role">' + escapeHtml(n.role) + '</div>' : '') +
        (duration ? '<div class="tl-duration">' + escapeHtml(duration) + '</div>' : '') +
      '</div></div>';
  }
  // Compact mirrors of build/lib/stints.js helpers for the browser preview.
  function stintFilled(s) { return !!s && !isNaN(startYearJS(s.start)); }
  function startYearJS(iso) {
    var m = /^(\d{4})/.exec(String(iso == null ? '' : iso).trim());
    return m ? parseInt(m[1], 10) : NaN;
  }
  function formatStintPeriodJS(s) {
    var sy = startYearJS(s.start);
    if (isNaN(sy)) return '';
    if (s.end == null) return sy + '–present';
    var ey = startYearJS(s.end);
    if (isNaN(ey) || ey === sy) return String(sy);
    return sy + '–' + ey;
  }
  function formatDurationJS(period) {
    if (!period) return '';
    var parts = String(period).trim().split(/\s*[-–—]\s*/);
    if (parts.length < 2) return '';
    var sy = parseInt((parts[0].match(/\d{4}/) || [])[0], 10);
    if (isNaN(sy)) return '';
    var ey = /^(present|now|current)$/i.test(parts[1].trim())
      ? new Date().getFullYear()
      : parseInt((parts[1].match(/\d{4}/) || [])[0], 10);
    if (isNaN(ey)) return '';
    var years = ey - sy;
    if (years < 0) return '';
    if (years === 0) return '<1 year';
    return years === 1 ? '1 year' : years + ' years';
  }
  function roleViewHTML(value) {
    // Match the read-page rendering: just plain text. The pencil
    // is appended afterwards by attachPencil so we don't have to
    // splice text + button in the same string.
    return escapeHtml(value);
  }

  // ── Bio ─────────────────────────────────────────────────────
  function addBioPencil() {
    var bio = document.querySelector('.profile-content');
    var created = false;
    if (!bio) {
      var introGrid = document.querySelector('.profile-intro-grid')
                   || document.querySelector('.profile-body');
      if (!introGrid) return;
      bio = document.createElement('div');
      bio.className = 'profile-content rv vis';
      introGrid.insertBefore(bio, introGrid.firstChild);
      created = true;
    }
    // Wire the click handler BEFORE the first render so renderBioRead
    // (which reads bio.__peOnPencil when it appends the inline pencil)
    // gets the live handler on the initial paint too.
    bio.__peOnPencil = onPencilClick;
    renderBioRead(bio, created ? '' : getCurrentBio());
    function onPencilClick() {
      enterEditMode('bio', bio, function () {
        var current = getCurrentBio();
        var ta = document.createElement('textarea');
        ta.className = 'pe-inline-textarea';
        ta.value = current;
        ta.rows = Math.min(20, Math.max(8, current.split('\n').length + 4));
        ta.maxLength = 5000;
        ta.addEventListener('input', function () {
          var v = ta.value;
          var orig = String(record.bio || '');
          if (v === orig) delete dirty.bio;
          else dirty.bio = v;
          refreshSubmitBar();
        });
        bio.classList.add('pe-editing');
        bio.innerHTML = '';
        bio.appendChild(ta);
        setTimeout(function () { ta.focus(); }, 0);
        return function commitBio() {
          var v = ta.value;
          bio.classList.remove('pe-editing');
          renderBioRead(bio, v);
        };
      });
    }
  }
  function getCurrentBio() {
    if ('bio' in dirty) return String(dirty.bio || '');
    return String(record && record.bio || '');
  }
  function renderBioRead(bio, text) {
    bio.classList.remove('pe-editing');
    bio.innerHTML = '';
    var lastEl = null;
    if (!text) {
      var empty = document.createElement('p');
      empty.className = 'pe-empty';
      empty.textContent = '(no bio yet — click the pencil to add one)';
      bio.appendChild(empty);
      lastEl = empty;
    } else {
      text.split(/\n\n+/).forEach(function (para) {
        var p = document.createElement('p');
        p.textContent = para;
        bio.appendChild(p);
        lastEl = p;
      });
    }
    // Pencil flows inline at the very end of the last paragraph.
    var btn = makePencil('Edit bio', bio.__peOnPencil || function () {});
    btn.classList.add('pe-pencil-inline');
    if (lastEl) {
      lastEl.appendChild(document.createTextNode(' '));
      lastEl.appendChild(btn);
    } else {
      bio.appendChild(btn);
    }
  }

  // ── Featured project (typeahead search picker) ──────────────
  function addFeaturedProjectPencil() {
    var card = document.querySelector('.profile-featured');
    if (!card) {
      // Inject an empty featured-project card so the user has
      // something to attach the pencil to.
      var introGrid = document.querySelector('.profile-intro-grid')
                   || document.querySelector('.profile-body');
      if (!introGrid) return;
      card = document.createElement('aside');
      card.className = 'profile-featured rv vis';
      card.setAttribute('aria-label', 'Featured project');
      card.innerHTML = '<div class="sidebar-section-title">Featured project</div>' +
        '<div class="pe-featured-card-slot"><div class="pe-empty">(none yet — click the pencil to pick)</div></div>';
      introGrid.appendChild(card);
    } else {
      // Existing card from build: wrap the project-card body into
      // a slot we can swap on commit.
      var children = Array.prototype.slice.call(card.childNodes);
      var slot = document.createElement('div');
      slot.className = 'pe-featured-card-slot';
      // Skip the section title; pull everything else into the slot.
      children.forEach(function (n) {
        if (n.nodeType === 1 && n.classList && n.classList.contains('sidebar-section-title')) return;
        slot.appendChild(n);
      });
      card.appendChild(slot);
    }
    function onPencilClick() {
      enterEditMode('featured_project', card, function () {
        // Slot becomes the typeahead picker.
        var slot = card.querySelector('.pe-featured-card-slot');
        var picker = document.createElement('div');
        picker.className = 'pe-featured-picker';
        picker.innerHTML =
          '<input type="text" class="pe-featured-search" placeholder="Search projects…" autocomplete="off">' +
          '<ul class="pe-featured-suggestions" role="listbox"></ul>';
        slot.replaceWith(picker);

        var input = picker.querySelector('.pe-featured-search');
        var list  = picker.querySelector('.pe-featured-suggestions');
        var projects = [];
        var selectedSlug = getCurrentFeatured();

        loadProjectsIndex().then(function (idx) {
          projects = Array.isArray(idx) ? idx : [];
          renderSuggestions(projects, list, '', selectedSlug, pickProject);
        });
        input.addEventListener('input', function () {
          renderSuggestions(projects, list, input.value, selectedSlug, pickProject);
        });
        function pickProject(slug) {
          selectedSlug = slug;
          var orig = String(record.featured_project || '');
          if (slug === orig) delete dirty.featured_project;
          else dirty.featured_project = slug;
          refreshSubmitBar();
          // Auto-commit on pick — the user's done with the picker.
          editing && editing.commit();
        }
        setTimeout(function () { input.focus(); }, 0);

        return function commitFeatured() {
          // Replace picker with a fresh card view of the chosen project.
          picker.replaceWith(buildFeaturedCardSlot(selectedSlug));
          attachPencil(card.querySelector('.sidebar-section-title') || card, 'Change featured project', onPencilClick);
        };
      });
    }
    attachPencil(card.querySelector('.sidebar-section-title') || card, 'Change featured project', onPencilClick);
  }
  function getCurrentFeatured() {
    if ('featured_project' in dirty) return String(dirty.featured_project || '');
    return String(record && record.featured_project || '');
  }
  function renderSuggestions(projects, list, query, selectedSlug, onPick) {
    var q = String(query || '').trim().toLowerCase();
    var matches = projects.filter(function (p) {
      if (!q) return true;
      return (p.title || '').toLowerCase().indexOf(q) !== -1
          || (p.slug  || '').toLowerCase().indexOf(q) !== -1;
    }).slice(0, 8);
    list.innerHTML = '';
    if (!matches.length) {
      var li = document.createElement('li');
      li.className = 'pe-featured-empty';
      li.textContent = q ? 'No projects match "' + q + '".' : '(no projects)';
      list.appendChild(li);
      return;
    }
    matches.forEach(function (p) {
      var li = document.createElement('li');
      li.className = 'pe-featured-suggestion';
      if (p.slug === selectedSlug) li.classList.add('is-selected');
      li.setAttribute('data-slug', p.slug);
      li.innerHTML =
        '<span class="pe-featured-title">' + escapeHtml(p.title || p.slug) + '</span>' +
        (p.year ? '<span class="pe-featured-year">' + escapeHtml(p.year) + '</span>' : '');
      li.addEventListener('mousedown', function (e) {
        e.preventDefault();    // keep focus stability
        onPick(p.slug);
      });
      list.appendChild(li);
    });
  }
  // Build a fresh DOM slot for the currently-selected featured
  // project, fetching its full record from cdn for the thumbnail.
  // Returns the slot element immediately and patches the thumbnail
  // in asynchronously.
  function buildFeaturedCardSlot(slug) {
    var slot = document.createElement('div');
    slot.className = 'pe-featured-card-slot';
    if (!slug) {
      slot.innerHTML = '<div class="pe-empty">(no featured project)</div>';
      return slot;
    }
    // Render the SAME markup as the build-time read card (h5 title on the
    // frosted bar + principle tag icons) so re-picking a project — even the
    // one already featured — produces an identical-looking card rather than
    // a black-titled, tag-less stub.
    slot.innerHTML = featuredCardHTML(slug, null);
    fetch('https://cdn.ahlab.org/data/projects/' + encodeURIComponent(slug) + '.json',
        { cache: 'default' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (proj) { if (proj) slot.innerHTML = featuredCardHTML(slug, proj); })
      .catch(function () { /* keep placeholder */ });
    return slot;
  }
  // Assistive-augmentation principle icons — mirrors PRINCIPLES in
  // build-people.js so the featured card's tag row matches the read page.
  var PRINCIPLE_ICON_BASE = 'https://cdn.ahlab.org/media/site/';
  var PRINCIPLES = {
    body:          { name: 'Body',          icon: 'icon-body-1.png',          iconHover: 'icon-body-hl.png' },
    cognitive:     { name: 'Cognitive',     icon: 'icon-cognitive-1.png',     iconHover: 'icon-cognitive-hl.png' },
    perceptual:    { name: 'Perceptual',    icon: 'icon-perceptual-1.png',    iconHover: 'icon-perceptual-hl.png' },
    physical:      { name: 'Physical',      icon: 'icon-physical-1.png',      iconHover: 'icon-physical-hl.png' },
    identity:      { name: 'Identity',      icon: 'icon-identity.png',        iconHover: 'icon-identity-hl.png' },
    sociocultural: { name: 'Sociocultural', icon: 'icon-sociocultural-1.png', iconHover: 'icon-sociocultural-hl.png' },
  };
  function renderProjectTags(keys) {
    var icons = (Array.isArray(keys) ? keys : [])
      .map(function (k) { return PRINCIPLES[k]; })
      .filter(Boolean)
      .map(function (p) {
        return '<span class="profile-project-card-tag" title="' + escapeHtml(p.name) + '" aria-label="' + escapeHtml(p.name) + '">' +
          '<img class="profile-project-card-tag-default" src="' + escapeHtml(PRINCIPLE_ICON_BASE + p.icon) + '" alt="" loading="lazy">' +
          '<img class="profile-project-card-tag-hover" src="' + escapeHtml(PRINCIPLE_ICON_BASE + p.iconHover) + '" alt="" loading="lazy">' +
        '</span>';
      }).join('');
    return icons ? '<div class="profile-project-card-tags">' + icons + '</div>' : '';
  }
  function featuredCardHTML(slug, proj) {
    var title = (proj && proj.title) ? proj.title : slug;
    var thumb = (proj && proj.thumbnail)
      ? '<img src="' + escapeHtml(proj.thumbnail) + '" alt="' + escapeHtml(title) + '" loading="lazy">'
      : '<div class="profile-project-card-placeholder">' + escapeHtml(String(title).charAt(0)) + '</div>';
    return '<a class="profile-project-card" href="/projects/' + escapeHtml(slug) + '/">' +
        '<div class="profile-project-card-thumb">' + thumb + '</div>' +
        '<div class="profile-project-card-body">' +
          '<h5>' + escapeHtml(title) + '</h5>' +
          renderProjectTags(proj && proj.principles) +
        '</div>' +
      '</a>';
  }

  // ── Social links (single panel for linkedin/github/scholar) ─
  function addSocialsPencil() {
    var row = document.querySelector('.profile-socials');
    if (!row) return;
    function onPencilClick() {
      enterEditMode('socials', row.parentNode, function () {
        // Panel is attached as a sibling so the outside-click
        // detection's blockEl needs to include both the row AND
        // the panel — easiest is to make the parent the blockEl.
        var panel = document.createElement('div');
        panel.className = 'pe-social-panel';
        panel.innerHTML =
          '<div class="pe-panel-title">Social links</div>' +
          renderUrlInput('linkedin', 'LinkedIn', getCurrentSocial('linkedin')) +
          renderUrlInput('github',   'GitHub',   getCurrentSocial('github')) +
          renderUrlInput('google_scholar', 'Google Scholar', getCurrentSocial('google_scholar'));
        Array.prototype.forEach.call(panel.querySelectorAll('input'), function (input) {
          var name = input.getAttribute('data-field');
          input.addEventListener('input', function () {
            var v = input.value.trim();
            var orig = String(record[name] || '');
            if (v === orig) delete dirty[name];
            else dirty[name] = v;
            refreshSubmitBar();
          });
        });
        row.parentNode.insertBefore(panel, row.nextSibling);
        var first = panel.querySelector('input');
        if (first) setTimeout(function () { first.focus(); }, 0);
        // Hide the pencil while the panel is open.
        var pencil = row.querySelector('.pe-pencil');
        if (pencil) pencil.style.visibility = 'hidden';
        return function commitSocials() {
          panel.remove();
          if (pencil) pencil.style.visibility = '';
        };
      });
    }
    attachPencil(row, 'Edit social links', onPencilClick);
  }
  function getCurrentSocial(key) {
    if (key in dirty) return String(dirty[key] || '');
    return String(record && record[key] || '');
  }
  function renderUrlInput(name, label, value) {
    var v = value == null ? '' : String(value);
    return '<label class="pe-panel-row">' +
      '<span class="pe-panel-label">' + escapeHtml(label) + '</span>' +
      '<input type="url" data-field="' + escapeHtml(name) + '" value="' + escapeHtml(v) + '" ' +
      'placeholder="https://…" inputmode="url">' +
    '</label>';
  }

  // ── Pencil attach / re-attach helper ────────────────────────
  // Removes any existing .pe-pencil inside `parent` and appends a
  // fresh one wired to onClick. Called from every field's render
  // step so the pencil reappears after each commit.
  function attachPencil(parent, label, onClick) {
    var existing = parent.querySelectorAll(':scope > .pe-pencil');
    Array.prototype.forEach.call(existing, function (p) { p.remove(); });
    var existingCheck = parent.querySelectorAll(':scope > .pe-check');
    Array.prototype.forEach.call(existingCheck, function (p) { p.remove(); });
    var btn = makePencil(label, onClick);
    parent.appendChild(btn);
  }

  // mountReadMode is reserved for future fields that need a
  // dedicated initial read-view re-render. Role uses attachPencil
  // directly; we keep this stub so the call sites in the
  // role/bio paths can share a shape.
  function mountReadMode(el, viewHtml, onPencilClick) {
    el.innerHTML = viewHtml();
    attachPencil(el, 'Edit', onPencilClick);
  }

  // ── Submit bar ──────────────────────────────────────────────
  function injectSubmitBar() {
    var bar = document.createElement('div');
    bar.className = 'pe-submitbar';
    bar.innerHTML =
      '<div class="pe-submitbar-inner">' +
        '<div class="pe-submitbar-count"></div>' +
        '<button type="button" class="pe-submitbar-cancel">Cancel changes</button>' +
        '<button type="button" class="pe-submitbar-submit" disabled>Submit for review</button>' +
      '</div>';
    document.body.appendChild(bar);
    bar.querySelector('.pe-submitbar-cancel').addEventListener('click', function () {
      if (Object.keys(dirty).length && !confirm('Discard all unsaved changes?')) return;
      location.reload();
    });
    bar.querySelector('.pe-submitbar-submit').addEventListener('click', submit);
  }
  function refreshSubmitBar() {
    var bar = document.querySelector('.pe-submitbar');
    if (!bar) return;
    var n = Object.keys(dirty).length;
    bar.classList.toggle('is-dirty', n > 0);
    bar.querySelector('.pe-submitbar-submit').disabled = (n === 0);
    bar.querySelector('.pe-submitbar-count').textContent =
      n === 0 ? '' :
      n === 1 ? '1 change pending' :
      n + ' changes pending';
  }

  function submit() {
    var keys = Object.keys(dirty);
    if (!keys.length) return;
    if (!window.AHLPatch) {
      alert('Submit helper not loaded yet — reload the page.');
      return;
    }
    if (!window.AHLAuth || !window.AHLAuth.getToken()) {
      alert('Sign in required.');
      window.AHLAuth && window.AHLAuth.login();
      return;
    }
    var btn = document.querySelector('.pe-submitbar-submit');
    btn.disabled = true;
    btn.textContent = 'Submitting…';
    // Freeze the editing surface while the submit is in flight — hide every
    // pencil so the user can't start another edit that won't be included in
    // this in-flight patch. Cleared again only if the submit fails (on
    // success the page navigates away to the broker receipt).
    document.documentElement.classList.add('is-submitting');
    var patch = {};
    var fileWork = [];
    keys.forEach(function (k) {
      if (k === 'profile_image' && dirty[k] instanceof File) {
        fileWork.push(
          window.AHLImage.process(dirty[k], { greyscale: true })
        );
      } else {
        patch[k] = dirty[k];
      }
    });
    Promise.all(fileWork).then(function (files) {
      window.AHLPatch.submit({
        targetType: 'profile',
        targetSlug: pageSlug,
        action:     'edit',
        patch:      patch,
        files:      files,
        returnUrl:  location.origin + '/my-ahl/'
      });
    }).catch(function (err) {
      document.documentElement.classList.remove('is-submitting');
      btn.disabled = false;
      btn.textContent = 'Submit for review';
      alert('Couldn\'t process the upload: ' + (err && err.message || err));
    });
  }

  // ── Banner ──────────────────────────────────────────────────
  function showBanner(text, extraHtml) {
    var b = document.createElement('div');
    b.className = 'pe-banner';
    b.innerHTML = '<span>' + escapeHtml(text) + '</span>' + (extraHtml || '');
    document.body.insertBefore(b, document.body.firstChild);
  }

  // ── Helpers ─────────────────────────────────────────────────
  var projectsPromise = null;
  function loadProjectsIndex() {
    if (projectsPromise) return projectsPromise;
    projectsPromise = fetch('/data/projects-index.json', { cache: 'default' })
      .then(function (r) { return r.ok ? r.json() : []; })
      .catch(function () { return []; });
    return projectsPromise;
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
})();
