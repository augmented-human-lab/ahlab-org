/**
 * single-pick.js — modal picker for choosing ONE record from a
 * chip-picker source (people, sponsors, etc).
 *
 * Reuses the visual language of the chip-input picker on
 * /projects/new/ (search field + candidate grid/list) but trades
 * the multi-select chip-list for a callback-on-pick: clicking a
 * candidate immediately resolves the modal with that record.
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
          close();
          if (typeof opts.onPick === 'function') opts.onPick(item);
        });
        results.appendChild(card);
      });
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
