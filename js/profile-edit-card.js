/**
 * profile-edit-card.js — inline expand-in-place editor for the
 * signed-in user's own profile on /my-ahl/.
 *
 * Wiring:
 *   Auto-mounts a click handler on every [data-profile-edit-trigger]
 *   button on DOMContentLoaded and on `myahl:dashboard-rendered` (the
 *   dashboard re-renders dynamically when auth state changes). Click
 *   swaps the closest [data-profile-edit-wrap] ancestor for an
 *   editable card; Cancel restores the original element.
 *
 *   The card is a regular form-ish <div> with [data-myahl-submit=
 *   "profile-edit"], so the existing myahl-forms.js delegation
 *   picks up the submit and routes through AHLPatch. The only
 *   profile-specific concern in myahl-forms.js is the finalize
 *   hook on the `profile-edit` SPEC (defined there) which
 *   collects external_links[] rows and prunes any field whose
 *   current value matches its data-original attribute (so a
 *   submission only contains fields the user actually touched).
 *
 * Pre-fill source:
 *   /data/people/<slug>.json — fetched on first card open. The
 *   user-dashboard JSON we already load on /my-ahl/ doesn't carry
 *   bio / links / featured_project (it's a slim view), so we go
 *   one level deeper to the canonical record. Cached for the
 *   lifetime of the page.
 *
 * Patch payload (consumed by submit.js validateProfilePatch_):
 *   { bio, role, profile_image, linkedin, github, google_scholar,
 *     external_links: [{label, url}], featured_project }
 *
 * Notes:
 *   • profile_image upload uses data-image-policy="profile" which
 *     triggers AHLImage.process's greyscale pipeline (matches the
 *     visual treatment on the public team page).
 *   • featured_project is rendered as a <select> populated from
 *     /data/projects-index.json so users can only pick an existing
 *     project slug. Empty option means "no featured project".
 *   • All scalar inputs stamp data-original=<initial value> at
 *     pre-fill time. The myahl-forms.js finalize hook for
 *     profile-edit reads it and drops unchanged fields from the
 *     payload — prevents a save from overwriting a field that
 *     another admin updated between the user opening the card and
 *     submitting it.
 */
