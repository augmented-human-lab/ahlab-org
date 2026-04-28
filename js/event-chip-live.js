// event-chip-live.js
// ==================
// Runtime visibility refresher for time-bounded event UI:
//
//   • .event-chip      — small inline pills on person/project/
//                        publication detail pages. Window: 7 days
//                        before `starts` → end of `ends` day. Adds
//                        `is-live` class while the event is in progress.
//   • .event-row       — cards in the home-page events strip. Window:
//                        STRIP_LEAD_DAYS before `starts` → end of
//                        `ends` + STRIP_TRAIL_DAYS day. Keep these
//                        constants in sync with build-pages.js.
//
// The build step emits these elements inside a slightly generous
// window so a site built "yesterday" still carries the right items
// into today's visitors. This script narrows them to the real
// runtime policy and toggles `hidden` purely from data-starts /
// data-ends. No network calls, no dependencies.
(function () {
  var DAY = 24 * 60 * 60 * 1000;
  var CHIP_LEAD_DAYS  = 7;
  var STRIP_LEAD_DAYS  = 7;
  var STRIP_TRAIL_DAYS = 7;

  function parseDate(s) {
    if (!s) return null;
    var d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  function refresh(now) {
    now = now || new Date();

    // ── Chips ──────────────────────────────────────────────
    var chips = document.querySelectorAll('.event-chip[data-starts]');
    for (var i = 0; i < chips.length; i++) {
      var chip = chips[i];
      var cs = parseDate(chip.getAttribute('data-starts'));
      var ce = parseDate(chip.getAttribute('data-ends')) || cs;
      if (!cs) continue;
      // End-of-day for `ends` so the chip stays visible through the
      // full final day rather than flipping off at midnight of the
      // day itself.
      var chipEnd   = new Date(ce.getTime() + DAY - 1);
      var chipStart = new Date(cs.getTime() - CHIP_LEAD_DAYS * DAY);
      var chipVisible = now >= chipStart && now <= chipEnd;
      var chipLive    = now >= cs        && now <= chipEnd;
      if (!chipVisible) {
        chip.hidden = true;
      } else {
        chip.hidden = false;
        chip.classList.toggle('is-live', chipLive);
      }
    }

    // If a chip row ended up with zero visible chips, hide its label
    // and the row container so we don't leave an orphaned "Presenting
    // at" heading with nothing beside it.
    var chipRows = document.querySelectorAll('[data-event-chip-row]');
    for (var j = 0; j < chipRows.length; j++) {
      var crow = chipRows[j];
      var anyChipVisible = crow.querySelector('.event-chip:not([hidden])');
      crow.style.display = anyChipVisible ? '' : 'none';
    }

    // ── Home-strip event rows ──────────────────────────────
    var rows = document.querySelectorAll('.event-row[data-starts]');
    for (var k = 0; k < rows.length; k++) {
      var row = rows[k];
      var rs = parseDate(row.getAttribute('data-starts'));
      var re = parseDate(row.getAttribute('data-ends')) || rs;
      if (!rs) continue;
      var rowStart = new Date(rs.getTime() - STRIP_LEAD_DAYS * DAY);
      var rowEnd   = new Date(re.getTime() + (STRIP_TRAIL_DAYS + 1) * DAY - 1);
      row.hidden = !(now >= rowStart && now <= rowEnd);
    }

    // Hide the whole "Recent & upcoming events" section (header
    // included) when no rows are visible. Covers both the
    // build-empty case (no rows at all) and the runtime-empty case
    // (build had rows but they all aged out before the visitor
    // loaded the page).
    var section = document.querySelector('.events-feed-section');
    if (section) {
      var anyRowVisible = section.querySelector('.event-row:not([hidden])');
      section.hidden = !anyRowVisible;
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