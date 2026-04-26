/**
 * myahl-forms.js — converts the existing inline `[data-myahl-add-form]`
 * cards into actual patch submitters by collecting [data-field=…]
 * inputs into a payload and calling AHLPatch.submit().
 *
 * Form contract:
 *   <form-ish [data-myahl-submit="<formKind>"] [data-myahl-add-form]>
 *     <input data-field="title" …>
 *     <input data-field="link-doi" …>     // any field starting with
 *                                           // "link-" is collected
 *                                           // into a links[] array
 *     <input type="file" data-field="photo" data-image-policy="profile|project">
 *     <button data-myahl-submit-trigger>Submit</button>
 *   </form-ish>
 *
 * Recognized formKind values map to patch (targetType, action,
 * targetSlug-derivation):
 *
 *   publication-create  → publication / create / <new>
 *   press-create        → press       / create / <new>
 *   project-create      → project     / create / <new>
 *   profile-edit        → profile     / edit   / <user's slug>
 *
 * On submit:
 *   1. Collect [data-field] values into a payload object.
 *   2. Process any file inputs through AHLImage (resize +
 *      optional greyscale via data-image-policy="profile").
 *   3. Disable the form, show "Submitting…" on the button.
 *   4. Call AHLPatch.submit(...) — this navigates the tab away to
 *      the Apps Script broker, which renders a receipt page.
 */
(function () {
  'use strict';

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-myahl-submit-trigger]');
    if (!btn) return;
    var form = btn.closest('[data-myahl-submit]');
    if (!form) return;
    e.preventDefault();
    handle(form, btn);
  });

  function handle(form, btn) {
    var formKind = form.getAttribute('data-myahl-submit');
    var spec = SPECS[formKind];
    if (!spec) {
      alert('Unknown form: ' + formKind);
      return;
    }

    var payload = {};
    var links = [];
    var files = [];
    var fileInputs = [];

    var fieldEls = form.querySelectorAll('[data-field]');
    Array.prototype.forEach.call(fieldEls, function (el) {
      var name = el.getAttribute('data-field');
      var val = el.value;
      if (el.type === 'file') {
        if (el.files && el.files.length) {
          fileInputs.push({
            file:   el.files[0],
            policy: el.getAttribute('data-image-policy') || ''
          });
        }
        return;
      }
      if (!val) return;
      if (name.indexOf('link-') === 0) {
        var label = name.slice(5);
        links.push({ label: label, url: val });
        return;
      }
      payload[name] = val;
    });
    if (links.length) payload.links = links;

    // Chip inputs: each [data-chip-list] under the form contributes
    // its chip slugs to a payload field named after data-chip-collection
    // on the wrapper. Built by chip-input.js.
    var chipWraps = form.querySelectorAll('[data-chip-collection]');
    Array.prototype.forEach.call(chipWraps, function (wrap) {
      var collection = wrap.getAttribute('data-chip-collection');
      if (!collection) return;
      var slugs = [];
      Array.prototype.forEach.call(
        wrap.querySelectorAll('[data-chip-list] [data-slug]'),
        function (chip) { slugs.push(chip.getAttribute('data-slug')); }
      );
      payload[collection] = slugs;
    });

    // Spec-specific finalization (e.g. project-create wants
    // principles[] from checkboxes; publication-create wants the
    // single projectSlug as projectSlugs[]).
    if (typeof spec.finalize === 'function') {
      try { spec.finalize(payload, form); }
      catch (err) { alert(err.message); return; }
    }

    var user = window.AHLAuth && window.AHLAuth.getUser();
    if (!user) {
      alert('Sign in required.');
      window.AHLAuth && window.AHLAuth.login();
      return;
    }
    var targetSlug = spec.targetSlugFrom
      ? spec.targetSlugFrom(payload, user)
      : '<new>';

    setBusy(form, btn, true);

    // Process file uploads (resize + optional greyscale).
    var fileWork = fileInputs.map(function (fi) {
      return window.AHLImage.process(fi.file, {
        greyscale: fi.policy === 'profile'
      });
    });

    Promise.all(fileWork).then(function (processed) {
      processed.forEach(function (f) { files.push(f); });
      // Cache the pending patch locally so /my-ahl/ can render it
      // immediately on next load (before the broker's list-my-patches
      // round-trip catches up). Best-effort — silent failure if
      // localStorage is full / disabled.
      if (window.AHLPendingCache) {
        try {
          window.AHLPendingCache.add({
            targetType: spec.targetType,
            action:     spec.action,
            targetSlug: targetSlug,
            patch:      payload
          });
        } catch (e) {}
      }
      window.AHLPatch.submit({
        targetType: spec.targetType,
        targetSlug: targetSlug,
        action:     spec.action,
        patch:      payload,
        files:      files,
        // After the receipt page, send the user to /my-ahl/ where
        // the pending card (cached above) is already visible.
        returnUrl:  location.origin + '/my-ahl/'
      });
    }).catch(function (err) {
      setBusy(form, btn, false);
      alert(err.message || 'Couldn\'t process the upload.');
    });
  }

  function setBusy(form, btn, busy) {
    Array.prototype.forEach.call(form.querySelectorAll('input,textarea,select,button'), function (el) {
      el.disabled = busy;
    });
    if (busy) {
      btn.dataset._label = btn.textContent;
      btn.textContent = 'Submitting…';
    } else if (btn.dataset._label) {
      btn.textContent = btn.dataset._label;
    }
  }

  // Per-formKind specs — drive the payload shape + slug derivation.
  var SPECS = {
    'publication-create': {
      targetType: 'publication',
      action:     'create',
      finalize: function (payload) {
        if (payload.projectSlug) {
          payload.projectSlugs = [payload.projectSlug];
          delete payload.projectSlug;
        }
      }
    },
    'press-create': {
      targetType: 'press',
      action:     'create'
    },
    'project-create': {
      targetType: 'project',
      action:     'create',
      finalize: function (payload, form) {
        // principles[] from checkboxes named principle-<key>.
        var princ = [];
        Array.prototype.forEach.call(
          form.querySelectorAll('input[type="checkbox"][data-principle]:checked'),
          function (cb) { princ.push(cb.getAttribute('data-principle')); }
        );
        if (princ.length) payload.principles = princ;
        // external_links[] from each [data-external-link] row.
        // Schema mirrors what's already on disk in
        // cdn-ahlab-org/data/projects/<slug>.json: { kind, label, url }.
        // Rows with empty URL are skipped; empty label defaults to
        // the host so the public site has something to render.
        var ext = [];
        Array.prototype.forEach.call(
          form.querySelectorAll('[data-external-link]'),
          function (row) {
            var url = (row.querySelector('[data-link-url]') || {}).value;
            var kind = (row.querySelector('[data-link-kind]') || {}).value || 'website';
            url = String(url || '').trim();
            if (!url) return;
            var label = '';
            try { label = new URL(url).host.replace(/^www\./, ''); } catch (e) { label = kind; }
            ext.push({ kind: kind, label: label, url: url });
          }
        );
        if (ext.length) payload.external_links = ext;
        if (!payload.title) throw new Error('Project title is required.');
      }
    },
    'profile-edit': {
      targetType: 'profile',
      action:     'edit',
      targetSlugFrom: function (payload, user) {
        return user.person && user.person.slug;
      }
    }
  };
})();
