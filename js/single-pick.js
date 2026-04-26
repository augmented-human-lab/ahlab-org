/**
 * single-pick.js — modal picker for choosing ONE record from a
 * chip-picker source (people, sponsors, etc).
 *
 * Reuses the visual language of the chip-input picker on
 * /projects/new/ (search field + candidate grid/list). Two-stage
 * flow: pick a candidate → confirm screen → onPick callback.
 *
 * Used by:
 *   • claim-buttons.js → "Add Someone" on a project's team grid
 *     (people picker, excludes existing members).
 *   • project page → "Add sponsor" trigger
 *     (sponsors picker, excludes existing project sponsors).
 *
 * Usage:
 *   AHLSinglePick.open({
 *     sourceKey:    'people' | 'sponsors' | …,
 *     title:        'Add team member',
 *     excludeSlugs: [...],       // optional
 *     confirm:      {            // optional; if omitted, onPick fires immediately
 *       title:       'Add to project?',
 *       body:        function(item) { return 'Submit a request to …'; },
 *       submitLabel: 'Submit for review'
 *     },
 *     onPick:       function(item) { ... }   // item = { slug, label, ... }
 *   });
 */
(function () {
  'use strict';

  function pickers() { return window.AHLChipPickers || {}; }

  function open(opts) {
    var sourceKey = opts.sourceKey;
    var source    = (pickers()[sourceKey] || []).slice();
    var exclude   = {};
    (opts.excludeSlugs || []).forEach(function (s) { exclude[s] = true; });

    var backdrop = document.createElement('div');
    backdrop.className = 'np-singlepick-backdrop';

    var modal = document.createElement('div');
    modal.className = 'np-singlepick np-singlepick-' + sourceKey;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    modal.innerHTML =
      '<div class="np-singlepick-header">' +
        '<div class="np-singlepick-title">' + escHTML(opts.title || 'Pick one') + '</div>' +
        '<button type="button" class="np-singlepick-close" aria-label="Close">×</button>' +
      '</div>' +
      '<input type="search" class="np-singlepick-search" placeholder="Type to filter…" autocomplete="off">' +
      '<div class="np-singlepick-results"></div>';

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    var search  = modal.querySelector('.np-singlepick-search');
    var results = modal.querySelector('.np-singlepick-results');
    var closeBtn = modal.querySelector('.np-singlepick-close');

    function render(q) {
      var qLower = String(q || '').toLowerCase().trim();
      var matches = source.filter(function (item) {
        if (exclude[item.slug]) return false;
        if (!qLower) return true;
        var hay = ((item.label || '') + ' ' + (item.slug || '')).toLowerCase();
        return hay.indexOf(qLower) !== -1;
      }).slice(0, 60);

      results.innerHTML = '';
      if (!matches.length) {
        var empty = document.createElement('div');
        empty.className = 'np-picker-empty';
        empty.textContent = qLower ? 'No matches.' : 'Nothing to pick.';
        results.appendChild(empty);
        return;
      }
      matches.forEach(function (item) {
        var card = renderCard(item, sourceKey);
        card.addEventListener('click', function () {
          if (opts.confirm) {
            showConfirm(item);
          } else {
            close();
            if (typeof opts.onPick === 'function') opts.onPick(item);
          }
        });
        results.appendChild(card);
      });
    }

    function showConfirm(item) {
      // Swap the search + results out for a confirm view in the
      // same modal. The user has to click the explicit submit
      // button to fire onPick — picking a candidate alone never
      // commits anything.
      search.style.display = 'none';
      results.innerHTML = '';
      var view = document.createElement('div');
      view.className = 'np-singlepick-confirm';
      var bodyHtml = '';
      if (typeof opts.confirm.body === 'function') {
        bodyHtml = '<p class="np-singlepick-confirm-body">' + escHTML(opts.confirm.body(item)) + '</p>';
      }
      var preview = renderConfirmPreview(item, sourceKey);
      view.innerHTML =
        '<div class="np-singlepick-confirm-title">' + escHTML(opts.confirm.title || 'Confirm') + '</div>' +
        bodyHtml +
        '<div class="np-singlepick-confirm-preview">' + preview + '</div>' +
        '<div class="np-singlepick-confirm-actions">' +
          '<button type="button" class="np-singlepick-cancel">Cancel</button>' +
          '<button type="button" class="np-singlepick-submit">' +
            escHTML(opts.confirm.submitLabel || 'Submit for review') +
          '</button>' +
        '</div>';
      results.appendChild(view);
      view.querySelector('.np-singlepick-cancel').addEventListener('click', function () {
        // Back to the picker stage — restore search and re-render.
        view.remove();
        search.style.display = '';
        search.value = '';
        render('');
        setTimeout(function () { search.focus(); }, 0);
      });
      view.querySelector('.np-singlepick-submit').addEventListener('click', function () {
        var btn = view.querySelector('.np-singlepick-submit');
        btn.disabled = true;
        btn.textContent = 'Submitting…';
        close();
        if (typeof opts.onPick === 'function') opts.onPick(item);
      });
    }

    function renderConfirmPreview(item, sourceKey) {
      if (sourceKey === 'people') {
        var avatar = item.thumbnail
          ? '<img src="' + escAttr(item.thumbnail) + '" alt="">'
          : '<div class="project-person-avatar-placeholder">' + escHTML((item.label || '?').charAt(0)) + '</div>';
        return '<div class="project-person-card np-singlepick-card-large">' +
          '<div class="project-person-avatar">' + avatar + '</div>' +
          '<div class="project-person-name">' + escHTML(item.label) + '</div>' +
        '</div>';
      }
      return '<div class="np-singlepick-row" style="cursor:default;background:var(--color-neutral-20);text-align:center">' + escHTML(item.label) + '</div>';
    }

    function close() {
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
    }
    function onKey(e) { if (e.key === 'Escape') close(); }

    closeBtn.addEventListener('click', close);
    backdrop.addEventListener('click', function (e) {
      if (e.target === backdrop) close();
    });
    document.addEventListener('keydown', onKey);
    search.addEventListener('input', function () { render(search.value); });

    render('');
    setTimeout(function () { search.focus(); }, 0);
  }

  function renderCard(item, sourceKey) {
    var btn = document.createElement('button');
    btn.type = 'button';
    if (sourceKey === 'people') {
      btn.className = 'project-person-card np-singlepick-card';
      var avatar = item.thumbnail
        ? '<img src="' + escAttr(item.thumbnail) + '" alt="" loading="lazy">'
        : '<div class="project-person-avatar-placeholder">' + escHTML((item.label || '?').charAt(0)) + '</div>';
      btn.innerHTML =
        '<div class="project-person-avatar">' + avatar + '</div>' +
        '<div class="project-person-name">' + escHTML(item.label) + '</div>';
    } else {
      btn.className = 'np-singlepick-row';
      btn.textContent = item.label;
    }
    return btn;
  }

  function escHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escAttr(s) { return escHTML(s).replace(/"/g, '&quot;'); }

  window.AHLSinglePick = { open: open };
})();
