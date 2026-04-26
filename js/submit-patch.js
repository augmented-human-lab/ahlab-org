/**
 * submit-patch.js — build a hidden-input form and submit it via
 * top-level navigation to the Apps Script broker.
 *
 * Why top-level form POST instead of fetch:
 *   • Apps Script web apps (executeAs: USER_ACCESSING) can't grant
 *     CORS credentials — fetch() with cookies cross-origin doesn't
 *     work reliably, and Session.getActiveUser() needs the user's
 *     Workspace cookies.
 *   • A target="_top" form POST is a "simple request" in CORS terms
 *     (no preflight) and carries the user's cookies, so the broker
 *     trusts the identity.
 *
 * Flow:
 *   1. Site builds the patch payload (a plain object).
 *   2. Calls AHLPatch.submit({ targetType, targetSlug, action, patch,
 *                              files, returnUrl }).
 *   3. We assemble a <form> with hidden inputs, append to document,
 *      .submit(). Browser navigates the tab to the broker.
 *   4. Broker returns a "Submitted, awaiting review" page with a
 *      Continue button back to returnUrl.
 *
 * Files are passed as an array of { name, contentType, dataB64 }
 * already-processed (resized + optionally greyscaled) by image-processor.js.
 */
(function () {
  'use strict';

  function submit(opts) {
    if (!window.AHLAuth) throw new Error('AHLAuth not loaded');
    var token = window.AHLAuth.getToken();
    if (!token) {
      alert('Your sign-in session has expired. Please sign in again.');
      window.AHLAuth.login();
      return;
    }
    var brokerUrl = window.AHLAuth.getBrokerUrl();

    var form = document.createElement('form');
    form.method = 'POST';
    form.action = brokerUrl + (brokerUrl.indexOf('?') === -1 ? '?' : '&') + 'action=submit-patch';
    form.target = '_top';
    // Avoid leaving a dangling form in the DOM if the user navigates
    // back to this page; we'll remove it after .submit() anyway.
    form.style.display = 'none';

    function addField(name, value) {
      var i = document.createElement('input');
      i.type = 'hidden';
      i.name = name;
      i.value = value == null ? '' : String(value);
      form.appendChild(i);
    }

    addField('token', token);
    addField('targetType',  opts.targetType  || '');
    addField('targetSlug',  opts.targetSlug  || '');
    addField('actionType',  opts.action      || '');
    addField('patch',       JSON.stringify(opts.patch || {}));
    // returnUrl MUST be absolute. The Continue button on the
    // broker's receipt page is hosted on script.googleusercontent.com;
    // a relative href like "/my-ahl/" would resolve against THAT
    // origin (404 → Google Drive's "Sorry, unable to open" page).
    addField('returnUrl',   opts.returnUrl   || (location.origin + location.pathname + location.search + location.hash));

    (opts.files || []).forEach(function (f, i) {
      addField('file_' + i + '_name',         f.name || ('file' + i));
      addField('file_' + i + '_contentType',  f.contentType || 'application/octet-stream');
      addField('file_' + i + '_dataB64',      f.dataB64 || '');
    });

    document.body.appendChild(form);
    form.submit();
    // Don't bother removing — the page is about to navigate away.
  }

  window.AHLPatch = { submit: submit };
})();
