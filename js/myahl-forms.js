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
      window.AHLPatch.submit({
        targetType: spec.targetType,
        targetSlug: targetSlug,
        action:     spec.action,
        patch:      payload,
        files:      files
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
