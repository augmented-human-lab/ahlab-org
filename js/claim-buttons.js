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
})();
