/**
 * chip-input.js — autocomplete-only multi-select for slug references.
 *
 * Element model:
 *   <div class="np-chip-input"
 *        data-chip-collection="publications">       ← payload key
 *     <div class="np-chip-list" data-chip-list>
 *       <!-- rendered chips: <span data-slug="…">…</span> -->
 *     </div>
 *     <input class="np-chip-search"
 *            list="np-publications-list"
 *            placeholder="Add a publication…"
 *            data-chip-search>
 *     <datalist id="np-publications-list">
 *       <option value="slug-a">Title A</option>
 *       …
 *     </datalist>
 *   </div>
 *
 * Behavior:
 *   • As the user types, the browser's native datalist surfaces
 *     matching options (search by slug AND by visible label).
 *   • On `change` (i.e. the user picked from the dropdown), if the
 *     entered string matches an option, we add it as a chip and
 *     clear the input. Free-form values that don't match any option
 *     are silently rejected — by design, you can only attach
 *     EXISTING records.
 *   • Each chip has an × button to remove it.
 *   • myahl-forms.js collects chips at submit time: every
 *     [data-chip-list] under a [data-myahl-submit] form contributes
 *     its slugs to payload[data-chip-collection].
 *
 * Data attribute on chips: `data-slug` is the canonical key sent in
 * the payload; the visible chip text is the human label (title /
 * name) for readability.
 */
(function () {
  'use strict';

  function init() {
    document.querySelectorAll('.np-chip-input').forEach(setupChipInput);
  }

  function setupChipInput(wrap) {
    var input = wrap.querySelector('[data-chip-search]');
    var list  = wrap.querySelector('[data-chip-list]');
    if (!input || !list) return;

    // Build a lookup map { slug → label } from the datalist so we
    // can display the right label after the user picks. Browsers
    // fire `change` with input.value === the chosen option's value
    // (which we set to the slug); we use the map to find the title.
    var datalist = wrap.querySelector('datalist');
    var labelBySlug = {};
    if (datalist) {
      Array.prototype.forEach.call(datalist.options, function (opt) {
        labelBySlug[opt.value] = opt.textContent || opt.value;
      });
    }

    input.addEventListener('change', function () {
      var raw = String(input.value || '').trim();
      if (!raw) return;
      // Only accept exact slug matches from the datalist.
      if (!(raw in labelBySlug)) {
        input.value = '';
        return;
      }
      // Already added? skip.
      if (list.querySelector('[data-slug="' + cssEscape(raw) + '"]')) {
        input.value = '';
        return;
      }
      addChip(list, raw, labelBySlug[raw]);
      input.value = '';
      input.focus();
    });

    // Remove via the × button.
    list.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-chip-remove]');
      if (!btn) return;
      var chip = btn.closest('[data-slug]');
      if (chip) chip.remove();
    });
  }

  function addChip(list, slug, label) {
    var chip = document.createElement('span');
    chip.className = 'np-chip';
    chip.setAttribute('data-slug', slug);
    chip.innerHTML =
      '<span class="np-chip-label"></span>' +
      '<button type="button" class="np-chip-remove" data-chip-remove aria-label="Remove">×</button>';
    chip.querySelector('.np-chip-label').textContent = label || slug;
    list.appendChild(chip);
  }

  function cssEscape(s) {
    return String(s).replace(/(["\\])/g, '\\$1');
  }

  // Expose programmatic add for cases like the team section, where
  // the page's own bootstrap script needs to seed the creator's chip
  // before the user does anything.
  window.AHLChipInput = {
    init: init,
    addChip: function (wrapEl, slug, label) {
      var list = wrapEl.querySelector('[data-chip-list]');
      if (!list) return;
      if (list.querySelector('[data-slug="' + cssEscape(slug) + '"]')) return;
      addChip(list, slug, label);
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
