/**
 * chip-input.js — inline card-picker for slug references.
 *
 * Element model:
 *   <div class="np-chip-input"
 *        data-chip-collection="people"     ← payload field key
 *        data-chip-source="people">        ← key into AHLChipPickers
 *     <div class="np-chip-list" data-chip-list>
 *       <!-- chosen items rendered here -->
 *     </div>
 *   </div>
 *
 * Behavior:
 *   • Reads candidate items from window.AHLChipPickers[<source>]:
 *       people:       { slug, label, thumbnail }
 *       publications: { slug, label, citation, year, award, links }
 *       awards:       { slug, label, outlet, year, url, type }
 *       (others):     { slug, label }
 *   • Renders chosen items + an "+ Add" tile inline. Click the
 *     tile → expandable picker grid appears below with a search
 *     box and up to 60 candidate cards. Click a candidate to add.
 *     Escape (or clicking outside) closes the picker.
 *   • Free-form entry is impossible by design: only existing
 *     records can be attached.
 *   • Chip rendering specializes by source:
 *       people       → project-person-card (rounded thumb + name)
 *       publications → pub-item card (title + citation + links)
 *       awards       → press-item card (icon + title + outlet/year)
 *       sponsors     → pill chip
 *   • A chip created via AHLChipInput.addChip(..., {locked:true})
 *     omits the × control — used to fix the creator on the team
 *     list so they can't accidentally remove themselves.
 *   • Whenever the chip set changes, the wrap dispatches a
 *     "chip-change" CustomEvent so page-level validation can react.
 *   • myahl-forms.js collects chips at submit time: every
 *     [data-chip-list] under a [data-myahl-submit] form contributes
 *     its slugs to payload[data-chip-collection].
 */
