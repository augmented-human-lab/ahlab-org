/**
 * claim-buttons.js — auth-aware claim / membership buttons.
 *
 * Toggles the visibility of `[data-myahl-claim]` elements based on
 * who's signed in (via window.AHLAuth). Used today on project pages
 * to surface "Add Me" / "Add Someone" buttons in the team grid; the
 * data attributes are deliberately generic so the same script can
 * power claim buttons on publication / event / press pages later.
 *
 * Element model:
 *   <wrap data-project-people="slug1 slug2 ...">
 *     <button data-myahl-claim="self"   hidden>Add Me</button>
 *     <button data-myahl-claim="other"  hidden>Add Someone</button>
 *   </wrap>
 *
 * Visibility rules:
 *   • not signed in           → both hidden
 *   • signed in, NOT already
 *     a member of this scope  → "self" visible  (offer to join)
 *   • signed in, ALREADY a
 *     member of this scope    → "other" visible (offer to add another)
 * "self" and "other" are mutually exclusive: a user is either looking
 * to join, or already in and adding others — never both at once.
 *
 * The buttons themselves stay disabled (the click handler is a no-op
 * with a tooltip) until the Apps Script edit pipeline lands.
 */
(function () {
  if (!window.AHLAuth) return;

  function applyClaims(user) {
    var claims = document.querySelectorAll('[data-myahl-claim]');
    claims.forEach(function (btn) {
      var type = btn.getAttribute('data-myahl-claim');
      var visible = false;
      if (user && user.person && user.person.slug) {
        var wrap = btn.closest('[data-project-people]');
        var slugs = wrap
          ? (wrap.getAttribute('data-project-people') || '').split(/\s+/).filter(Boolean)
          : [];
        var isMember = slugs.indexOf(user.person.slug) !== -1;
        if (type === 'self')  visible = !isMember;   // hide "+ Me" once joined
        if (type === 'other') visible =  isMember;
      }
      btn.hidden = !visible;
    });

    // Empty sections — those rendered server-side with
    // data-myahl-empty="true" + hidden because they had no items at
    // build time — should appear when a claim button inside them
    // becomes visible (so members see an empty heading + "+ new"
    // button). Non-members and signed-out users keep them hidden.
    var emptySections = document.querySelectorAll('[data-myahl-empty="true"]');
    emptySections.forEach(function (section) {
      var visibleClaim = section.querySelector('[data-myahl-claim]:not([hidden])');
      section.hidden = !visibleClaim;
    });
  }

  window.AHLAuth.onChange(applyClaims);

  // ── Click handler for Add Me / Add Someone ─────────────────
  // Buttons with data-myahl-claim-action submit a project/claim-*
  // patch via AHLPatch (loaded by submit-patch.js — this script
  // is no-op if the patch helper isn't on the page, e.g. before
  // submit-patch.js loads).
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-myahl-claim-action]');
    if (!btn || btn.disabled) return;
    var action = btn.getAttribute('data-myahl-claim-action');
    var wrap = btn.closest('[data-project-slug]');
    if (!wrap) return;
    var projectSlug = wrap.getAttribute('data-project-slug');
    if (!window.AHLPatch) {
      alert('Submit helper not loaded yet — reload the page and try again.');
      return;
    }
    if (action === 'claim-self') {
      window.AHLPatch.submit({
        targetType: 'project',
        targetSlug: projectSlug,
        action:     'claim-self',
        patch:      {}
      });
      return;
    }
    if (action === 'claim-other') {
      var personSlug = window.prompt(
        'Slug of the person to add (e.g. "ariel-ong"):'
      );
      if (!personSlug) return;
      window.AHLPatch.submit({
        targetType: 'project',
        targetSlug: projectSlug,
        action:     'claim-other',
        patch:      { personSlug: personSlug.trim() }
      });
    }
  });
})();
