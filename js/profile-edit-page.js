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
  function addRolePencil() {
    var el = document.querySelector('.profile-role');
    if (!el) return;
    mountReadMode(el, function () { return roleViewHTML(getCurrentRole()); }, function () {
      enterEditMode('role', el, function () {
        var current = getCurrentRole();
        var input = document.createElement('input');
        input.type = 'text';
        input.maxLength = 80;
        input.value = current;
        input.className = 'pe-inline-input';
        var check = makeCheck('Done', function () { editing && editing.commit(); });
        input.addEventListener('input', function () {
          var v = input.value.trim();
          var orig = String(record.role || '');
          if (v === orig) delete dirty.role;
          else dirty.role = v;
          refreshSubmitBar();
        });
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); editing && editing.commit(); }
        });
        el.innerHTML = '';
        el.appendChild(input);
        el.appendChild(check);
        setTimeout(function () { input.focus(); input.select(); }, 0);
        return function commitRole() {
          var v = input.value.trim();
          el.innerHTML = roleViewHTML(v);
          attachPencil(el, 'Edit role', addRolePencil);
        };
      });
    });
  }
  function getCurrentRole() {
    if ('role' in dirty) return String(dirty.role || '');
    return String(record && record.role || '');
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
    if (!bio) {
      var introGrid = document.querySelector('.profile-intro-grid')
                   || document.querySelector('.profile-body');
      if (!introGrid) return;
      bio = document.createElement('div');
      bio.className = 'profile-content rv vis';
      introGrid.insertBefore(bio, introGrid.firstChild);
      renderBioRead(bio, '');
    } else {
      renderBioRead(bio, getCurrentBio());
    }
    function onPencilClick() {
      enterEditMode('bio', bio, function () {
        var current = getCurrentBio();
        var ta = document.createElement('textarea');
        ta.className = 'pe-inline-textarea';
        ta.value = current;
        ta.rows = Math.min(20, Math.max(8, current.split('\n').length + 4));
        ta.maxLength = 5000;
        var check = makeCheck('Done', function () { editing && editing.commit(); });
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
        bio.appendChild(check);
        setTimeout(function () { ta.focus(); }, 0);
        return function commitBio() {
          var v = ta.value;
          bio.classList.remove('pe-editing');
          renderBioRead(bio, v);
        };
      });
    }
    attachPencil(bio, 'Edit bio', onPencilClick);
    // Stash the click handler so the read-mode pencil that
    // re-attaches after commit can call back into this function.
    bio.__peOnPencil = onPencilClick;
  }
  function getCurrentBio() {
    if ('bio' in dirty) return String(dirty.bio || '');
    return String(record && record.bio || '');
  }
  function renderBioRead(bio, text) {
    bio.innerHTML = '';
    if (!text) {
      var empty = document.createElement('p');
      empty.className = 'pe-empty';
      empty.textContent = '(no bio yet — click the pencil to add one)';
      bio.appendChild(empty);
    } else {
      text.split(/\n\n+/).forEach(function (para) {
        var p = document.createElement('p');
        p.textContent = para;
        bio.appendChild(p);
      });
    }
    var onClick = bio.__peOnPencil || function () {};
    attachPencil(bio, 'Edit bio', onClick);
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
        var check = makeCheck('Done', function () { editing && editing.commit(); });
        card.appendChild(check);

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
          var c = card.querySelector('.pe-check');
          if (c) c.remove();
          attachPencil(card, 'Change featured project', onPencilClick);
        };
      });
    }
    attachPencil(card, 'Change featured project', onPencilClick);
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
    // Lightweight placeholder while we fetch the record.
    slot.innerHTML =
      '<div class="profile-project-card pe-featured-card">' +
        '<div class="profile-project-card-thumb">' +
          '<div class="profile-project-card-placeholder">?</div>' +
        '</div>' +
        '<div class="profile-project-card-body">' +
          '<div class="profile-project-card-title">' + escapeHtml(slug) + '</div>' +
        '</div>' +
      '</div>';
    fetch('https://cdn.ahlab.org/data/projects/' + encodeURIComponent(slug) + '.json',
        { cache: 'default' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (proj) {
        if (!proj) return;
        var thumb = proj.thumbnail
          ? '<img src="' + escapeHtml(proj.thumbnail) + '" alt="' + escapeHtml(proj.title || slug) + '" loading="lazy">'
          : '<div class="profile-project-card-placeholder">' + escapeHtml(String(proj.title || slug).charAt(0)) + '</div>';
        slot.innerHTML =
          '<a class="profile-project-card pe-featured-card" href="/projects/' + escapeHtml(slug) + '/">' +
            '<div class="profile-project-card-thumb">' + thumb + '</div>' +
            '<div class="profile-project-card-body">' +
              '<div class="profile-project-card-title">' + escapeHtml(proj.title || slug) + '</div>' +
              (proj.year ? '<div class="profile-project-card-year">' + escapeHtml(proj.year) + '</div>' : '') +
            '</div>' +
          '</a>';
      })
      .catch(function () { /* keep placeholder */ });
    return slot;
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
        var check = makeCheck('Done', function () { editing && editing.commit(); });
        panel.appendChild(check);
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
