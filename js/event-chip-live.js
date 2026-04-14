// event-chip-live.js
// ==================
// Runtime refresher for .event-chip elements. The build step emits
// chips inside a generous window (14 days before start → 1 day after
// end) so a site built "yesterday" still carries the chip into
// today's visitors. This script narrows that window to the real
// display policy:
//
//   • Visible:     7 days before `starts` → end of `ends` day
//   • LIVE state:  during `starts` → end of `ends` day
//
// Each chip carries data-starts and data-ends (ISO YYYY-MM-DD). The
// script toggles `hidden` and the `is-live` class purely from those.
// No network calls, no dependencies — included as a plain <script>
// on any page that may carry chips (person, project, publications).
(function () {
  var SHOW_LEAD_DAYS = 7;

  function parseDate(s) {
    if (!s) return null;
    var d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  function refresh(now) {
    now = now || new Date();
    var chips = document.querySelectorAll('.event-chip[data-starts]');
    for (var i = 0; i < chips.length; i++) {
      var chip = chips[i];
      var s = parseDate(chip.getAttribute('data-starts'));
      var e = parseDate(chip.getAttribute('data-ends')) || s;
      if (!s) continue;
      // End-of-day for `ends` so the chip stays visible through the
      // full final day rather than flipping off at midnight of the
      // day itself.
      var endOfDay = new Date(e.getTime() + 24 * 60 * 60 * 1000 - 1);
      var showFrom = new Date(s.getTime() - SHOW_LEAD_DAYS * 24 * 60 * 60 * 1000);

      var visible = now >= showFrom && now <= endOfDay;
      var live    = now >= s        && now <= endOfDay;

      if (!visible) {
        chip.hidden = true;
      } else {
        chip.hidden = false;
        chip.classList.toggle('is-live', live);
      }
    }

    // If a chip row ended up with zero visible chips, hide its label
    // and the row container so we don't leave an orphaned "Presenting
    // at" heading with nothing beside it.
    var rows = document.querySelectorAll('[data-event-chip-row]');
    for (var j = 0; j < rows.length; j++) {
      var row = rows[j];
      var anyVisible = row.querySelector('.event-chip:not([hidden])');
      row.style.display = anyVisible ? '' : 'none';
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { refresh(); });
  } else {
    refresh();
  }
  // Re-evaluate hourly in case the page stays open across the
  // start/end boundary (e.g. visitor leaves a tab open overnight).
  setInterval(refresh, 60 * 60 * 1000);
})();