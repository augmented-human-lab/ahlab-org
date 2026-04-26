/**
 * project-edit.js — inline editing of the project hero
 * (title / year / description) on /projects/<slug>/.
 *
 * Triggered by the pencil buttons in the hero
 * (.project-edit-title, .project-edit-principles). On click we
 * swap the displayed title H1 + year span + description prose for
 * editable inputs, render a Save/Cancel bar pinned to the hero,
 * and on Save submit a `project/edit` patch via AHLPatch.submit.
 *
 * The patch broker accepts these fields for project/edit:
 *   title, year, description, thumbnail, principles, external_links
 * (see broker submit.js validateProjectPatch_).
 *
 * We only expose title / year / description here for v1; principle
 * editing can land later as toggle-chips in the same edit mode.
 *
 * Visibility:
 *   • Pencils carry data-myahl-claim="other" → claim-buttons.js
 *     reveals them for project members only.
 *   • Both pencils share the same edit mode (title pencil and
 *     principles pencil enter the same flow).
 */
(function () {
  'use strict';

  function init() {
    document.addEventListener('click', function (e) {
      var trigger = e.target.closest('[data-myahl-edit-trigger]');
      if (!trigger || trigger.disabled) return;
      var hero = trigger.closest('.project-hero');
      if (!hero) return;
      enterEdit(hero);
    });
  }

  function enterEdit(hero) {
    if (hero.classList.contains('is-editing')) return;
    hero.classList.add('is-editing');

    var titleH1 = hero.querySelector('h1');
    var yearSpan = hero.querySelector('.project-title-year');
    var descBlock = hero.querySelector('.project-description');
    var slug = (hero.closest('[data-project-slug]') || {}).getAttribute
      ? hero.closest('[data-project-slug]').getAttribute('data-project-slug')
      : null;
    // Hero on project pages doesn't carry data-project-slug — pull
    // from any nested wrapper that does (the sponsors row, the
    // people row). They all share the same project slug.
    if (!slug) {
      var anyScope = document.querySelector('[data-project-slug]');
      slug = anyScope && anyScope.getAttribute('data-project-slug');
    }
    if (!slug) {
      hero.classList.remove('is-editing');
      alert('Could not determine project slug.');
      return;
    }

    // Snapshot original values + DOM so Cancel can restore.
    var originalTitle = (titleH1.firstChild && titleH1.firstChild.textContent || '').trim();
    var originalYearMatch = yearSpan ? yearSpan.textContent.replace(/^[\s·]+/, '').trim() : '';
    var originalDescParas = [];
    if (descBlock) {
      descBlock.querySelectorAll('p').forEach(function (p) { originalDescParas.push(p.textContent); });
    }
    var originalDesc = originalDescParas.join('\n\n');

    var originalTitleHtml = titleH1.innerHTML;
    var originalDescHtml  = descBlock ? descBlock.innerHTML : '';

    // Title: keep the H1 element, replace content with an input that
    // mimics the H1 styling. Year input lives in the same .project-
    // title-year wrapper for layout parity.
    titleH1.innerHTML =
      '<input type="text" class="pe-input pe-title-input" maxlength="32" value="' +
        escAttr(originalTitle) + '" placeholder="Project title">' +
      '<span class="project-title-year">' +
        '<span class="project-title-sep" aria-hidden="true">·</span>' +
        '<input type="text" class="pe-input pe-year-input" maxlength="12" value="' +
          escAttr(originalYearMatch) + '" placeholder="2026">' +
      '</span>';

    if (descBlock) {
      descBlock.innerHTML =
        '<textarea class="pe-input pe-desc-input" rows="6" maxlength="600" ' +
          'placeholder="Describe what this project is about — paragraphs separated by blank lines.">' +
          escHTML(originalDesc) +
        '</textarea>';
    }

    // Action bar pinned to the bottom of the hero.
    var bar = document.createElement('div');
    bar.className = 'pe-actions';
    bar.innerHTML =
      '<button type="button" class="pe-cancel">Cancel</button>' +
      '<button type="button" class="pe-save">Submit for review</button>';
    hero.appendChild(bar);

    var titleInput = titleH1.querySelector('.pe-title-input');
    var yearInput  = titleH1.querySelector('.pe-year-input');
    var descInput  = descBlock ? descBlock.querySelector('.pe-desc-input') : null;
    var saveBtn    = bar.querySelector('.pe-save');
    var cancelBtn  = bar.querySelector('.pe-cancel');

    setTimeout(function () { titleInput && titleInput.focus(); }, 0);

    cancelBtn.addEventListener('click', function () {
      titleH1.innerHTML = originalTitleHtml;
      if (descBlock) descBlock.innerHTML = originalDescHtml;
      bar.remove();
      hero.classList.remove('is-editing');
    });

    saveBtn.addEventListener('click', function () {
      if (!window.AHLPatch) {
        alert('Submit helper not loaded yet — reload the page.');
        return;
      }
      var newTitle = (titleInput.value || '').trim();
      var newYear  = yearInput ? (yearInput.value || '').trim() : '';
      var newDesc  = descInput ? (descInput.value || '').trim() : '';
      if (!newTitle) {
        alert('Project title cannot be empty.');
        return;
      }
      var patch = {};
      if (newTitle !== originalTitle)         patch.title = newTitle;
      if (newYear  !== originalYearMatch)     patch.year  = newYear;
      if (newDesc  !== originalDesc)          patch.description = newDesc;
      if (!Object.keys(patch).length) {
        alert('Nothing changed.');
        return;
      }
      saveBtn.disabled = true;
      saveBtn.textContent = 'Submitting…';
      window.AHLPatch.submit({
        targetType: 'project',
        targetSlug: slug,
        action:     'edit',
        patch:      patch,
        // After receipt, return to the project page (not /my-ahl/) —
        // the user's mental model here is "I edited this project,
        // take me back to look at it pending".
        returnUrl:  location.origin + location.pathname
      });
    });
  }

  function escHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escAttr(s) { return escHTML(s).replace(/"/g, '&quot;'); }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
