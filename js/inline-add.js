/**
 * inline-add.js — toggle a card-shaped "+ Add new …" button into an
 * editable card in the same DOM slot.
 *
 * Element model (per add slot):
 *   <wrap data-myahl-add-section>
 *     <button data-myahl-add-trigger>+ Add new …</button>
 *     <div     data-myahl-add-form    hidden>
 *       …inputs…
 *       <button data-myahl-add-close>×</button>
 *     </div>
 *   </wrap>
 *
 * Behavior:
 *   • Click trigger → hide trigger, show form, focus the first field.
 *   • Click close   → reset all inputs in the form, hide form, show
 *                     trigger.
 *
 * Visibility of the whole `data-myahl-add-section` is gated to
 * signed-in users separately by claim-buttons.js (the section also
 * carries data-myahl-claim="self", which evaluates to "visible when
 * logged in" outside the project-membership scope).
 */
(function () {
  document.addEventListener('click', function (e) {
    var trigger = e.target.closest('[data-myahl-add-trigger]');
    if (trigger) {
      var section = trigger.closest('[data-myahl-add-section]');
      if (!section) return;
      var triggerEl = section.querySelector('[data-myahl-add-trigger]');
      var formEl    = section.querySelector('[data-myahl-add-form]');
      if (!triggerEl || !formEl) return;
      triggerEl.hidden = true;
      formEl.hidden = false;
      var firstField = formEl.querySelector('input, textarea, select');
      if (firstField) firstField.focus();
      return;
    }

    var close = e.target.closest('[data-myahl-add-close]');
    if (close) {
      var section2 = close.closest('[data-myahl-add-section]');
      if (!section2) return;
      var triggerEl2 = section2.querySelector('[data-myahl-add-trigger]');
      var formEl2    = section2.querySelector('[data-myahl-add-form]');
      if (!triggerEl2 || !formEl2) return;
      // Discard whatever was typed — the user explicitly cancelled.
      formEl2.querySelectorAll('input, textarea').forEach(function (el) {
        if (el.type === 'checkbox' || el.type === 'radio') el.checked = false;
        else el.value = '';
      });
      formEl2.hidden = true;
      triggerEl2.hidden = false;
    }
  });
})();