(function () {
  'use strict';

  function pickers() { return window.AHLChipPickers || {}; }

  function init() {
    document.querySelectorAll('.np-chip-input').forEach(setup);
  }

  function setup(wrap) {
    var sourceKey = wrap.getAttribute('data-chip-source')
                 || wrap.getAttribute('data-chip-collection');
    var list = wrap.querySelector('[data-chip-list]');
    if (!list) return;
    var source = (pickers()[sourceKey] || []).slice();

    // Build picker UI (inline, hidden until "+ Add" clicked).
    var picker = document.createElement('div');
    picker.className = 'np-picker np-picker-' + sourceKey;
    picker.hidden = true;

    var search = document.createElement('input');
    search.type = 'search';
    search.className = 'np-picker-search';
    search.placeholder = pickerSearchPlaceholder(sourceKey);
    search.setAttribute('autocomplete', 'off');

    var results = document.createElement('div');
    results.className = 'np-picker-results';

    picker.appendChild(search);
    picker.appendChild(results);

    var addTile = renderAddTile(sourceKey);
    list.appendChild(addTile);
    wrap.appendChild(picker);

    addTile.addEventListener('click', function () {
      var nextHidden = !picker.hidden;
      picker.hidden = nextHidden;
      if (!nextHidden) {
        search.value = '';
        renderResults('');
        setTimeout(function () { search.focus(); }, 0);
      }
    });

    // Escape (or click outside the wrap) closes the picker.
    search.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        picker.hidden = true;
        addTile.focus();
      }
    });
    document.addEventListener('click', function (e) {
      if (picker.hidden) return;
      if (wrap.contains(e.target)) return;
      picker.hidden = true;
    });

    function chosenSlugs() {
      var out = [];
      Array.prototype.forEach.call(
        list.querySelectorAll('[data-slug]'),
        function (el) { out.push(el.getAttribute('data-slug')); }
      );
      return out;
    }

    function renderResults(q) {
      var qLower = String(q || '').toLowerCase().trim();
      var taken = chosenSlugs();
      var matches = source.filter(function (item) {
        if (taken.indexOf(item.slug) !== -1) return false;
        if (!qLower) return true;
        var hay = ((item.label || '') + ' ' + (item.slug || '') + ' ' +
                   (item.outlet || '') + ' ' + (item.citation || '')).toLowerCase();
        return hay.indexOf(qLower) !== -1;
      }).slice(0, 60);

      results.innerHTML = '';
      if (!matches.length) {
        var empty = document.createElement('div');
        empty.className = 'np-picker-empty';
        empty.textContent = qLower ? 'No matches.' : 'Nothing left to add.';
        results.appendChild(empty);
        return;
      }
      matches.forEach(function (item) {
        var card = renderCandidate(item, sourceKey);
        card.addEventListener('click', function () {
          addChip(list, wrap, item, sourceKey, false);
          list.appendChild(addTile); // keep at end
          renderResults(search.value);
        });
        results.appendChild(card);
      });
    }

    renderResults('');
  }

  function pickerSearchPlaceholder(sourceKey) {
    if (sourceKey === 'people')       return 'Type a name…';
    if (sourceKey === 'publications') return 'Search by title or citation…';
    if (sourceKey === 'awards')       return 'Search awards…';
    if (sourceKey === 'sponsors')     return 'Search sponsors…';
    return 'Type to filter…';
  }

  function renderAddTile(sourceKey) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-add-tile', '');
    if (sourceKey === 'people') {
      btn.className = 'project-person-card project-person-claim np-add-tile np-add-tile-card';
      btn.innerHTML =
        '<div class="project-person-avatar" aria-hidden="true">+</div>' +
        '<div class="project-person-name">Link</div>';
    } else if (sourceKey === 'publications') {
      // Reuse the dashed-border trigger styling shared with the
      // /publications/ page so the linker reads as a real card.
      btn.className = 'pub-item pub-item-add-trigger np-add-tile';
      btn.innerHTML =
        '<div class="pub-body">' +
          '<div class="pub-add-trigger-label">' +
            '<span class="pub-add-plus" aria-hidden="true">+</span>' +
            '<span>Link a publication</span>' +
          '</div>' +
        '</div>';
    } else if (sourceKey === 'awards') {
      // Same dashed-border trigger used on /press/ for "+ Add new press".
      btn.className = 'press-add-trigger np-add-tile';
      btn.innerHTML =
        '<span class="press-add-plus" aria-hidden="true">+</span>' +
        '<span class="press-add-trigger-label">Link an award</span>';
    } else {
      btn.className = 'np-chip np-add-tile np-add-tile-pill';
      btn.innerHTML = '<span class="np-chip-label">+ Link</span>';
    }
    return btn;
  }

  function renderCandidate(item, sourceKey) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'np-picker-card np-picker-card-' + sourceKey;
    if (sourceKey === 'people') {
      btn.classList.add('project-person-card');
      btn.innerHTML =
        '<div class="project-person-avatar">' + avatarHTML(item) + '</div>' +
        '<div class="project-person-name">' + escHTML(item.label) + '</div>';
    } else if (sourceKey === 'publications') {
      var meta = item.year ? '<span class="np-picker-meta">' + escHTML(item.year) + '</span>' : '';
      btn.innerHTML =
        '<div class="np-picker-row-title">' + escHTML(item.label) + '</div>' +
        (item.citation ? '<div class="np-picker-row-sub">' + escHTML(item.citation) + '</div>' : meta);
    } else if (sourceKey === 'awards') {
      var bits = [];
      if (item.outlet) bits.push(escHTML(item.outlet));
      if (item.year) bits.push(escHTML(item.year));
      btn.innerHTML =
        '<div class="np-picker-row-title">' + escHTML(item.label) + '</div>' +
        (bits.length ? '<div class="np-picker-row-sub">' + bits.join(' · ') + '</div>' : '');
    } else {
      btn.classList.add('np-picker-row');
      btn.textContent = item.label;
    }
    return btn;
  }

  function addChip(list, wrap, item, sourceKey, locked) {
    if (list.querySelector('[data-slug="' + cssEscape(item.slug) + '"]')) return;
    var chip;

    if (sourceKey === 'people') {
      chip = document.createElement('div');
      chip.className = 'project-person-card np-people-chip';
      chip.setAttribute('data-slug', item.slug);
      chip.innerHTML =
        '<div class="project-person-avatar">' + avatarHTML(item) + '</div>' +
        '<div class="project-person-name">' + escHTML(item.label) + '</div>' +
        (locked ? '' :
         '<button type="button" class="np-people-chip-remove" data-chip-remove ' +
           'aria-label="Remove ' + escAttr(item.label) + '">×</button>');
    } else if (sourceKey === 'publications') {
      chip = document.createElement('div');
      chip.className = 'pub-item np-pub-chip';
      chip.setAttribute('data-slug', item.slug);
      var awardHTML = item.award
        ? '<div class="pub-award">★ ' + escHTML(item.award) + '</div>'
        : '';
      var linksHTML = (item.links && item.links.length)
        ? '<div class="pub-links">' + item.links.map(function (l) {
            return '<a href="' + escAttr(l.url) + '" target="_blank" rel="noopener" class="pub-link">' +
                   escHTML((l.label || 'link').toUpperCase()) + '</a>';
          }).join('') + '</div>'
        : '';
      chip.innerHTML =
        '<div class="pub-body">' +
          awardHTML +
          '<div class="pub-title">' + escHTML(item.label) + '</div>' +
          (item.citation ? '<div class="pub-citation">' + escHTML(item.citation) + '</div>' : '') +
          linksHTML +
        '</div>' +
        (locked ? '' :
         '<button type="button" class="np-card-chip-remove" data-chip-remove ' +
           'aria-label="Remove ' + escAttr(item.label) + '">×</button>');
    } else if (sourceKey === 'awards') {
      chip = document.createElement('div');
      chip.className = 'press-item is-award np-award-chip';
      chip.setAttribute('data-slug', item.slug);
      var bits = [];
      bits.push('<span class="press-type-tag award">award</span>');
      if (item.outlet) bits.push(escHTML(item.outlet));
      if (item.year) bits.push(escHTML(item.year));
      chip.innerHTML =
        '<div class="press-icon award" aria-hidden="true">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<circle cx="12" cy="9" r="6"/><path d="M9 14.5 7 22l5-3 5 3-2-7.5"/>' +
          '</svg>' +
        '</div>' +
        '<div class="press-body">' +
          '<div class="press-title">' + escHTML(item.label) + '</div>' +
          '<div class="press-outlet">' + bits.join('<span aria-hidden="true" style="color:var(--color-neutral-40)"> · </span>') + '</div>' +
        '</div>' +
        (locked ? '' :
         '<button type="button" class="np-card-chip-remove" data-chip-remove ' +
           'aria-label="Remove ' + escAttr(item.label) + '">×</button>');
    } else {
      chip = document.createElement('span');
      chip.className = 'np-chip';
      chip.setAttribute('data-slug', item.slug);
      chip.innerHTML =
        '<span class="np-chip-label">' + escHTML(item.label) + '</span>' +
        (locked ? '' :
         '<button type="button" class="np-chip-remove" data-chip-remove ' +
           'aria-label="Remove ' + escAttr(item.label) + '">×</button>');
    }
    if (locked) chip.setAttribute('data-locked', '');

    var addTile = list.querySelector('[data-add-tile]');
    if (addTile) list.insertBefore(chip, addTile);
    else list.appendChild(chip);

    var removeBtn = chip.querySelector('[data-chip-remove]');
    if (removeBtn) {
      removeBtn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        chip.remove();
        wrap.dispatchEvent(new CustomEvent('chip-change', { bubbles: true }));
      });
    }
    wrap.dispatchEvent(new CustomEvent('chip-change', { bubbles: true }));
  }

  function avatarHTML(item) {
    if (item.thumbnail) {
      return '<img src="' + escAttr(item.thumbnail) + '" alt="" loading="lazy">';
    }
    var initial = (item.label || item.slug || '?').charAt(0);
    return '<div class="project-person-avatar-placeholder">' + escHTML(initial) + '</div>';
  }

  function escHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
  function escAttr(s) { return escHTML(s).replace(/"/g, '&quot;'); }
  function cssEscape(s) { return String(s).replace(/(["\\])/g, '\\$1'); }

  // Programmatic seed for the page-bootstrap script.
  // Pass {locked:true} to omit the × control (used for the creator
  // chip on the team list — they can't remove themselves).
  window.AHLChipInput = {
    init: init,
    addChip: function (wrapEl, slug, label, thumbnail, opts) {
      var sourceKey = wrapEl.getAttribute('data-chip-source')
                   || wrapEl.getAttribute('data-chip-collection');
      var list = wrapEl.querySelector('[data-chip-list]');
      if (!list) return;
      var item = { slug: slug, label: label, thumbnail: thumbnail || null };
      // For non-people sources, look up the full record from the
      // picker data so we can render the rich card. Falls back to
      // bare {slug,label} if not found.
      var source = (pickers()[sourceKey] || []);
      for (var i = 0; i < source.length; i++) {
        if (source[i].slug === slug) {
          item = Object.assign({}, source[i]);
          if (label) item.label = label;
          if (thumbnail) item.thumbnail = thumbnail;
          break;
        }
      }
      addChip(list, wrapEl, item, sourceKey, !!(opts && opts.locked));
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
