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
 *   • signed in               → "self" visible
 *   • signed in AND already a
 *     member of this scope    → "other" visible (in addition to "self")
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
      if (user) {
        if (type === 'self') {
          visible = true;
        } else if (type === 'other') {
          // Membership-scoped: only show when the signed-in user's
          // slug is in the wrapper's people list.
          var wrap = btn.closest('[data-project-people]');
          if (wrap && user.person && user.person.slug) {
            var raw = wrap.getAttribute('data-project-people') || '';
            var slugs = raw.split(/\s+/).filter(Boolean);
            visible = slugs.indexOf(user.person.slug) !== -1;
          }
        }
      }
      btn.hidden = !visible;
    });
  }

  window.AHLAuth.onChange(applyClaims);
})();
