/**
 * profile-edit-page.js — per-field inline editor for the
 * /people/<slug>/edit/ pages.
 *
 * Page model:
 *   Every person has a duplicate of /people/<slug>/index.html
 *   emitted by build-people.js at /people/<slug>/edit/index.html.
 *   It's byte-identical to the public page EXCEPT:
 *     • <body data-edit-mode-page data-person-slug="…">
 *     • noindex meta
 *     • this script loaded at the bottom
 *
 *   Visiting the URL while NOT signed in as the owner → page
 *   shows a small banner ("Sign in as <name> to edit") and the
 *   pencils never appear; the rest of the page renders as the
 *   public read-only profile. So the URL is shareable without
 *   leaking edit affordances.
 *
 * Per-field model:
 *   Each editable field gets its own pencil button injected via
 *   JS. Clicking a pencil swaps the field's rendered DOM for an
 *   input (or textarea / select / mini-form) pre-populated from
 *   the canonical /data/people/<slug>.json record. Multiple
 *   pencils can be open simultaneously. Each input remembers
 *   data-original; the sticky submit bar at the bottom only
 *   appears when ≥1 field is dirty.
 *
 * Fields wired:
 *   profile_image       (photo overlay pencil → file picker)
 *   role                (next to .profile-role)
 *   bio                 (top-right of .profile-content)
 *   featured_project    (top-right of .profile-featured)
 *   linkedin / github / google_scholar
 *                       (single "Edit social links" pencil at end
 *                        of .profile-socials → mini-panel with the
 *                        three URL inputs)
 *   external_links      (separate pencil near the socials → list
 *                        editor with repeatable {label, url} rows)
 *
 * Submit:
 *   On Submit, collects every dirty field, runs the photo through
 *   AHLImage.process (greyscale policy for profile photos), and
 *   calls window.AHLPatch.submit({targetType: 'profile', ...}).
 *   The broker validates + queues for moderator review; the
 *   moderator email renders the diff (email.js renderEmailProfileCard_).
 */
