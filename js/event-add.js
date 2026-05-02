/**
 * event-add.js — reusable inline form for adding an event (e.g.
 * "CHI 2026 in Barcelona"). Only used on /my-ahl/ for now (no
 * dedicated /events/ page yet).
 *
 * Wiring:
 *   Auto-mounts on every [data-event-add-trigger] button. Click
 *   swaps the trigger (or its [data-event-add-wrap] ancestor) for
 *   an editable card; Cancel restores the original.
 *
 *   Pages must:
 *     • load /js/event-add.js (defer)
 *     • load /css/forms-add.css
 *     • render a button with [data-event-add-trigger]
 *
 * Patch payload (intended for a future submit.js validateEventPatch_):
 *   {
 *     title, starts (YYYY-MM-DD), ends (YYYY-MM-DD or ''),
 *     location, url (optional), summary
 *   }
 *
 * URL validation: same pattern as press-add — format check + best-
 * effort liveness ping. URL is optional for events; if present, it
 * must be alive (or "checking" still OK) at submit time.
 */
(function () {
  'use strict';

  var URL_DEBOUNCE_MS = 600;

  function ensureSvgDefs() {
    if (document.getElementById('i-myahl-link')) return;
    var defs = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    defs.setAttribute('aria-hidden', 'true');
    defs.style.display = 'none';
    defs.innerHTML = SVG_DEFS;
    document.body.insertBefore(defs, document.body.firstChild);
  }
  // Mirrors my-ahl.html static defs. Only the symbols this form
  // actually references — keeps the inline payload small.
  var SVG_DEFS =
    '<symbol id="i-myahl-link" viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 1 0-7.07-7.07l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 1 0 7.07 7.07l1.5-1.5"/></symbol>' +
    '<symbol id="i-myahl-x" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></symbol>' +
    '<symbol id="i-myahl-event" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></symbol>';

  function svgIcon(name) {
    return '<svg class="myahl-pa-icon" aria-hidden="true"><use href="#i-myahl-' + name + '"/></svg>';
  }

  function isValidUrlShape(s) {
    if (!s) return false;
    try {
      var u = new URL(s);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch (e) { return false; }
  }
  function pingUrl(url) {
    if (!isValidUrlShape(url)) return Promise.resolve('unknown');
    return fetch(url, { method: 'GET', mode: 'no-cors', cache: 'no-store' })
      .then(function () { return 'alive'; })
      .catch(function () { return 'dead'; });
  }

  // ── Public API ──────────────────────────────────────────────
  function mount(button) {
    if (!button || button.__eventAddMounted) return;
    button.__eventAddMounted = true;
    button.disabled = false;
    button.removeAttribute('title');
    ensureSvgDefs();
    button.addEventListener('click', function (e) {
      e.preventDefault();
      openCard(button);
    });
  }

  // `prefill` (optional) supports EDIT mode — pre-populate fields
  // from an existing event record, stamp `editSlug` so submit sends
  // action='edit'.
  function openCard(button, prefill) {
    var originalEl =
      button.closest('[data-event-add-wrap]') ||
      button.closest('li') ||
      button;
    var card = buildCard();
    if (prefill && prefill.editSlug) card.el.classList.add('is-edit-mode');
    originalEl.replaceWith(card.el);

    if (prefill) {
      if (prefill.title)    card.title.value    = prefill.title;
      if (prefill.starts)   card.starts.value   = prefill.starts;
      if (prefill.ends)     card.ends.value     = prefill.ends;
      if (prefill.location) card.location.value = prefill.location;
      if (prefill.summary)  card.summary.value  = prefill.summary;
    }

    var session = {
      el:        card,
      submitter: getSubmitterSlug(),
      // Pre-seed URL "alive" — accepted at original submission time.
      url:       (prefill && prefill.url)
        ? { value: prefill.url, status: 'alive' }
        : { value: '', status: 'idle' },
      editSlug:  prefill && prefill.editSlug ? prefill.editSlug : null
    };
    if (session.editSlug) {
      card.submit.textContent = 'Submit edit for review';
    }

    card.title.addEventListener('input',    function () { renderState(session); });
    card.starts.addEventListener('input',   function () { renderState(session); });
    card.ends.addEventListener('input',     function () { renderState(session); });
    card.location.addEventListener('input', function () { renderState(session); });
    card.summary.addEventListener('input',  function () { renderState(session); });
    card.cancel.addEventListener('click',   function () { card.el.replaceWith(originalEl); });
    card.submit.addEventListener('click',   function () { submit(session); });

    // Link button: toggles title↔url mode in the same slot.
    card.linkBtn.addEventListener('click', function () {
      if (card.titleRow.dataset.mode === 'url') closeUrlEdit(session);
      else openUrlEdit(session);
    });
    card.url.addEventListener('keydown', function (e) {
      if (e.key === 'Enter')      { e.preventDefault(); commitUrl(session); }
      else if (e.key === 'Escape'){ e.preventDefault(); closeUrlEdit(session); }
    });
    card.url.addEventListener('blur', function () {
      if (card.titleRow.dataset.mode === 'url') commitUrl(session);
    });

    setTimeout(function () { card.title.focus(); }, 0);
    renderState(session);
  }

  // ── URL inline-edit (shared title slot, link-button toggle) ─
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
      session.url = { value: raw, status: 'invalid' };
      renderState(session);
      return;
    }
    session.url = { value: raw, status: 'checking' };
    closeUrlEdit(session);
    pingUrl(raw).then(function (state) {
      if (session.url.value !== raw) return;
      session.url = { value: raw, status: state };
      renderState(session);
    });
  }

  // ── Render ──────────────────────────────────────────────────
  function renderState(session) {
    var el = session.el;
    var hasUrl = session.url.status === 'alive' || session.url.status === 'checking';
    var hasUrlAttempt = !!(session.url.value || '').length;
    el.titleRow.classList.toggle('has-url',     hasUrl);
    el.titleRow.classList.toggle('url-bad',     session.url.status === 'dead' || session.url.status === 'invalid');
    el.linkBtn.classList.toggle('is-active',    hasUrl);
    el.linkBtn.classList.toggle('is-bad',       hasUrlAttempt && (session.url.status === 'dead' || session.url.status === 'invalid'));

    var msg = priorityHint(session);
    el.hint.textContent = msg.text;
    el.hint.classList.toggle('is-error', msg.isError);
    el.submit.disabled = !canSubmit(session);
  }

  function canSubmit(session) {
    var el = session.el;
    if (!session.submitter) return false;
    if (!(el.title.value || '').trim())      return false;
    if (!isValidDate(el.starts.value))        return false;
    var endsRaw = (el.ends.value || '').trim();
    if (endsRaw && !isValidDate(endsRaw))     return false;
    if (endsRaw && el.starts.value > endsRaw) return false;
    if (!(el.location.value || '').trim())    return false;
    var us = session.url.status;
    if ((el.url.value || '').trim() && (us === 'invalid' || us === 'dead' || us === 'checking')) return false;
    return true;
  }
  function priorityHint(session) {
    var el = session.el;
    if (!session.submitter)                   return { text: 'Sign in required to submit.', isError: true };
    if (!(el.title.value || '').trim())       return { text: 'Event name is required.', isError: false };
    if (!isValidDate(el.starts.value))        return { text: 'Start date is required.', isError: false };
    var endsRaw = (el.ends.value || '').trim();
    if (endsRaw && !isValidDate(endsRaw))     return { text: 'End date is invalid.', isError: true };
    if (endsRaw && el.starts.value > endsRaw) return { text: 'End date must be on or after the start date.', isError: true };
    if (!(el.location.value || '').trim())    return { text: 'Location is required.', isError: false };
    var us = session.url.status;
    if (us === 'invalid')  return { text: 'URL must start with http:// or https://', isError: true };
    if (us === 'checking') return { text: 'Checking link…', isError: false };
    if (us === 'dead')     return { text: 'Link appears dead. Click the link button to fix.', isError: true };
    return { text: '', isError: false };
  }
  function isValidDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '').trim()); }

  // ── Submit ──────────────────────────────────────────────────
  function submit(session) {
    if (!canSubmit(session)) return;
    if (!window.AHLPatch) {
      alert('Submit helper not loaded yet — reload the page.');
      return;
    }
    var el = session.el;
    var patch = {
      title:    (el.title.value    || '').trim(),
      starts:   el.starts.value,
      ends:     (el.ends.value     || '').trim() || null,
      location: (el.location.value || '').trim(),
      url:      (el.url.value      || '').trim() || null,
      summary:  (el.summary.value  || '').trim()
    };

    el.submit.disabled = true;
    el.submit.textContent = 'Submitting…';

    if (window.AHLPendingCache) {
      try {
        window.AHLPendingCache.add({
          targetType: 'event',
          action:     'create',
          targetSlug: '<new>',
          patch:      { title: patch.title, slug: '<new>' }
        });
      } catch (e) { /* quota / privacy */ }
    }

    window.AHLPatch.submit({
      targetType: 'event',
      targetSlug: session.editSlug || '<new>',
      action:     session.editSlug ? 'edit' : 'create',
      patch:      patch,
      returnUrl:  location.origin + '/my-ahl/'
    });
  }

  // ── DOM construction ────────────────────────────────────────
  // Same minimalist pattern as press-add: icon left, body right,
  // title + URL share a slot (toggled by the link button), and a
  // single bottom hint shows the highest-priority issue.
  function buildCard() {
    var el = document.createElement('div');
    el.className = 'press-add-card event-add-card';
    el.innerHTML =
      '<div class="press-add-icon event-add-icon" aria-hidden="true">' + svgIcon('event') + '</div>' +
      '<div class="press-add-body">' +
        // Title row — title input ↔ URL input (toggled by link btn).
        '<div class="press-add-title-row" data-mode="title">' +
          '<input type="text" class="press-add-field press-add-title event-add-title" placeholder="Event name (e.g. CHI 2026)" maxlength="160">' +
          '<input type="url"  class="press-add-field press-add-url   event-add-url"   placeholder="https://… (optional event URL)">' +
          '<button type="button" class="press-add-link-btn" title="Add / edit event URL" aria-label="Add link">' +
            svgIcon('link') +
          '</button>' +
        '</div>' +
        // Meta — date range + location, all inline in the same .press-add-meta row.
        '<div class="press-add-meta event-add-meta">' +
          '<input type="date" class="event-add-date event-add-starts" aria-label="Start date">' +
          '<span aria-hidden="true" class="press-add-dot">→</span>' +
          '<input type="date" class="event-add-date event-add-ends" aria-label="End date (optional)">' +
          '<span aria-hidden="true" class="press-add-dot">·</span>' +
          '<input type="text" class="press-add-field event-add-location" placeholder="Location" maxlength="120">' +
        '</div>' +
        // Optional summary — slim textarea, dashed underline.
        '<textarea class="press-add-field event-add-summary" rows="1" placeholder="Short summary (optional)" maxlength="280"></textarea>' +
        '<div class="press-add-actions">' +
          '<span class="press-add-hint" role="status" aria-live="polite"></span>' +
          '<button type="button" class="press-add-cancel">Cancel</button>' +
          '<button type="button" class="press-add-submit" disabled>Submit for review</button>' +
        '</div>' +
      '</div>';

    return {
      el:         el,
      titleRow:   el.querySelector('.press-add-title-row'),
      title:      el.querySelector('.event-add-title'),
      url:        el.querySelector('.event-add-url'),
      linkBtn:    el.querySelector('.press-add-link-btn'),
      starts:     el.querySelector('.event-add-starts'),
      ends:       el.querySelector('.event-add-ends'),
      location:   el.querySelector('.event-add-location'),
      summary:    el.querySelector('.event-add-summary'),
      cancel:     el.querySelector('.press-add-cancel'),
      submit:     el.querySelector('.press-add-submit'),
      hint:       el.querySelector('.press-add-hint')
    };
  }

  // ── Helpers ─────────────────────────────────────────────────
  function getSubmitterSlug() {
    var u = window.AHLAuth && window.AHLAuth.getUser && window.AHLAuth.getUser();
    return (u && u.person && u.person.slug) || null;
  }
  function debounce(fn, ms) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  function mountAll(scope) {
    var triggers = (scope || document).querySelectorAll('[data-event-add-trigger]');
    Array.prototype.forEach.call(triggers, mount);
    var editTriggers = (scope || document).querySelectorAll('[data-event-add-edit]');
    Array.prototype.forEach.call(editTriggers, mountEdit);
  }
  document.addEventListener('myahl:dashboard-rendered', function () { mountAll(); });
  if (document.readyState !== 'loading') mountAll();
  else document.addEventListener('DOMContentLoaded', function () { mountAll(); });

  // Edit-mode mounter — fetches event record by slug, opens card prefilled.
  function mountEdit(button) {
    if (!button || button.__eventEditMounted) return;
    button.__eventEditMounted = true;
    button.disabled = false;
    ensureSvgDefs();
    button.addEventListener('click', function (e) {
      e.preventDefault();
      var slug = button.getAttribute('data-event-add-edit');
      if (!slug) return;
      openEditCard(button, slug);
    });
  }

  function openEditCard(button, slug) {
    fetch('/data/events/' + encodeURIComponent(slug) + '.json', { cache: 'default' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (record) {
        if (!record) {
          alert('Couldn\'t load this event for editing.');
          return;
        }
        openCard(button, {
          editSlug: slug,
          title:    record.title || '',
          starts:   record.starts || '',
          ends:     record.ends || '',
          location: record.location || '',
          url:      record.url || '',
          summary:  record.summary || ''
        });
      });
  }

  window.AHLEventAdd = { mount: mount, mountEdit: mountEdit };
})();