(function () {
  'use strict';

  // People records live in cdn-ahlab-org, not in the site dist.
  // They serve from cdn.ahlab.org with permissive CORS, so a
  // cross-origin fetch works fine from ahlab.org and from
  // localhost. The site domain (ahlab.org/data/people/…) is a
  // 404 — the build doesn't copy per-record JSON into dist.
  var PEOPLE_BASE_URL = 'https://cdn.ahlab.org/data/people/';
  var PROJECTS_INDEX_URL = '/data/projects-index.json';

  // Projects index is fetched once per page and used to populate
  // the featured_project select.
  var projectsPromise = null;
  function loadProjectsIndex() {
    if (projectsPromise) return projectsPromise;
    projectsPromise = fetch(PROJECTS_INDEX_URL, { cache: 'default' })
      .then(function (r) { return r.ok ? r.json() : []; })
      .catch(function () { return []; });
    return projectsPromise;
  }

  // People record fetch — one per page lifetime per slug.
  var peoplePromiseBySlug = Object.create(null);
  function loadPersonRecord(slug) {
    if (peoplePromiseBySlug[slug]) return peoplePromiseBySlug[slug];
    peoplePromiseBySlug[slug] = fetch(PEOPLE_BASE_URL + encodeURIComponent(slug) + '.json',
        { cache: 'default' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
    return peoplePromiseBySlug[slug];
  }

  // ── Auto-mount ──────────────────────────────────────────────
  function mountAll(scope) {
    var btns = (scope || document).querySelectorAll('[data-profile-edit-trigger]');
    Array.prototype.forEach.call(btns, function (btn) {
      if (btn.__profileEditMounted) return;
      btn.__profileEditMounted = true;
      btn.disabled = false;
      btn.removeAttribute('title');
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        openCard(btn);
      });
    });
  }
  document.addEventListener('myahl:dashboard-rendered', function () { mountAll(); });
  if (document.readyState !== 'loading') mountAll();
  else document.addEventListener('DOMContentLoaded', function () { mountAll(); });

  // ── Card lifecycle ──────────────────────────────────────────
  function openCard(button) {
    var user = window.AHLAuth && window.AHLAuth.getUser();
    if (!user || !user.email) {
      alert('Sign in required.');
      return;
    }
    // The card replaces the closest profile-tile wrapper if one
    // exists; otherwise it sits next to the button.
    var wrap = button.closest('[data-profile-edit-wrap]') || button.parentElement;
    if (!wrap) return;

    var card = buildCard();
    wrap.replaceWith(card.el);

    card.cancel.addEventListener('click', function () { card.el.replaceWith(wrap); });

    // Pre-fill: 1) projects index for the featured_project select,
    // 2) the person record for everything else.
    loadProjectsIndex().then(function (projects) {
      populateFeaturedProjectOptions(card, Array.isArray(projects) ? projects : []);
    });

    var slug = user.person && user.person.slug;
    if (slug) {
      loadPersonRecord(slug).then(function (rec) {
        prefillCardFromRecord(card, rec || {});
      });
    }

    // Dynamic external_links row management.
    wireExternalLinkRows(card);
  }

  // ── DOM construction ────────────────────────────────────────
  function buildCard() {
    var el = document.createElement('div');
    el.className = 'profile-edit-card';
    el.setAttribute('data-myahl-submit', 'profile-edit');
    el.setAttribute('data-myahl-add-form', '');
    el.innerHTML =
      '<div class="profile-edit-header">' +
        '<h2>Edit profile</h2>' +
        '<p class="profile-edit-sub">Changes go to a moderator for review. ' +
          'Fields you leave unchanged won\'t be re-saved.</p>' +
      '</div>' +
      '<div class="profile-edit-grid">' +
        '<label class="profile-edit-field profile-edit-photo-field">' +
          '<span class="profile-edit-label">Photo</span>' +
          '<input type="file" accept="image/*" data-field="profile_image" data-image-policy="profile">' +
          '<span class="profile-edit-hint">JPEG, PNG, or WebP. Auto-converted to greyscale.</span>' +
        '</label>' +
        '<label class="profile-edit-field profile-edit-bio-field">' +
          '<span class="profile-edit-label">Bio</span>' +
          '<textarea data-field="bio" rows="6" maxlength="3000" placeholder="A few sentences about your work, interests, and background."></textarea>' +
        '</label>' +
        '<label class="profile-edit-field">' +
          '<span class="profile-edit-label">Role</span>' +
          '<input type="text" data-field="role" maxlength="80" placeholder="e.g. Research Engineer, PhD Candidate">' +
        '</label>' +
        '<label class="profile-edit-field">' +
          '<span class="profile-edit-label">Featured project</span>' +
          '<select data-field="featured_project">' +
            '<option value="">(none)</option>' +
          '</select>' +
          '<span class="profile-edit-hint">Highlighted on your public profile.</span>' +
        '</label>' +
        '<label class="profile-edit-field">' +
          '<span class="profile-edit-label">LinkedIn</span>' +
          '<input type="url" data-field="linkedin" inputmode="url" placeholder="https://linkedin.com/in/your-handle">' +
        '</label>' +
        '<label class="profile-edit-field">' +
          '<span class="profile-edit-label">GitHub</span>' +
          '<input type="url" data-field="github" inputmode="url" placeholder="https://github.com/your-handle">' +
        '</label>' +
        '<label class="profile-edit-field">' +
          '<span class="profile-edit-label">Google Scholar</span>' +
          '<input type="url" data-field="google_scholar" inputmode="url" placeholder="https://scholar.google.com/citations?user=…">' +
        '</label>' +
        '<div class="profile-edit-field profile-edit-links-field">' +
          '<span class="profile-edit-label">External links</span>' +
          '<div class="profile-edit-links-rows"></div>' +
          '<button type="button" class="profile-edit-link-add">+ Add link</button>' +
          '<span class="profile-edit-hint">Personal site, lab page, anything else.</span>' +
        '</div>' +
      '</div>' +
      '<div class="profile-edit-actions">' +
        '<button type="button" class="profile-edit-cancel">Cancel</button>' +
        '<button type="button" class="profile-edit-submit" data-myahl-submit-trigger>Submit for review</button>' +
      '</div>';

    return {
      el:               el,
      bio:              el.querySelector('[data-field="bio"]'),
      role:             el.querySelector('[data-field="role"]'),
      photo:            el.querySelector('[data-field="profile_image"]'),
      linkedin:         el.querySelector('[data-field="linkedin"]'),
      github:           el.querySelector('[data-field="github"]'),
      scholar:          el.querySelector('[data-field="google_scholar"]'),
      featured:         el.querySelector('[data-field="featured_project"]'),
      linksRows:        el.querySelector('.profile-edit-links-rows'),
      linkAddBtn:       el.querySelector('.profile-edit-link-add'),
      cancel:           el.querySelector('.profile-edit-cancel'),
      submit:           el.querySelector('.profile-edit-submit')
    };
  }

  // Populate the featured_project select. Sorted alphabetically by
  // title for predictability; current selection gets pre-selected
  // in prefillCardFromRecord once it lands.
  function populateFeaturedProjectOptions(card, projects) {
    if (!card.featured) return;
    var existing = card.featured.value;
    var sorted = projects.slice().sort(function (a, b) {
      var ta = (a.title || '').toLowerCase();
      var tb = (b.title || '').toLowerCase();
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
    sorted.forEach(function (p) {
      var opt = document.createElement('option');
      opt.value = p.slug;
      opt.textContent = p.title + (p.year ? ' (' + p.year + ')' : '');
      card.featured.appendChild(opt);
    });
    if (existing) card.featured.value = existing;
  }

  // ── Pre-fill ────────────────────────────────────────────────
  // Stamp every input with data-original so the finalize hook
  // in myahl-forms.js can drop fields the user didn't touch.
  function prefillCardFromRecord(card, rec) {
    setField(card.bio,      rec.bio);
    setField(card.role,     rec.role);
    setField(card.linkedin, rec.linkedin);
    setField(card.github,   rec.github);
    setField(card.scholar,  rec.google_scholar);
    setField(card.featured, rec.featured_project || '');

    // External links pre-fill — rec.external_links is [{label, url}].
    (Array.isArray(rec.external_links) ? rec.external_links : []).forEach(function (l) {
      appendLinkRow(card, l && l.label, l && l.url);
    });
    // Stamp the rows' baseline so finalize can detect adds/removes.
    snapshotLinkRows(card);
  }

  function setField(el, value) {
    if (!el) return;
    var v = value == null ? '' : String(value);
    el.value = v;
    el.dataset.original = v;
  }

  // ── External links row management ───────────────────────────
  // Each row is a flex pair: label + url input + remove ×. The
  // finalize hook in myahl-forms.js iterates [data-external-link]
  // rows and collects { label, url } where url is non-empty.
  function wireExternalLinkRows(card) {
    card.linkAddBtn.addEventListener('click', function () {
      appendLinkRow(card, '', '');
    });
  }
  function appendLinkRow(card, label, url) {
    var row = document.createElement('div');
    row.className = 'profile-edit-link-row';
    row.setAttribute('data-external-link', '');
    row.innerHTML =
      '<input type="text" class="profile-edit-link-label" placeholder="Label (e.g. Personal site)" data-link-label>' +
      '<input type="url"  class="profile-edit-link-url"   placeholder="https://example.com" data-link-url>' +
      '<button type="button" class="profile-edit-link-remove" aria-label="Remove">×</button>';
    var labelEl = row.querySelector('[data-link-label]');
    var urlEl   = row.querySelector('[data-link-url]');
    if (label) labelEl.value = label;
    if (url)   urlEl.value   = url;
    row.querySelector('.profile-edit-link-remove').addEventListener('click', function () {
      row.parentNode.removeChild(row);
    });
    card.linksRows.appendChild(row);
  }
  // Stamp the initial set of rows so finalize can detect whether
  // anything changed. We serialize all rows to a single string on
  // the wrap element; finalize re-serializes and compares.
  function snapshotLinkRows(card) {
    if (!card.linksRows) return;
    card.linksRows.dataset.original = serializeLinkRows(card.linksRows);
  }
  function serializeLinkRows(linksRows) {
    var rows = linksRows.querySelectorAll('[data-external-link]');
    var out = [];
    Array.prototype.forEach.call(rows, function (row) {
      var label = (row.querySelector('[data-link-label]') || {}).value || '';
      var url   = (row.querySelector('[data-link-url]')   || {}).value || '';
      out.push((label || '').trim() + '|' + (url || '').trim());
    });
    return out.join('\n');
  }
  // Exposed so myahl-forms.js's finalize hook can compare.
  window.AHLProfileEditCard = {
    serializeLinkRows: serializeLinkRows
  };
})();