(function () {
  'use strict';

  var body = document.body;
  if (!body.hasAttribute('data-edit-mode-page')) return;  // wrong page

  var pageSlug = body.getAttribute('data-person-slug') || '';
  var record   = null;     // canonical record from cdn
  var dirty    = {};       // map: field name → current value (or File)
  var pencils  = {};       // map: field name → injected pencil button

  // ── Auth gate ───────────────────────────────────────────────
  // Wait for AHLAuth to attach + report the user. The auth.js
  // script's onChange fires immediately with current state on
  // subscribe, then on every login/logout change.
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

  // ── Owner mode: fetch record, mount pencils, show submit bar ──
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
    // CDN serves with permissive CORS; the site domain doesn't
    // have per-record files in dist/.
    return fetch('https://cdn.ahlab.org/data/people/' + encodeURIComponent(slug) + '.json',
        { cache: 'default' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  // ── Pencil injection per field ──────────────────────────────
  function injectPencils() {
    addPhotoPencil();
    addRolePencil();
    addBioPencil();
    addFeaturedProjectPencil();
    addSocialsPencil();
    addExternalLinksPencil();
  }

  function pencilSVG() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>' +
      '</svg>';
  }
  function makePencil(label, onClick) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pe-pencil';
    btn.setAttribute('aria-label', label);
    btn.title = label;
    btn.innerHTML = pencilSVG();
    btn.addEventListener('click', onClick);
    return btn;
  }

  // ── Photo ───────────────────────────────────────────────────
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
      reader.onload = function () {
        // Preview immediately so the user can confirm the right
        // file. The actual greyscale processing happens at submit
        // time via AHLImage.process so we don't burn CPU on every
        // pick.
        if (img) img.src = reader.result;
      };
      reader.readAsDataURL(f);
      dirty.profile_image = f;
      refreshSubmitBar();
    });
    wrap.appendChild(input);
    var btn = makePencil('Change photo', function () { input.click(); });
    btn.classList.add('pe-pencil-photo');
    wrap.appendChild(btn);
    wrap.classList.add('pe-has-pencil');
    pencils.profile_image = btn;
  }

  // ── Role ────────────────────────────────────────────────────
  function addRolePencil() {
    var el = document.querySelector('.profile-role');
    if (!el) return;
    var original = (el.textContent || '').trim();
    var btn = makePencil('Edit role', function () {
      if (el.querySelector('input')) return;  // already in edit mode
      var input = document.createElement('input');
      input.type = 'text';
      input.value = original;
      input.maxLength = 80;
      input.className = 'pe-inline-input';
      input.addEventListener('input', function () {
        var v = input.value.trim();
        if (v === original) delete dirty.role; else dirty.role = v;
        refreshSubmitBar();
      });
      input.addEventListener('blur', function () {
        // Collapse back to text view if value unchanged. Keep
        // input visible when dirty so the user can adjust until
        // they submit.
        if (input.value.trim() === original) collapseRole();
      });
      function collapseRole() {
        el.innerHTML = '';
        el.textContent = original;
        el.appendChild(btn);
      }
      el.innerHTML = '';
      el.appendChild(input);
      el.appendChild(btn);
      input.focus();
      input.select();
    });
    el.appendChild(btn);
    pencils.role = btn;
  }

  // ── Bio ─────────────────────────────────────────────────────
  function addBioPencil() {
    var bio = document.querySelector('.profile-content');
    if (!bio) {
      // No existing bio: inject a placeholder block so the user
      // has something to click "edit" on.
      var introGrid = document.querySelector('.profile-intro-grid')
                   || document.querySelector('.profile-body');
      if (!introGrid) return;
      bio = document.createElement('div');
      bio.className = 'profile-content rv vis';
      bio.innerHTML = '<p class="pe-empty">(no bio yet — click the pencil to add one)</p>';
      introGrid.insertBefore(bio, introGrid.firstChild);
    }
    var btn = makePencil('Edit bio', function () {
      if (bio.querySelector('textarea')) return;
      var current = String(record.bio || '').trim();
      var ta = document.createElement('textarea');
      ta.className = 'pe-inline-textarea';
      ta.value = current;
      ta.rows = Math.min(20, Math.max(6, current.split('\n').length + 4));
      ta.maxLength = 3000;
      ta.addEventListener('input', function () {
        var v = ta.value;
        if (v === current) delete dirty.bio; else dirty.bio = v;
        refreshSubmitBar();
      });
      bio.classList.add('pe-editing');
      bio.innerHTML = '';
      bio.appendChild(ta);
      bio.appendChild(btn);
      ta.focus();
    });
    bio.appendChild(btn);
    pencils.bio = btn;
  }

  // ── Featured project ────────────────────────────────────────
  function addFeaturedProjectPencil() {
    var card = document.querySelector('.profile-featured');
    if (!card) {
      // No featured project: inject a stub aside so the user can
      // pick one from scratch.
      var introGrid = document.querySelector('.profile-intro-grid')
                   || document.querySelector('.profile-body');
      if (!introGrid) return;
      card = document.createElement('aside');
      card.className = 'profile-featured rv vis';
      card.setAttribute('aria-label', 'Featured project');
      card.innerHTML = '<div class="sidebar-section-title">Featured project</div>' +
        '<div class="pe-empty">(none yet — click the pencil to pick)</div>';
      introGrid.appendChild(card);
    }
    var btn = makePencil('Change featured project', function () {
      if (card.querySelector('select')) return;
      loadProjectsIndex().then(function (projects) {
        var current = record.featured_project || '';
        var sel = document.createElement('select');
        sel.className = 'pe-inline-select';
        var opt0 = document.createElement('option');
        opt0.value = '';
        opt0.textContent = '(no featured project)';
        sel.appendChild(opt0);
        var sorted = projects.slice().sort(function (a, b) {
          var ta = (a.title || '').toLowerCase();
          var tb = (b.title || '').toLowerCase();
          return ta < tb ? -1 : ta > tb ? 1 : 0;
        });
        sorted.forEach(function (p) {
          var o = document.createElement('option');
          o.value = p.slug;
          o.textContent = p.title + (p.year ? ' (' + p.year + ')' : '');
          sel.appendChild(o);
        });
        sel.value = current;
        sel.addEventListener('change', function () {
          var v = sel.value;
          if (v === current) delete dirty.featured_project;
          else dirty.featured_project = v;
          refreshSubmitBar();
        });
        // Keep the title label visible so the user knows what
        // this control changes.
        var title = card.querySelector('.sidebar-section-title');
        card.innerHTML = '';
        if (title) card.appendChild(title);
        card.appendChild(sel);
        card.appendChild(btn);
        sel.focus();
      });
    });
    card.appendChild(btn);
    pencils.featured_project = btn;
  }

  // ── Social links: one pencil → mini-panel with 3 URL inputs ─
  function addSocialsPencil() {
    var row = document.querySelector('.profile-socials');
    if (!row) return;
    var btn = makePencil('Edit social links', function () {
      if (document.querySelector('.pe-social-panel')) return;
      var panel = document.createElement('div');
      panel.className = 'pe-social-panel';
      panel.innerHTML =
        '<div class="pe-panel-title">Social links</div>' +
        renderUrlInput('linkedin', 'LinkedIn', record.linkedin) +
        renderUrlInput('github',   'GitHub',   record.github) +
        renderUrlInput('google_scholar', 'Google Scholar', record.google_scholar) +
        '<button type="button" class="pe-panel-close">Done</button>';
      Array.prototype.forEach.call(panel.querySelectorAll('input'), function (input) {
        var name = input.getAttribute('data-field');
        var original = String(record[name] || '');
        input.addEventListener('input', function () {
          var v = input.value.trim();
          if (v === original) delete dirty[name];
          else dirty[name] = v;
          refreshSubmitBar();
        });
      });
      panel.querySelector('.pe-panel-close').addEventListener('click', function () {
        panel.remove();
      });
      row.parentNode.insertBefore(panel, row.nextSibling);
      var first = panel.querySelector('input');
      if (first) first.focus();
    });
    row.appendChild(btn);
    pencils.socials = btn;
  }
  function renderUrlInput(name, label, value) {
    var v = value == null ? '' : String(value);
    return '<label class="pe-panel-row">' +
      '<span class="pe-panel-label">' + escapeHtml(label) + '</span>' +
      '<input type="url" data-field="' + escapeHtml(name) + '" value="' + escapeHtml(v) + '" ' +
      'placeholder="https://…" inputmode="url">' +
    '</label>';
  }

  // ── External links: pencil → repeatable {label, url} rows ───
  function addExternalLinksPencil() {
    // We attach this pencil next to the social row so users find
    // it. If the social row doesn't exist (older page) we attach
    // it inside the profile-info block instead.
    var anchor = document.querySelector('.profile-socials')
              || document.querySelector('.profile-info');
    if (!anchor) return;
    var btn = makePencil('Edit other external links', function () {
      if (document.querySelector('.pe-extlinks-panel')) return;
      var panel = document.createElement('div');
      panel.className = 'pe-extlinks-panel';
      var rowsHtml = (Array.isArray(record.external_links) ? record.external_links : [])
        .map(extlinkRowHtml).join('');
      panel.innerHTML =
        '<div class="pe-panel-title">Other external links</div>' +
        '<div class="pe-extlinks-rows">' + rowsHtml + '</div>' +
        '<button type="button" class="pe-extlinks-add">+ Add link</button>' +
        '<button type="button" class="pe-panel-close">Done</button>';
      var rowsWrap = panel.querySelector('.pe-extlinks-rows');
      var originalSerialized = serializeExtlinkRows(rowsWrap);

      function onRowChange() {
        if (serializeExtlinkRows(rowsWrap) === originalSerialized) {
          delete dirty.external_links;
        } else {
          dirty.external_links = collectExtlinkRows(rowsWrap);
        }
        refreshSubmitBar();
      }
      panel.querySelector('.pe-extlinks-add').addEventListener('click', function () {
        var div = document.createElement('div');
        div.innerHTML = extlinkRowHtml({ label: '', url: '' });
        var row = div.firstChild;
        rowsWrap.appendChild(row);
        wireExtlinkRow(row, onRowChange);
        row.querySelector('input').focus();
      });
      panel.querySelector('.pe-panel-close').addEventListener('click', function () {
        panel.remove();
      });
      Array.prototype.forEach.call(rowsWrap.children, function (row) {
        wireExtlinkRow(row, onRowChange);
      });
      anchor.parentNode.insertBefore(panel, anchor.nextSibling);
    });
    // Render as a small text-button next to the icon socials so
    // it's discoverable. (The other pencil on the socials row
    // edits the three "platform" icons.)
    btn.classList.add('pe-pencil-text');
    btn.title = 'Edit other external links';
    btn.innerHTML = pencilSVG() + '<span>Other links</span>';
    anchor.appendChild(btn);
    pencils.external_links = btn;
  }
  function extlinkRowHtml(l) {
    var label = escapeHtml(l && l.label || '');
    var url   = escapeHtml(l && l.url   || '');
    return '<div class="pe-extlink-row" data-extlink-row>' +
      '<input type="text" class="pe-extlink-label" placeholder="Label" value="' + label + '">' +
      '<input type="url"  class="pe-extlink-url"   placeholder="https://…" value="' + url + '" inputmode="url">' +
      '<button type="button" class="pe-extlink-remove" aria-label="Remove">×</button>' +
    '</div>';
  }
  function wireExtlinkRow(row, onChange) {
    row.querySelector('.pe-extlink-label').addEventListener('input', onChange);
    row.querySelector('.pe-extlink-url').addEventListener('input', onChange);
    row.querySelector('.pe-extlink-remove').addEventListener('click', function () {
      row.parentNode.removeChild(row);
      onChange();
    });
  }
  function collectExtlinkRows(wrap) {
    var rows = wrap.querySelectorAll('[data-extlink-row]');
    var out = [];
    Array.prototype.forEach.call(rows, function (row) {
      var label = (row.querySelector('.pe-extlink-label').value || '').trim();
      var url   = (row.querySelector('.pe-extlink-url').value || '').trim();
      if (!url) return;
      out.push({ label: label || url, url: url });
    });
    return out;
  }
  function serializeExtlinkRows(wrap) {
    return collectExtlinkRows(wrap)
      .map(function (l) { return l.label + '|' + l.url; })
      .join('\n');
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
      // Brutal but simple: reload the page → all edits gone.
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
        // Photo: process through AHLImage (greyscale for profile)
        // before adding to the files[] array.
        fileWork.push(
          window.AHLImage.process(dirty[k], { greyscale: true })
            .then(function (processed) { return processed; })
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
      // submit-patch.js navigates the tab away to the broker;
      // we won't reach any code after this call.
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
