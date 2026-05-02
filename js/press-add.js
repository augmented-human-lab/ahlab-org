/**
 * press-add.js — reusable inline form for adding a press mention
 * (news / award / video). Used on /my-ahl/ and on the public
 * /press/ page. Logged-in users only.
 *
 * Wiring:
 *   Auto-mounts a click handler on every [data-press-add-trigger]
 *   button. Click swaps the trigger (or its closest
 *   [data-press-add-wrap] ancestor) for an editable card; Cancel
 *   restores the original.
 *
 *   Pages must:
 *     • load /js/press-add.js (defer)
 *     • load /css/forms-add.css
 *     • render a button with [data-press-add-trigger]
 *
 * Patch payload (matches submit.js validatePressPatch_):
 *   {
 *     title, type ('news'|'award'|'video'),
 *     outlet, year, url,
 *     projectSlug (optional)
 *   }
 *
 * URL validation:
 *   • format check: must be a valid http(s) URL
 *   • best-effort liveness: `fetch(url, {mode:'no-cors'})` — opaque
 *     responses count as "probably alive"; network errors as "dead".
 *     Browsers can't read status codes through CORS, so a 404 from
 *     a CORS-permissive server can still register as alive. Broker
 *     re-checks server-side.
 */
(function () {
  'use strict';

  var PROJECTS_INDEX_URL = '/data/projects-index.json';
  var URL_DEBOUNCE_MS = 600;

  var TYPES = [
    { key: 'news',  label: 'News'  },
    { key: 'award', label: 'Award' },
    { key: 'video', label: 'Video' }
  ];

  var projectsPromise = null;
  function loadProjectsIndex() {
    if (projectsPromise) return projectsPromise;
    projectsPromise = fetch(PROJECTS_INDEX_URL, { cache: 'default' })
      .then(function (r) { return r.ok ? r.json() : []; })
      .catch(function () { return []; });
    return projectsPromise;
  }

  function ensureSvgDefs() {
    if (document.getElementById('i-myahl-link')) return;
    var defs = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    defs.setAttribute('aria-hidden', 'true');
    defs.style.display = 'none';
    defs.innerHTML = SVG_DEFS;
    document.body.insertBefore(defs, document.body.firstChild);
  }
  // Mirrors my-ahl.html static defs; idempotent. Same fallback as
  // publication-add.js — kept as a self-contained block so this
  // module works on any page without external dependencies.
  var SVG_DEFS =
    '<symbol id="i-myahl-link" viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 1 0-7.07-7.07l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 1 0 7.07 7.07l1.5-1.5"/></symbol>' +
    '<symbol id="i-myahl-x" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></symbol>' +
    '<symbol id="i-myahl-award" viewBox="0 0 24 24"><circle cx="12" cy="9" r="6"/><path d="M8.5 14.5L7 22l5-3 5 3-1.5-7.5"/></symbol>' +
    '<symbol id="i-myahl-project" viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5"/></symbol>' +
    '<symbol id="i-myahl-news" viewBox="0 0 24 24"><path d="M4 4h13a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4z"/><path d="M19 6h2v12a2 2 0 0 1-2 2"/><path d="M8 8h7M8 12h7M8 16h4"/></symbol>' +
    '<symbol id="i-myahl-video" viewBox="0 0 24 24"><polygon points="10 8 16 12 10 16 10 8" fill="currentColor" stroke="none"/><rect x="3" y="5" width="18" height="14" rx="2"/></symbol>';

  function svgIcon(name) {
    return '<svg class="myahl-pa-icon" aria-hidden="true"><use href="#i-myahl-' + name + '"/></svg>';
  }

  // ── URL validation ──────────────────────────────────────────
  // Format: must parse as URL with http/https scheme.
  function isValidUrlShape(s) {
    if (!s) return false;
    try {
      var u = new URL(s);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch (e) { return false; }
  }
  // Best-effort liveness — opaque-response no-cors fetch. Returns:
  //   'alive' on non-error, 'dead' on network error,
  //   'unknown' if the URL is malformed (caller should reject earlier).
  function pingUrl(url) {
    if (!isValidUrlShape(url)) return Promise.resolve('unknown');
    return fetch(url, { method: 'GET', mode: 'no-cors', cache: 'no-store' })
      .then(function () { return 'alive'; })
      .catch(function () { return 'dead'; });
  }

  // ── Public API ──────────────────────────────────────────────
  function mount(button) {
    if (!button || button.__pressAddMounted) return;
    button.__pressAddMounted = true;
    button.disabled = false;
    button.removeAttribute('title');
    ensureSvgDefs();
    button.addEventListener('click', function (e) {
      e.preventDefault();
      openCard(button);
    });
  }

  // `prefill` (optional) supports EDIT mode — pre-populate fields
  // from an existing press record, stamp `editSlug` so submit sends
  // action='edit'.
  function openCard(button, prefill) {
    var originalEl =
      button.closest('[data-press-add-wrap]') ||
      button.closest('li') ||
      button;
    var card = buildCard();
    if (prefill && prefill.editSlug) card.el.classList.add('is-edit-mode');
    originalEl.replaceWith(card.el);

    // Pre-fill simple text fields BEFORE wiring handlers (which call
    // renderState, reading these values).
    if (prefill) {
      if (prefill.title)  card.title.value  = prefill.title;
      if (prefill.outlet) card.outlet.value = prefill.outlet;
      if (prefill.year)   card.year.value   = prefill.year;
    }

    var session = {
      el:          card,
      type:        (prefill && prefill.type) || 'news',
      submitter:   getSubmitterSlug(),
      projectsIdx: [],
      project:     prefill && prefill.project ? prefill.project : null,
      // Pre-seed URL as "alive" since the existing record's URL was
      // accepted at submission time. Skip re-pinging on open.
      url:         (prefill && prefill.url)
        ? { value: prefill.url, status: 'alive' }
        : { value: '', status: 'idle' },
      editSlug:    prefill && prefill.editSlug ? prefill.editSlug : null
    };
    if (session.editSlug) {
      card.submit.textContent = 'Submit edit for review';
      // Reflect the seeded type in the icon + tag immediately.
      if (session.type !== 'news') {
        card.iconUse.setAttribute('href', '#i-myahl-' + session.type);
        card.iconBtn.className = 'press-add-icon ' + session.type;
        card.iconBtn.setAttribute('aria-label', 'Press type: ' + session.type);
        var tag = card.el.querySelector('.press-type-tag');
        if (tag) {
          tag.className = 'press-type-tag ' + session.type;
          tag.textContent = session.type;
        }
        card.el.classList.remove('is-news', 'is-award', 'is-video');
        card.el.classList.add('is-' + session.type);
        card.el.dataset.pressType = session.type;
      }
    }

    loadProjectsIndex().then(function (idx) { session.projectsIdx = idx || []; });

    // Type cycle — clicking the icon advances news → award → video → news.
    // Updates the icon symbol, the .press-type-tag text+colour, and the
    // card's data-press-type so any CSS scoped on it picks up the change.
    card.iconBtn.addEventListener('click', function () {
      var idx = TYPES.findIndex(function (t) { return t.key === session.type; });
      var next = TYPES[(idx + 1) % TYPES.length];
      session.type = next.key;
      card.iconUse.setAttribute('href', '#i-myahl-' + next.key);
      card.iconBtn.className = 'press-add-icon ' + next.key;
      card.iconBtn.setAttribute('aria-label', 'Press type: ' + next.key);
      card.typeTag.className = 'press-type-tag ' + next.key;
      card.typeTag.textContent = next.key;
      card.el.classList.remove('is-news', 'is-award', 'is-video');
      card.el.classList.add('is-' + next.key);
      card.el.dataset.pressType = next.key;
      renderState(session);
    });

    card.title.addEventListener('input',  function () { renderState(session); });
    card.outlet.addEventListener('input', function () { renderState(session); });
    card.year.addEventListener('input',   function () { renderState(session); });
    card.cancel.addEventListener('click', function () { card.el.replaceWith(originalEl); });
    card.submit.addEventListener('click', function () { submit(session); });

    // Link button: toggles title↔url mode in the same slot.
    card.linkBtn.addEventListener('click', function () {
      if (card.titleRow.dataset.mode === 'url') closeUrlEdit(session);
      else openUrlEdit(session);
    });
    // URL input: validate on Enter / blur. Escape cancels.
    card.url.addEventListener('keydown', function (e) {
      if (e.key === 'Enter')      { e.preventDefault(); commitUrl(session); }
      else if (e.key === 'Escape'){ e.preventDefault(); closeUrlEdit(session); }
    });
    card.url.addEventListener('blur', function () {
      // Only commit if we're still in URL-edit mode (user might have
      // clicked outside the card, focus moves out, blur fires).
      if (card.titleRow.dataset.mode === 'url') commitUrl(session);
    });

    // Project picker (single-select for press — broker accepts one
    // projectSlug). Same chip pattern as the publication form.
    card.projectAdd.addEventListener('click', function (e) {
      e.stopPropagation();
      openProjectPicker(session);
    });
    card.projectSearch.addEventListener('input', function () { renderProjectList(session); });
    card.projectSearch.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); closeProjectPicker(session); }
      if (e.key === 'Enter')  {
        e.preventDefault();
        var first = card.projectList.querySelector('li[data-slug]');
        if (first) addProjectFromEl(session, first);
      }
    });
    card.projectList.addEventListener('click', function (e) {
      var li = e.target.closest('li[data-slug]');
      if (li) addProjectFromEl(session, li);
    });
    card.projectChips.addEventListener('click', function (e) {
      var x = e.target.closest('[data-remove-project]');
      if (x) removeProject(session);
    });
    document.addEventListener('click', function (e) {
      if (card.projectPicker.hidden) return;
      if (card.projectZone.contains(e.target)) return;
      closeProjectPicker(session);
    });

    setTimeout(function () { card.title.focus(); }, 0);
    renderState(session);
  }

  // ── URL inline-edit ─────────────────────────────────────────
  // Toggle title↔url within the same row. On commit, validate the
  // shape and ping for liveness; on success, the title gains a link
  // underline and the link button glows to indicate "URL set".
  function openUrlEdit(session) {
    var card = session.el;
    card.url.value = session.url.value || '';
    card.titleRow.dataset.mode = 'url';
    setTimeout(function () { card.url.focus(); card.url.select(); }, 0);
  }
  function closeUrlEdit(session) {
    session.el.titleRow.dataset.mode = 'title';
    renderState(session);
  }
  function commitUrl(session) {
    var card = session.el;
    var raw  = (card.url.value || '').trim();
    if (!raw) {
      session.url = { value: '', status: 'idle' };
      closeUrlEdit(session);
      return;
    }
    if (!isValidUrlShape(raw)) {
      // Stay in URL-edit mode so the user can fix; the priority
      // hint at the bottom surfaces the format error.
      session.url = { value: raw, status: 'invalid' };
      renderState(session);
      return;
    }
    session.url = { value: raw, status: 'checking' };
    closeUrlEdit(session);
    pingUrl(raw).then(function (state) {
      if (session.url.value !== raw) return; // stale (user re-edited)
      session.url = { value: raw, status: state };
      renderState(session);
    });
  }

  // ── Render ──────────────────────────────────────────────────
  function renderState(session) {
    var el = session.el;

    // Title row link state — drives underline + link-button glow.
    var hasUrl = session.url.status === 'alive' || session.url.status === 'checking';
    var hasUrlAttempt = !!(session.url.value || '').length;
    el.titleRow.classList.toggle('has-url',     hasUrl);
    el.titleRow.classList.toggle('url-checking', session.url.status === 'checking');
    el.titleRow.classList.toggle('url-bad',     session.url.status === 'dead' || session.url.status === 'invalid');
    el.linkBtn.classList.toggle('is-active',    hasUrl);
    el.linkBtn.classList.toggle('is-bad',       hasUrlAttempt && (session.url.status === 'dead' || session.url.status === 'invalid'));

    // Project chip
    el.projectChips.innerHTML = session.project
      ? '<span class="myahl-pa-project-chip">' +
          svgIcon('project') + ' ' + escHTML(session.project.title) +
          ' <button type="button" class="myahl-pa-project-x" data-remove-project="1" aria-label="Remove project">' + svgIcon('x') + '</button>' +
        '</span>'
      : '';
    el.projectAdd.style.display = session.project ? 'none' : '';

    // Single shared hint — priority-ordered, only one shows at a time.
    var msg = priorityHint(session);
    el.hint.textContent = msg.text;
    el.hint.classList.toggle('is-error', msg.isError);
    el.submit.disabled = !canSubmit(session);
  }

  function canSubmit(session) {
    var el = session.el;
    if (!session.submitter) return false;
    if (!(el.title.value  || '').trim()) return false;
    if (!(el.outlet.value || '').trim()) return false;
    if (!isValidYear((el.year.value || '').trim())) return false;
    if (session.url.status !== 'alive') return false;
    return true;
  }

  // Priority-ordered single-message hint. Highest-importance issue
  // wins; once everything passes, we show no message at all.
  function priorityHint(session) {
    var el = session.el;
    if (!session.submitter)                            return { text: 'Sign in required to submit.', isError: true };
    if (!(el.title.value  || '').trim())               return { text: 'Title is required.', isError: false };
    if (!(el.outlet.value || '').trim())               return { text: 'Outlet is required (e.g. BBC News).', isError: false };
    if (!isValidYear((el.year.value || '').trim()))    return { text: 'Year must be a 4-digit year (1900–2099).', isError: false };
    if (session.url.status === 'idle')                 return { text: 'Add a link via the link button at the right.', isError: false };
    if (session.url.status === 'invalid')              return { text: 'URL must start with http:// or https://', isError: true };
    if (session.url.status === 'checking')             return { text: 'Checking link…', isError: false };
    if (session.url.status === 'dead')                 return { text: 'Link appears dead. Click the link button to fix.', isError: true };
    return { text: '', isError: false };
  }
  function isValidYear(s) {
    if (!/^\d{4}$/.test(s)) return false;
    var n = parseInt(s, 10);
    return n >= 1900 && n <= 2099;
  }

  // ── Project picker (single-select) ──────────────────────────
  function openProjectPicker(session) {
    var card = session.el;
    card.projectPicker.hidden = false;
    card.projectSearch.value = '';
    renderProjectList(session);
    setTimeout(function () { card.projectSearch.focus(); }, 0);
  }
  function closeProjectPicker(session) { session.el.projectPicker.hidden = true; }
  function renderProjectList(session) {
    var card = session.el;
    var q = (card.projectSearch.value || '').trim().toLowerCase();
    var matches = session.projectsIdx.filter(function (p) {
      if (!q) return true;
      return (p.title || '').toLowerCase().indexOf(q) !== -1
          || (p.slug  || '').toLowerCase().indexOf(q) !== -1;
    }).slice(0, 10);
    if (!matches.length) {
      card.projectList.innerHTML = '<li class="myahl-pa-project-empty">No projects match.</li>';
      return;
    }
    card.projectList.innerHTML = matches.map(function (p) {
      return '<li data-slug="' + escAttr(p.slug) + '" data-title="' + escAttr(p.title) + '">' +
        '<span class="myahl-pa-project-li-title">' + escHTML(p.title) + '</span>' +
        (p.year ? '<span class="myahl-pa-project-li-year">' + escHTML(p.year) + '</span>' : '') +
      '</li>';
    }).join('');
  }
  function addProjectFromEl(session, li) {
    session.project = { slug: li.getAttribute('data-slug'), title: li.getAttribute('data-title') };
    closeProjectPicker(session);
    renderState(session);
  }
  function removeProject(session) { session.project = null; renderState(session); }

  // ── Submit ──────────────────────────────────────────────────
  function submit(session) {
    if (!canSubmit(session)) return;
    if (!window.AHLPatch) {
      alert('Submit helper not loaded yet — reload the page.');
      return;
    }
    var el = session.el;
    var patch = {
      title:       (el.title.value  || '').trim(),
      type:        session.type,
      outlet:      (el.outlet.value || '').trim(),
      year:        (el.year.value   || '').trim(),
      url:         session.url.value,
      projectSlug: session.project ? session.project.slug : null
    };

    el.submit.disabled = true;
    el.submit.textContent = 'Submitting…';

    if (window.AHLPendingCache) {
      try {
        window.AHLPendingCache.add({
          targetType: 'press',
          action:     'create',
          targetSlug: '<new>',
          patch:      { title: patch.title, slug: '<new>', type: patch.type }
        });
      } catch (e) { /* quota / privacy */ }
    }

    window.AHLPatch.submit({
      targetType: 'press',
      targetSlug: session.editSlug || '<new>',
      action:     session.editSlug ? 'edit' : 'create',
      patch:      patch,
      returnUrl:  location.origin + (location.pathname.indexOf('/press') === 0 ? '/press/' : '/my-ahl/')
    });
  }

  // ── DOM construction ────────────────────────────────────────
  // Mirror the rendered .press-item layout — icon left, body right.
  // The title row hosts BOTH the title input and the URL input
  // (toggled by a small link button at the right end of the row).
  // Once a URL is added, the title displays with a link-style
  // underline and the link button glows purple to indicate it.
  // The bottom hint shows a single, priority-ordered error.
  function buildCard() {
    var el = document.createElement('div');
    el.className = 'press-add-card is-news';
    el.dataset.pressType = 'news';
    el.innerHTML =
      '<button type="button" class="press-add-icon news" title="Click to change type" aria-label="Press type: news">' +
        svgIcon('news') +
      '</button>' +
      '<div class="press-add-body">' +
        // Title row — title input and URL input share the same slot.
        // .has-url toggles the title's underline; .is-url-editing
        // swaps the input visibility.
        '<div class="press-add-title-row" data-mode="title">' +
          '<input type="text" class="press-add-field press-add-title" placeholder="Headline / title" maxlength="160">' +
          '<input type="url"  class="press-add-field press-add-url"   placeholder="https://… (paste link)">' +
          '<button type="button" class="press-add-link-btn" title="Add / edit link" aria-label="Add link">' +
            svgIcon('link') +
          '</button>' +
        '</div>' +
        // .press-outlet shape: outlet + year, no type tag (icon
        // already conveys type).
        '<div class="press-add-meta">' +
          '<input type="text" class="press-add-field press-add-outlet" placeholder="Outlet" maxlength="80">' +
          '<span aria-hidden="true" class="press-add-dot">·</span>' +
          '<input type="text" class="press-add-field press-add-year"   placeholder="Year"   maxlength="4" inputmode="numeric">' +
        '</div>' +
        // Optional project tag — slim.
        '<div class="press-add-projects-row">' +
          '<span class="myahl-pa-project-zone press-add-project-zone">' +
            '<span class="myahl-pa-project-chips"></span>' +
            '<button type="button" class="myahl-pa-project-add press-add-tag-btn">' +
              svgIcon('project') + ' + Tag project' +
            '</button>' +
            '<div class="myahl-pa-project-picker" hidden>' +
              '<input type="text" class="myahl-pa-project-search" placeholder="Search projects…" autocomplete="off">' +
              '<ul class="myahl-pa-project-list" role="listbox"></ul>' +
            '</div>' +
          '</span>' +
        '</div>' +
        '<div class="press-add-actions">' +
          '<span class="press-add-hint" role="status" aria-live="polite"></span>' +
          '<button type="button" class="press-add-cancel">Cancel</button>' +
          '<button type="button" class="press-add-submit" disabled>Submit for review</button>' +
        '</div>' +
      '</div>';

    return {
      el:             el,
      iconBtn:        el.querySelector('.press-add-icon'),
      iconUse:        el.querySelector('.press-add-icon use'),
      titleRow:       el.querySelector('.press-add-title-row'),
      title:          el.querySelector('.press-add-title'),
      url:            el.querySelector('.press-add-url'),
      linkBtn:        el.querySelector('.press-add-link-btn'),
      outlet:         el.querySelector('.press-add-outlet'),
      year:           el.querySelector('.press-add-year'),
      projectZone:    el.querySelector('.press-add-project-zone'),
      projectChips:   el.querySelector('.myahl-pa-project-chips'),
      projectAdd:     el.querySelector('.myahl-pa-project-add'),
      projectPicker:  el.querySelector('.myahl-pa-project-picker'),
      projectSearch:  el.querySelector('.myahl-pa-project-search'),
      projectList:    el.querySelector('.myahl-pa-project-list'),
      cancel:         el.querySelector('.press-add-cancel'),
      submit:         el.querySelector('.press-add-submit'),
      hint:           el.querySelector('.press-add-hint')
    };
  }

  // ── Helpers ─────────────────────────────────────────────────
  function getSubmitterSlug() {
    var u = window.AHLAuth && window.AHLAuth.getUser && window.AHLAuth.getUser();
    return (u && u.person && u.person.slug) || null;
  }
  function escHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escAttr(s) { return escHTML(s).replace(/"/g, '&quot;'); }
  function debounce(fn, ms) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  function mountAll(scope) {
    var triggers = (scope || document).querySelectorAll('[data-press-add-trigger]');
    Array.prototype.forEach.call(triggers, mount);
    var editTriggers = (scope || document).querySelectorAll('[data-press-add-edit]');
    Array.prototype.forEach.call(editTriggers, mountEdit);
  }
  document.addEventListener('myahl:dashboard-rendered', function () { mountAll(); });
  if (document.readyState !== 'loading') mountAll();
  else document.addEventListener('DOMContentLoaded', function () { mountAll(); });

  // Edit-mode mounter — same fetch + pre-fill pattern as
  // publication-add.js. Press records also carry projects[] (multi)
  // but the form is single-project; we surface the FIRST project as
  // a chip if present.
  function mountEdit(button) {
    if (!button || button.__pressEditMounted) return;
    button.__pressEditMounted = true;
    button.disabled = false;
    ensureSvgDefs();
    button.addEventListener('click', function (e) {
      e.preventDefault();
      var slug = button.getAttribute('data-press-add-edit');
      if (!slug) return;
      openEditCard(button, slug);
    });
  }

  function openEditCard(button, slug) {
    fetch('/data/press/' + encodeURIComponent(slug) + '.json', { cache: 'default' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (record) {
        if (!record) {
          alert('Couldn\'t load this press item for editing.');
          return;
        }
        var firstProject = (Array.isArray(record.projects) && record.projects[0]) || null;
        // Look up the project title for the chip label. If projects-
        // index hasn't loaded yet, fall back to the slug as label —
        // not pretty, but the chip still works.
        loadProjectsIndex().then(function (idx) {
          var title = firstProject;
          if (firstProject && Array.isArray(idx)) {
            var hit = idx.find(function (p) { return p.slug === firstProject; });
            if (hit) title = hit.title;
          }
          openCard(button, {
            editSlug: slug,
            title:    record.title || '',
            type:     record.type || 'news',
            outlet:   record.outlet || '',
            year:     record.year || '',
            url:      record.url || '',
            project:  firstProject ? { slug: firstProject, title: title } : null
          });
        });
      });
  }

  window.AHLPressAdd = { mount: mount, mountEdit: mountEdit };
})();
