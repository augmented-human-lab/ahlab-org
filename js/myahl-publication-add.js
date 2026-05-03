/**
 * myahl-publication-add.js — inline expand-in-place form for adding
 * a publication from /my-ahl/.
 *
 * Wiring:
 *   The /my-ahl/ dashboard render dispatches `myahl:dashboard-rendered`;
 *   this module listens and mounts a click handler on every
 *   [data-myahl-addpub-trigger] button it finds. On click the original
 *   <li> is replaced with an editable card.
 *
 * UX contract:
 *   • single textarea — paste a Google-Scholar Harvard citation.
 *   • live-parses via HarvardCite.parse + matchAuthors. Successful
 *     parse hides the textarea (the preview is the form's source of
 *     truth from then on).
 *   • author names that resolve to a lab person are rendered inline
 *     as purple <a> links to /people/<slug>/ (open in new tab).
 *     Authors that don't resolve are shown with a faint dotted
 *     underline and are non-interactive — outsiders are recorded but
 *     don't get tagged.
 *   • optional award + links (doi/pdf) under a disclosure.
 *   • submit allowed when: parse OK AND submitter is among the
 *     auto-matched authors. Broker re-validates.
 *
 * Patch payload (consumed by submit.js validatePublicationPatch_):
 *   {
 *     citation,                       // raw paste; broker re-extracts
 *     title, year,                    // client extracts as a hint
 *     award?, links?,                 // [{label, url}]
 *     authorSlugs:         [string],  // in citation order, dedup'd
 *     citationFormUpdates: { [slug]: "Surname, I." }
 *                                     // new fuzzy forms learned in
 *                                     // this submission, applied to
 *                                     // people records on approval
 *   }
 *
 * Submitter constraint is enforced client-side as a UX guardrail; the
 * broker enforces it for real (it knows the submitter's slug from the
 * auth token, not from this payload).
 */
(function () {
  'use strict';

  var INDEX_URL = '/data/people-citations-index.json';
  var PROJECTS_INDEX_URL = '/data/projects-index.json';
  var DEBOUNCE_MS = 180;
  var DOI_DEBOUNCE_MS = 400;
  // Hard cap on the raw PDF — base64 inflates by ~33%, so 15 MB gives
  // ~20 MB form payload, well under the Apps Script POST limit.
  var PDF_MAX_BYTES = 15 * 1024 * 1024;

  // Auto-approval eligibility rule — submissions that satisfy all five
  // can be merged without manual review:
  //   1. submitter appears as an author of the citation,
  //   2. the lab PI is also an author,
  //   3. publication year >= AHL's founding year,
  //   4. the citation resolves to a real DOI on CrossRef,
  //   5. the submitter was an AHL member (any role) during the
  //      publication year — guards against ex-members claiming work
  //      done elsewhere, or people pre-dating their stint.
  // The broker will re-check these server-side before actually
  // skipping review.
  var PI_SLUG = 'suranga-nanayakkara';
  var AHL_START_YEAR = 2011;

  // CrossRef API. CORS is enabled. Including a contact email in the
  // User-Agent earns us their "polite pool" — better latency, less
  // rate-limiting (see api.crossref.org/swagger-ui).
  var CROSSREF_API = 'https://api.crossref.org/works';
  var CROSSREF_UA = 'AHLab-Pubs (+https://ahlab.org; mailto:web@ahlab.org)';

  var indexPromise = null;
  function loadIndex() {
    if (indexPromise) return indexPromise;
    indexPromise = fetch(INDEX_URL, { cache: 'default' })
      .then(function (r) { return r.ok ? r.json() : []; })
      .catch(function () { return []; });
    return indexPromise;
  }

  var projectsPromise = null;
  function loadProjectsIndex() {
    if (projectsPromise) return projectsPromise;
    projectsPromise = fetch(PROJECTS_INDEX_URL, { cache: 'default' })
      .then(function (r) { return r.ok ? r.json() : []; })
      .catch(function () { return []; });
    return projectsPromise;
  }

  // ── DOI lookup / validate (CrossRef) ────────────────────────
  // Extract a bare DOI from any user input — accepts both
  // "10.1145/foo.bar" and "https://doi.org/10.1145/foo.bar".
  // Returns null if nothing DOI-shaped is in the string.
  function extractDOI(input) {
    var m = String(input || '').match(/\b10\.\d{4,9}\/[^\s"']+/i);
    return m ? m[0].replace(/[.,)]+$/, '') : null;
  }

  // Look up a DOI by title (+ first author surname + year). Returns
  // a DOI string if a confidently-matching record is found, else null.
  // The "confidently" check is a token-overlap heuristic — CrossRef's
  // top result is sometimes loosely related, so we drop matches that
  // share fewer than ~half their leading title tokens with our input.
  function lookupDOIByTitle(title, surname, year) {
    if (!title || title.length < 6) return Promise.resolve(null);
    var qs = '?query.title=' + encodeURIComponent(title.slice(0, 200)) +
      (surname ? '&query.author=' + encodeURIComponent(surname) : '') +
      (year   ? '&filter=from-pub-date:' + year + ',until-pub-date:' + year : '') +
      '&rows=1&select=DOI,title';
    return fetch(CROSSREF_API + qs, { headers: { 'User-Agent': CROSSREF_UA } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var item = j && j.message && j.message.items && j.message.items[0];
        if (!item || !item.DOI) return null;
        var matchedTitle = (item.title && item.title[0]) || '';
        return fuzzyTitleMatch(title, matchedTitle) ? item.DOI : null;
      })
      .catch(function () { return null; });
  }

  // Look up a known DOI in CrossRef and return its title (or null if
  // the DOI doesn't resolve). Caller uses fuzzyTitleMatch to decide
  // whether the DOI corresponds to the publication being added —
  // existence alone isn't enough; the user could paste any random DOI.
  function fetchDOIRecord(doi) {
    if (!doi) return Promise.resolve(null);
    return fetch(CROSSREF_API + '/' + encodeURIComponent(doi), { headers: { 'User-Agent': CROSSREF_UA } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var item = j && j.message;
        if (!item) return null;
        return { doi: doi, title: (item.title && item.title[0]) || '' };
      })
      .catch(function () { return null; });
  }

  function fuzzyTitleMatch(a, b) {
    if (!a || !b) return false;
    function tokens(s) {
      return String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(function (t) { return t.length >= 3; });
    }
    var aw = tokens(a).slice(0, 8);
    var bw = tokens(b).slice(0, 16);
    if (!aw.length) return false;
    var common = aw.filter(function (w) { return bw.indexOf(w) !== -1; });
    return common.length >= Math.min(4, Math.ceil(aw.length / 2));
  }

  // ── Public API ───────────────────────────────────────────────
  function mount(button) {
    if (!button || button.__pubAddMounted) return;
    button.__pubAddMounted = true;
    button.disabled = false;
    button.removeAttribute('title');
    button.addEventListener('click', function (e) {
      e.preventDefault();
      openCard(button);
    });
  }

  // ── Card open / close ────────────────────────────────────────
  function openCard(button) {
    var originalLi = button.closest('li');
    if (!originalLi) return;
    var card = buildCard();
    originalLi.replaceWith(card.li);
    var session = {
      el:        card,
      parsed:    null,
      matches:   [],          // matchAuthors() output, parallel to parsed.authors
      peopleIdx: [],
      submitter: getSubmitterSlug(),
      // DOI state — `key` is what we already looked up so reparses
      // don't refetch when only chip state changes; `status` ∈
      // 'idle' | 'searching' | 'found' | 'not-found'. `match` is
      // only meaningful when status='found' — true if the DOI's
      // CrossRef title fuzzy-matches the parsed citation title.
      doi: { value: '', status: 'idle', match: false, key: '' },
      // PDF state — populated by the file picker. dataB64 is read
      // lazily (we only encode once on submit, not at pick time, to
      // keep the form responsive on large files).
      pdf: null,   // null | { name, size, file }
      // Project tags — list of {slug, title} the user has picked from
      // the projects-index. Sent on submit as patch.projectSlugs[].
      projects:    [],
      projectsIdx: [],
      // Awards — multi-string. Each entry is one chip in the meta row.
      awards:      []
    };
    loadIndex().then(function (idx) {
      session.peopleIdx = idx || [];
      reparse(session);
    });
    loadProjectsIndex().then(function (idx) {
      session.projectsIdx = idx || [];
    });

    card.textarea.addEventListener('input', debounce(function () { reparse(session); }, DEBOUNCE_MS));
    card.cancel.addEventListener('click', function () { card.li.replaceWith(originalLi); });
    card.submit.addEventListener('click', function () { submit(session); });
    card.pdfPick.addEventListener('click', function () { card.pdfInput.click(); });
    card.pdfInput.addEventListener('change', function (e) { onPdfPicked(session, e.target.files && e.target.files[0]); });
    card.pdfClear.addEventListener('click', function () { clearPdf(session); });

    // DOI manual-entry handlers. The auto-search still runs in the
    // background; user input always wins (we set a sentinel `key` on
    // the session so a late auto-result doesn't overwrite a manual
    // value).
    card.doiAdd.addEventListener('click', function () { enterDoiEdit(session); });
    card.doiFound.addEventListener('click', function () { enterDoiEdit(session); });
    card.doiFound.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); enterDoiEdit(session); }
    });
    card.doiInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter')      { e.preventDefault(); commitDoiEdit(session); }
      else if (e.key === 'Escape'){ e.preventDefault(); cancelDoiEdit(session); }
    });
    card.doiX.addEventListener('click', function () { cancelDoiEdit(session); });
    card.doiZone.addEventListener('focusout', function (e) {
      if (session._doiOpening) return; // see enterDoiEdit note
      if (e.relatedTarget && card.doiZone.contains(e.relatedTarget)) return;
      if (card.doiZone.dataset.state !== 'editing') return;
      commitDoiEdit(session);
    });

    // Award zone (multi-chip). + Add toggles input; Enter commits a
    // chip; ✕ closes the input; click-outside commits whatever was
    // typed. Each chip has its own remove ✕ handled via delegation.
    card.awardAdd.addEventListener('click', function () { openAwardInput(session); });
    card.awardInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter')      { e.preventDefault(); commitAwardEntry(session); }
      else if (e.key === 'Escape'){ e.preventDefault(); closeAwardInput(session); }
    });
    card.awardX.addEventListener('click', function () { closeAwardInput(session); });
    card.awardZone.addEventListener('focusout', function (e) {
      if (session._awardOpening) return; // see openAwardInput note
      if (e.relatedTarget && card.awardZone.contains(e.relatedTarget)) return;
      if (card.awardEdit.hidden) return;
      commitAwardEntry(session);
    });
    card.awardChips.addEventListener('click', function (e) {
      var x = e.target.closest('[data-remove-award]');
      if (x) removeAward(session, parseInt(x.getAttribute('data-remove-award'), 10));
    });

    // Project picker. Open on click; type to filter; click an item or
    // press Enter on the focused item to add a chip; chips have ✕ to
    // remove. Outside-click closes the picker.
    card.projectAdd.addEventListener('click', function (e) {
      e.stopPropagation();
      openProjectPicker(session);
    });
    card.projectSearch.addEventListener('input', function () { renderProjectList(session); });
    card.projectSearch.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); closeProjectPicker(session); }
      if (e.key === 'Enter')  {
        e.preventDefault();
        var first = card.projectList.querySelector('li[data-slug]');
        if (first) addProjectFromEl(session, first);
      }
    });
    card.projectList.addEventListener('click', function (e) {
      var li = e.target.closest('li[data-slug]');
      if (li) addProjectFromEl(session, li);
    });
    card.projectChips.addEventListener('click', function (e) {
      var x = e.target.closest('[data-remove-project]');
      if (x) removeProject(session, x.getAttribute('data-remove-project'));
    });
    // Outside-click closes the picker. Bound at document level once
    // per card; the listener is no-op when the picker is already
    // hidden, so it's cheap to leave attached.
    document.addEventListener('click', function (e) {
      if (card.projectPicker.hidden) return;
      if (card.projectZone.contains(e.target)) return;
      closeProjectPicker(session);
    });
    setTimeout(function () { card.textarea.focus(); }, 0);
  }

  // ── Parse on every change, refresh preview ──────────────────
  function reparse(session) {
    var raw = session.el.textarea.value;
    var parsed = window.HarvardCite.parse(raw);
    session.parsed = parsed;
    session.matches = parsed.ok
      ? window.HarvardCite.matchAuthors(parsed.authors, session.peopleIdx)
      : [];
    renderPreview(session);
    if (parsed.ok) maybeLookupDOI(session);
  }

  // Fire a CrossRef title lookup once per (title|year) tuple — we
  // don't want to re-query when chip state changes or when the user
  // edits the award field.
  function maybeLookupDOI(session) {
    var title = session.parsed.title || '';
    var year  = session.parsed.year  || '';
    var key   = title + '|' + year;
    if (session.doi.key === key) return;

    session.doi = { value: '', status: 'searching', match: false, key: key };
    renderPreview(session);

    var firstSurname = session.parsed.authors[0] && session.parsed.authors[0].surname;
    lookupDOIByTitle(title, firstSurname, year).then(function (doi) {
      if (session.doi.key !== key) return;  // stale
      // Auto-found via title query — lookupDOIByTitle has already
      // applied fuzzyTitleMatch internally, so a returned DOI is
      // guaranteed to match. Manual entry sets match per-result.
      session.doi = doi
        ? { value: doi, status: 'found',     match: true,  key: key }
        : { value: '',  status: 'not-found', match: false, key: key };
      renderPreview(session);
    });
  }

  // ── DOI manual entry ────────────────────────────────────────
  // Pre-fills the input with whatever DOI we currently know (auto-
  // matched or previously typed) so the user can tweak rather than
  // retype. Stamps a manual-entry sentinel on the session so the
  // background CrossRef title-search can't clobber the user's input.
  function enterDoiEdit(session) {
    var card = session.el;
    // ⚠ Same focusout-race guard as openAwardInput — and same
    // ordering caveat: the flag must be set BEFORE switching the
    // [data-state] face, because doing so hides whichever face had
    // focus and that synchronously dispatches focusout into the zone.
    session._doiOpening = true;
    card.doiInput.value = session.doi.value || '';
    card.doiZone.dataset.state = 'editing';
    setTimeout(function () {
      card.doiInput.focus();
      card.doiInput.select();
      session._doiOpening = false;
    }, 0);
  }

  // Commit a manually-entered DOI. Extract → validate → set state.
  // An invalid DOI returns to "not-found" (eligibility correctly fails);
  // an unparseable string is treated the same.
  //
  // The DOM state is taken OUT of 'editing' explicitly here. Without
  // this, renderDoiStatus's "don't clobber editing state" guard would
  // see dataset.state === 'editing' and refuse to advance the face,
  // leaving the input visible after a commit.
  function commitDoiEdit(session) {
    var card = session.el;
    var raw  = (card.doiInput.value || '').trim();
    var doi  = raw ? extractDOI(raw) : null;
    if (!raw || !doi) {
      // Empty / no DOI shape — fall through to "not-found".
      session.doi = { value: '', status: 'not-found', match: false, key: 'manual' };
      card.doiZone.dataset.state = 'not-found';
      renderPreview(session);
      return;
    }
    session.doi = { value: doi, status: 'searching', match: false, key: 'manual' };
    card.doiZone.dataset.state = 'searching';
    renderPreview(session);
    fetchDOIRecord(doi).then(function (record) {
      // Drop stale results if the user has changed their mind.
      if (session.doi.value !== doi || session.doi.key !== 'manual') return;
      if (!record) {
        session.doi = { value: '', status: 'not-found', match: false, key: 'manual' };
        card.doiZone.dataset.state = 'not-found';
      } else {
        // DOI resolves — but does its title actually match the citation
        // we're adding? A stranger's DOI would resolve too, so we have
        // to verify. If the title fuzzy-matches → eligibility passes;
        // if the DOI exists but the title differs → user gets a clear
        // mismatch warning and eligibility correctly blocks.
        var match = fuzzyTitleMatch(session.parsed.title || '', record.title || '');
        session.doi = { value: doi, status: 'found', match: match, key: 'manual' };
        card.doiZone.dataset.state = 'found';
      }
      renderPreview(session);
    });
  }

  function cancelDoiEdit(session) {
    // Drop edit mode and re-render whatever state we already have.
    var s = session.doi.status;
    var next = (s === 'found') ? 'found' : 'not-found';
    session.el.doiZone.dataset.state = next;
  }

  // ── PDF picker ──────────────────────────────────────────────
  function onPdfPicked(session, file) {
    if (!file) return;
    if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name || '')) {
      alert('Only PDF files are accepted.');
      session.el.pdfInput.value = '';
      return;
    }
    if (file.size > PDF_MAX_BYTES) {
      alert('PDF is ' + formatBytes(file.size) + ' — please attach a file under ' + formatBytes(PDF_MAX_BYTES) + '.');
      session.el.pdfInput.value = '';
      return;
    }
    session.pdf = { name: file.name, size: file.size, file: file };
    renderPreview(session);
  }

  function clearPdf(session) {
    session.pdf = null;
    session.el.pdfInput.value = '';
    renderPreview(session);
  }

  // ── Award multi-chip ────────────────────────────────────────
  // Each entered award is its own chip. Open the input via "+ Add
  // award", type, press Enter (or click outside) → adds to
  // session.awards and re-renders chips. The input clears + stays
  // open so a contributor can quickly add several without re-clicking
  // the button. Empty Enter closes the input. Each chip has a ✕ to
  // remove individually.
  function openAwardInput(session) {
    var card = session.el;
    // ⚠ Set the opening flag BEFORE hiding the Add button. Setting
    // `hidden = true` on a focused element synchronously dispatches
    // blur → focusout, which bubbles to the zone listener. If the
    // flag isn't set yet, the listener will see "not opening" and
    // commit (with empty value) → close everything before our
    // setTimeout(focus) gets to run.
    session._awardOpening = true;
    card.awardEdit.hidden = false;
    card.awardAdd.hidden = true;
    card.awardInput.value = '';
    setTimeout(function () {
      card.awardInput.focus();
      session._awardOpening = false;
    }, 0);
  }
  function closeAwardInput(session) {
    var card = session.el;
    card.awardEdit.hidden = true;
    card.awardAdd.hidden = false;
    card.awardInput.value = '';
  }
  function commitAwardEntry(session) {
    var card = session.el;
    var v = (card.awardInput.value || '').trim();
    if (!v) {
      closeAwardInput(session);
      return;
    }
    // Avoid duplicates — same award name shouldn't be added twice.
    if (session.awards.indexOf(v) === -1) session.awards.push(v);
    renderAwardChips(session);
    // Stay open with cleared input so the user can add another. If
    // they don't, focusout / Escape will close.
    card.awardInput.value = '';
    setTimeout(function () { card.awardInput.focus(); }, 0);
  }
  function removeAward(session, idx) {
    if (idx < 0 || idx >= session.awards.length) return;
    session.awards.splice(idx, 1);
    renderAwardChips(session);
  }
  function renderAwardChips(session) {
    session.el.awardChips.innerHTML = session.awards.map(function (a, i) {
      return '<span class="myahl-pa-award-chip">' +
        svgIcon('award') + ' ' + escHTML(a) +
        ' <button type="button" class="myahl-pa-award-x-chip" data-remove-award="' + i + '" aria-label="Remove ' + escAttr(a) + '">' +
          svgIcon('x') +
        '</button>' +
      '</span>';
    }).join('');
  }

  // Inline SVG icon helper. Mirrors the existing tile-icon pattern in
  // my-ahl.html — references the <symbol> defs inlined at the top of
  // the page. currentColor + stroke-width come from CSS.
  function svgIcon(name) {
    return '<svg class="myahl-pa-icon" aria-hidden="true"><use href="#i-myahl-' + name + '"/></svg>';
  }

  // ── Project picker ──────────────────────────────────────────
  function openProjectPicker(session) {
    var card = session.el;
    card.projectPicker.hidden = false;
    card.projectSearch.value = '';
    renderProjectList(session);
    setTimeout(function () { card.projectSearch.focus(); }, 0);
  }
  function closeProjectPicker(session) {
    session.el.projectPicker.hidden = true;
  }
  function renderProjectList(session) {
    var card = session.el;
    var q = (card.projectSearch.value || '').trim().toLowerCase();
    var taken = {};
    session.projects.forEach(function (p) { taken[p.slug] = true; });
    var matches = session.projectsIdx.filter(function (p) {
      if (taken[p.slug]) return false;
      if (!q) return true;
      return (p.title || '').toLowerCase().indexOf(q) !== -1
          || (p.slug  || '').toLowerCase().indexOf(q) !== -1;
    }).slice(0, 10);
    if (!matches.length) {
      card.projectList.innerHTML = '<li class="myahl-pa-project-empty">No projects match.</li>';
      return;
    }
    card.projectList.innerHTML = matches.map(function (p) {
      return '<li data-slug="' + escAttr(p.slug) + '" data-title="' + escAttr(p.title) + '">' +
        '<span class="myahl-pa-project-li-title">' + escHTML(p.title) + '</span>' +
        (p.year ? '<span class="myahl-pa-project-li-year">' + escHTML(p.year) + '</span>' : '') +
      '</li>';
    }).join('');
  }
  function addProjectFromEl(session, li) {
    var slug  = li.getAttribute('data-slug');
    var title = li.getAttribute('data-title');
    if (!slug || session.projects.some(function (p) { return p.slug === slug; })) return;
    session.projects.push({ slug: slug, title: title });
    renderProjectChips(session);
    closeProjectPicker(session);
  }
  function removeProject(session, slug) {
    session.projects = session.projects.filter(function (p) { return p.slug !== slug; });
    renderProjectChips(session);
  }
  function renderProjectChips(session) {
    session.el.projectChips.innerHTML = session.projects.map(function (p) {
      return '<span class="myahl-pa-project-chip">' +
        svgIcon('project') + ' ' + escHTML(p.title) +
        ' <button type="button" class="myahl-pa-project-x" data-remove-project="' + escAttr(p.slug) + '" aria-label="Remove ' + escAttr(p.title) + '">' +
          svgIcon('x') +
        '</button>' +
      '</span>';
    }).join('');
  }

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function readFileAsBase64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload  = function () {
        // strip "data:<mime>;base64," prefix
        var s = String(reader.result || '');
        var i = s.indexOf(',');
        resolve(i === -1 ? s : s.slice(i + 1));
      };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsDataURL(file);
    });
  }

  function renderPreview(session) {
    var el = session.el;
    var parsed = session.parsed;

    if (!parsed) {
      el.preview.classList.add('is-empty');
      el.li.classList.remove('has-parsed');
      el.previewTitle.textContent = '';
      el.previewCitation.innerHTML = '';
      el.banner.textContent = '';
      el.banner.classList.remove('is-error');
      el.submit.disabled = true;
      el.submitHint.textContent = '';
      el.eligibility.classList.remove('is-shown');
      return;
    }

    if (!parsed.ok) {
      el.preview.classList.add('is-empty');
      el.li.classList.remove('has-parsed');
      el.previewTitle.textContent = '';
      el.previewCitation.innerHTML = '';
      el.banner.textContent = parsed.reason;
      el.banner.classList.add('is-error');
      el.submit.disabled = true;
      el.submitHint.textContent = '';
      el.eligibility.classList.remove('is-shown');
      return;
    }

    el.preview.classList.remove('is-empty');
    // Successful parse — hide the input textarea. To correct a bad
    // paste, the user cancels and re-opens the card.
    el.li.classList.add('has-parsed');
    el.previewTitle.textContent = parsed.title || '(title not detected)';
    el.banner.textContent = '';
    el.banner.classList.remove('is-error');

    var raw = el.textarea.value.trim();
    var authorRanges = window.HarvardCite.findAuthorRanges(raw, parsed.authors);
    el.previewCitation.innerHTML = renderHighlightedCitation(raw, parsed, authorRanges, session);

    el.submit.disabled = !canSubmit(session);
    el.submitHint.textContent = submitHint(session);
    el.eligibility.classList.toggle('is-shown', isEligibleForAutoApproval(session));
    renderDoiStatus(session);
  }

  function renderDoiStatus(session) {
    var el = session.el;
    var parsedOk = session.parsed && session.parsed.ok;

    // Whole meta row hides when there's nothing to show. Once parsed,
    // it always shows — at minimum to expose the "+ Add PDF" button.
    el.metaRow.style.display = parsedOk ? '' : 'none';
    if (!parsedOk) {
      el.pdfStatus.innerHTML = '';
      return;
    }

    // DOI status — drive the zone's [data-state] face. Don't clobber
    // 'editing' state (user is mid-typing) just because we re-rendered
    // for some other reason (e.g., chip flip).
    var s = session.doi;
    var current = el.doiZone.dataset.state;
    if (current !== 'editing') {
      var nextState =
        s.status === 'searching' ? 'searching' :
        s.status === 'found'     ? 'found'     :
        s.status === 'not-found' ? 'not-found' :
        'searching';
      el.doiZone.dataset.state = nextState;
      if (s.status === 'found') {
        el.doiValue.textContent = s.value;
        // is-mismatch flips the found face to a warning style + label.
        // The user can still submit, but eligibility-for-auto-approval
        // is gated on .match — see isEligibleForAutoApproval.
        el.doiFound.classList.toggle('is-mismatch', !s.match);
        el.doiFoundLabel.textContent = s.match
          ? 'DOI verified'
          : 'DOI exists but title differs';
        el.doiFound.title = s.match
          ? 'Click to edit'
          : 'CrossRef knows this DOI but its title doesn\'t match the citation. Click to edit.';
      }
    }

    // PDF status
    if (session.pdf) {
      el.pdfStatus.innerHTML = svgIcon('file') + ' ' + escHTML(session.pdf.name) + ' · ' + formatBytes(session.pdf.size);
      el.pdfStatus.classList.add('is-attached');
      el.pdfPick.style.display = 'none';
      el.pdfClear.style.display = '';
    } else {
      el.pdfStatus.innerHTML = '';
      el.pdfStatus.classList.remove('is-attached');
      el.pdfPick.style.display = '';
      el.pdfClear.style.display = 'none';
    }
  }

  // Render the citation with three layers of inline highlights:
  //   • author mentions  — purple, <a> to /people/<slug>/ if matched,
  //                        outsiders get a faint dotted underline.
  //   • year             — accent-dark purple.
  //   • venue            — cyan (gradient-start theme color).
  // All three highlights are gathered, sorted by position, and emitted
  // in one ordered walk so the spans never overlap.
  function renderHighlightedCitation(text, parsed, authorRanges, session) {
    var spans = [];

    authorRanges.forEach(function (r, i) {
      if (!r) return;
      var match = session.matches[i];
      var slug = match && match.slug;
      spans.push({
        start: r.start, end: r.end, kind: 'author',
        slug: slug || null,
        name: slug ? lookupName(session, slug) : ''
      });
    });

    // Year highlight — every 4-digit year occurrence between the last
    // author and the end of the venue. Standalone year (after authors)
    // AND any year embedded in the venue title (e.g. "Conference 2024")
    // both get the same year style so the conference year reads
    // distinctly from the conference name.
    var lastAuthorEnd = authorRanges.reduce(function (acc, r) {
      return r ? Math.max(acc, r.end) : acc;
    }, 0);

    // Venue — first occurrence after the year (or after authors). Use
    // the parsed venue verbatim; if it's not found (parser tidy-up may
    // have stripped chars), skip the highlight rather than misalign.
    var venueStart = -1, venueEnd = -1;
    if (parsed.venue) {
      var afterYear = (parsed.year && text.indexOf(parsed.year, lastAuthorEnd));
      if (afterYear == null || afterYear < 0) afterYear = lastAuthorEnd;
      venueStart = text.indexOf(parsed.venue, afterYear);
      if (venueStart !== -1) venueEnd = venueStart + parsed.venue.length;
    }

    // Stamp year occurrences. Inside the venue range, splitting the
    // venue around each one happens below in the segment build.
    if (parsed.year) {
      var yIdx = text.indexOf(parsed.year, lastAuthorEnd);
      while (yIdx !== -1) {
        // Stop searching past the venue end; later years are in pages
        // text and shouldn't be highlighted.
        if (venueEnd !== -1 && yIdx >= venueEnd) break;
        spans.push({ start: yIdx, end: yIdx + parsed.year.length, kind: 'year' });
        yIdx = text.indexOf(parsed.year, yIdx + parsed.year.length);
      }
    }

    // Venue — emit as one or more segments split around any year
    // occurrences inside it. This guarantees year and venue spans
    // never overlap, so the renderer's monotonic walk handles them
    // cleanly.
    if (venueStart !== -1) {
      var yearSpansInVenue = spans.filter(function (sp) {
        return sp.kind === 'year' && sp.start >= venueStart && sp.end <= venueEnd;
      }).sort(function (a, b) { return a.start - b.start; });
      var cursor = venueStart;
      yearSpansInVenue.forEach(function (ys) {
        if (ys.start > cursor) spans.push({ start: cursor, end: ys.start, kind: 'venue' });
        cursor = ys.end;
      });
      if (cursor < venueEnd) spans.push({ start: cursor, end: venueEnd, kind: 'venue' });
    }

    spans.sort(function (a, b) { return a.start - b.start; });

    var html = '';
    var cursor = 0;
    spans.forEach(function (s) {
      if (s.start < cursor) return; // overlap — skip safely
      html += escHTML(text.substring(cursor, s.start));
      var fragment = escHTML(text.substring(s.start, s.end));
      if (s.kind === 'author') {
        if (s.slug) {
          var titleAttr = s.name ? ' title="' + escAttr(s.name) + '"' : '';
          html += '<a class="myahl-pa-mention is-tagged" href="/people/' +
            escAttr(s.slug) + '/" target="_blank" rel="noopener"' + titleAttr + '>' +
            fragment + '</a>';
        } else {
          html += '<span class="myahl-pa-mention is-outsider">' + fragment + '</span>';
        }
      } else {
        html += '<span class="myahl-pa-mention is-' + s.kind + '">' + fragment + '</span>';
      }
      cursor = s.end;
    });
    html += escHTML(text.substring(cursor));
    return html;
  }

  function lookupName(session, slug) {
    var p = session.peopleIdx.find(function (x) { return x.slug === slug; });
    return (p && p.name) || '';
  }

  // ── Submit gating ───────────────────────────────────────────
  function tagSlugsInOrder(session) {
    var seen = {};
    var out = [];
    session.matches.forEach(function (m) {
      if (!m.slug) return;
      if (seen[m.slug]) return;
      seen[m.slug] = true;
      out.push(m.slug);
    });
    return out;
  }

  function canSubmit(session) {
    if (!session.parsed || !session.parsed.ok) return false;
    if (!session.submitter) return false;
    return tagSlugsInOrder(session).indexOf(session.submitter) !== -1;
  }

  function submitHint(session) {
    if (!session.parsed || !session.parsed.ok) return '';
    if (!session.submitter) return 'Sign in required to submit.';
    var tagged = tagSlugsInOrder(session);
    if (tagged.indexOf(session.submitter) === -1) {
      return 'Your name wasn\'t auto-detected as an author of this citation. Re-paste with your name in Harvard form.';
    }
    return '';
  }

  // The combined gate from the five conditions at the top of the file.
  // The broker re-checks; this is purely a UX hint.
  function isEligibleForAutoApproval(session) {
    if (!canSubmit(session)) return false;
    var tagged = tagSlugsInOrder(session);
    if (tagged.indexOf(PI_SLUG) === -1) return false;
    var year = parseInt(session.parsed.year, 10);
    if (!year || year < AHL_START_YEAR) return false;
    // DOI must both resolve AND match the parsed citation title.
    // A user could paste a stranger's DOI; existence alone isn't enough.
    if (session.doi.status !== 'found' || !session.doi.match) return false;
    if (!isSubmitterMemberDuring(session, year)) return false;
    return true;
  }

  // Was the submitter an AHL member (any role) at any point during
  // `year`? True iff one of their stints covers it. A stint with
  // end=null is treated as still active. People with no parseable
  // stint data return false — we can't verify, so we don't auto-approve.
  function isSubmitterMemberDuring(session, year) {
    if (!session.submitter || !year) return false;
    var person = session.peopleIdx.find(function (p) { return p.slug === session.submitter; });
    if (!person || !Array.isArray(person.stints) || !person.stints.length) return false;
    return person.stints.some(function (s) {
      var start = s[0], end = s[1];
      return year >= start && (end == null || year <= end);
    });
  }

  // Whenever a person was matched via fuzzy (we observed a new
  // citation form for them in this paper), record it so the broker
  // can append to their citationForms[] on approval. Skip
  // matched-form (we already had the form).
  function citationFormUpdatesFor(session) {
    var out = {};
    session.matches.forEach(function (m) {
      if (!m.slug) return;
      if (m.status === 'matched-form') return;
      var form = m.input && m.input.raw;
      if (!form) return;
      if (!out[m.slug]) out[m.slug] = form;
    });
    return out;
  }

  // ── Submit ───────────────────────────────────────────────────
  function submit(session) {
    if (!canSubmit(session)) return;
    if (!window.AHLPatch) {
      alert('Submit helper not loaded yet — reload the page.');
      return;
    }
    var el = session.el;
    var citation = el.textarea.value.trim();
    // Awards: collect committed chips PLUS any pending text in the
    // input (so a user who typed and clicked Submit without first
    // pressing Enter doesn't lose their input).
    var awards = session.awards.slice();
    var pending = (el.awardInput.value || '').trim();
    if (pending && awards.indexOf(pending) === -1) awards.push(pending);

    // Links built server-side from the verified DOI and (if attached)
    // the staged PDF — the form no longer asks for either as a URL.
    // Send the DOI value through the patch so the broker doesn't need
    // to re-do CrossRef on its side.
    var patch = {
      title:               session.parsed.title || '',
      citation:            citation,
      year:                session.parsed.year || '',
      awards:              awards,
      doi:                 session.doi.status === 'found' ? session.doi.value : '',
      hasPdf:              !!session.pdf,
      authorSlugs:         tagSlugsInOrder(session),
      projectSlugs:        session.projects.map(function (p) { return p.slug; }),
      citationFormUpdates: citationFormUpdatesFor(session)
    };

    el.submit.disabled = true;
    el.submit.textContent = 'Submitting…';

    Promise.resolve(session.pdf ? readFileAsBase64(session.pdf.file) : null)
      .then(function (b64) {
        var files = [];
        if (b64 != null) {
          files.push({
            name:        session.pdf.name,
            contentType: 'application/pdf',
            dataB64:     b64
          });
        }

        if (window.AHLPendingCache) {
          try {
            window.AHLPendingCache.add({
              targetType: 'publication',
              action:     'create',
              targetSlug: '<new>',
              patch:      { title: patch.title, slug: '<new>' }
            });
          } catch (e) { /* quota / privacy */ }
        }

        window.AHLPatch.submit({
          targetType: 'publication',
          targetSlug: '<new>',
          action:     'create',
          patch:      patch,
          files:      files,
          returnUrl:  location.origin + '/my-ahl/'
        });
      })
      .catch(function (err) {
        el.submit.disabled = false;
        el.submit.textContent = 'Submit for review';
        alert('Couldn\'t read the PDF: ' + (err && err.message || err));
      });
  }

  // ── DOM construction ─────────────────────────────────────────
  function buildCard() {
    var li = document.createElement('li');
    li.className = 'myahl-pub-item myahl-pub-item--add';
    li.innerHTML =
      '<div class="myahl-pa-input">' +
        '<textarea class="myahl-pa-textarea" rows="3" placeholder="Paste a Harvard-style citation from Google Scholar — e.g.&#10;Surname, A.B. and Other, C., 2026. Paper title. In Venue (pp. 1-10)."></textarea>' +
        '<div class="myahl-pa-banner" role="status" aria-live="polite"></div>' +
      '</div>' +
      '<div class="myahl-pa-preview is-empty">' +
        '<div class="myahl-pub-title myahl-pa-preview-title"></div>' +
        '<div class="myahl-pub-citation myahl-pa-preview-citation"></div>' +
        // One inline meta row holds DOI status + PDF picker + award zone.
        // All three pieces share the same chip/icon vocabulary so they
        // read as a single strip of metadata, not separate widgets.
        '<div class="myahl-pa-meta-row" style="display:none">' +
          // DOI zone — four faces (searching/found/not-found/editing)
          // toggled via [data-state]. The verified value is editable
          // too: click it to override the CrossRef auto-match.
          '<span class="myahl-pa-doi-zone" data-state="searching" role="status" aria-live="polite">' +
            '<span class="myahl-pa-doi-searching">' +
              svgIcon('link') + ' Verifying DOI…' +
            '</span>' +
            '<span class="myahl-pa-doi-found" tabindex="0" role="button" title="Click to edit">' +
              svgIcon('link') +
              ' <span class="myahl-pa-doi-found-label">DOI verified</span> · ' +
              '<span class="myahl-pa-doi-value"></span>' +
            '</span>' +
            '<button type="button" class="myahl-pa-doi-add">' +
              svgIcon('link') + ' + Add DOI' +
            '</button>' +
            '<span class="myahl-pa-doi-edit">' +
              '<input type="text" class="myahl-pa-doi-input" placeholder="Paste DOI or DOI URL">' +
              '<button type="button" class="myahl-pa-doi-x" title="Cancel" aria-label="Cancel">' +
                svgIcon('x') +
              '</button>' +
            '</span>' +
          '</span>' +
          // PDF picker: empty → "+ Add PDF"; attached → filename · size + ✕
          '<span class="myahl-pa-pdf-status" aria-live="polite"></span>' +
          '<button type="button" class="myahl-pa-pdf-pick">' +
            svgIcon('file') + ' + Add PDF' +
          '</button>' +
          '<button type="button" class="myahl-pa-pdf-clear" style="display:none" title="Remove PDF" aria-label="Remove PDF">' +
            svgIcon('x') +
          '</button>' +
          '<input type="file" class="myahl-pa-pdf-input" accept="application/pdf" hidden>' +
          // Project tag zone — search-and-pick from /data/projects-
          // index.json. Multi-select; chips can be removed individually.
          // Picker is anchored under the "+ Tag project" button.
          '<span class="myahl-pa-project-zone">' +
            '<span class="myahl-pa-project-chips"></span>' +
            '<button type="button" class="myahl-pa-project-add">' +
              svgIcon('project') + ' + Tag project' +
            '</button>' +
            '<div class="myahl-pa-project-picker" hidden>' +
              '<input type="text" class="myahl-pa-project-search" placeholder="Search projects…" autocomplete="off">' +
              '<ul class="myahl-pa-project-list" role="listbox"></ul>' +
            '</div>' +
          '</span>' +
          // Award zone — multi-chip. Each entered award becomes a chip
          // (mirrors the project-tag chip styling). The "+ Add award"
          // button toggles an inline input; Enter commits the typed
          // award into a chip and clears the input for another. Submit
          // collects all chips into patch.awards[].
          '<span class="myahl-pa-award-zone">' +
            '<span class="myahl-pa-award-chips"></span>' +
            '<button type="button" class="myahl-pa-award-add">' +
              svgIcon('award') + ' + Add award' +
            '</button>' +
            '<span class="myahl-pa-award-edit" hidden>' +
              '<input type="text" class="myahl-pa-award-input" maxlength="80" placeholder="e.g. Best Paper Award">' +
              '<button type="button" class="myahl-pa-award-x" title="Cancel" aria-label="Cancel">' +
                svgIcon('x') +
              '</button>' +
            '</span>' +
          '</span>' +
        '</div>' +
      '</div>' +
      '<div class="myahl-pa-actions">' +
        '<span class="myahl-pa-eligibility" aria-live="polite" tabindex="0">' +
          '<span class="myahl-pa-eligibility-icon" aria-hidden="true">✓</span> Eligible for auto approval' +
          '<span class="myahl-pa-eligibility-tip" role="tooltip">' +
            '<span class="myahl-pa-tip-head">Auto-approval requires all of:</span>' +
            '<ol class="myahl-pa-tip-list">' +
              '<li>Submitter (you) is an author of the citation</li>' +
              '<li>The lab PI is also an author</li>' +
              '<li>Publication year is ' + AHL_START_YEAR + ' or later</li>' +
              '<li>The DOI resolves on CrossRef</li>' +
              '<li>You were an AHL member during the publication year</li>' +
            '</ol>' +
            '<span class="myahl-pa-tip-foot">All five are reverified by the broker before merge.</span>' +
          '</span>' +
        '</span>' +
        '<span class="myahl-pa-submit-hint"></span>' +
        '<button type="button" class="myahl-pa-cancel">Cancel</button>' +
        '<button type="button" class="myahl-pa-submit" disabled>Submit for review</button>' +
      '</div>';

    return {
      li:                li,
      textarea:          li.querySelector('.myahl-pa-textarea'),
      banner:            li.querySelector('.myahl-pa-banner'),
      preview:           li.querySelector('.myahl-pa-preview'),
      previewTitle:      li.querySelector('.myahl-pa-preview-title'),
      previewCitation:   li.querySelector('.myahl-pa-preview-citation'),
      metaRow:           li.querySelector('.myahl-pa-meta-row'),
      doiZone:           li.querySelector('.myahl-pa-doi-zone'),
      doiFound:          li.querySelector('.myahl-pa-doi-found'),
      doiValue:          li.querySelector('.myahl-pa-doi-value'),
      doiFoundLabel:     li.querySelector('.myahl-pa-doi-found-label'),
      doiAdd:            li.querySelector('.myahl-pa-doi-add'),
      doiInput:          li.querySelector('.myahl-pa-doi-input'),
      doiX:              li.querySelector('.myahl-pa-doi-x'),
      pdfStatus:         li.querySelector('.myahl-pa-pdf-status'),
      pdfPick:           li.querySelector('.myahl-pa-pdf-pick'),
      pdfClear:          li.querySelector('.myahl-pa-pdf-clear'),
      pdfInput:          li.querySelector('.myahl-pa-pdf-input'),
      awardZone:         li.querySelector('.myahl-pa-award-zone'),
      awardChips:        li.querySelector('.myahl-pa-award-chips'),
      awardAdd:          li.querySelector('.myahl-pa-award-add'),
      awardEdit:         li.querySelector('.myahl-pa-award-edit'),
      awardInput:        li.querySelector('.myahl-pa-award-input'),
      awardX:            li.querySelector('.myahl-pa-award-x'),
      projectZone:       li.querySelector('.myahl-pa-project-zone'),
      projectChips:      li.querySelector('.myahl-pa-project-chips'),
      projectAdd:        li.querySelector('.myahl-pa-project-add'),
      projectPicker:     li.querySelector('.myahl-pa-project-picker'),
      projectSearch:     li.querySelector('.myahl-pa-project-search'),
      projectList:       li.querySelector('.myahl-pa-project-list'),
      cancel:            li.querySelector('.myahl-pa-cancel'),
      submit:            li.querySelector('.myahl-pa-submit'),
      submitHint:        li.querySelector('.myahl-pa-submit-hint'),
      eligibility:       li.querySelector('.myahl-pa-eligibility')
    };
  }

  // ── Helpers ──────────────────────────────────────────────────
  function getSubmitterSlug() {
    var u = window.AHLAuth && window.AHLAuth.getUser && window.AHLAuth.getUser();
    return (u && u.person && u.person.slug) || null;
  }

  function escHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escAttr(s) { return escHTML(s).replace(/"/g, '&quot;'); }

  function debounce(fn, ms) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  // Self-mount on every dashboard render. mount() is idempotent.
  function mountAll(scope) {
    var triggers = (scope || document).querySelectorAll('[data-myahl-addpub-trigger]');
    Array.prototype.forEach.call(triggers, mount);
  }
  document.addEventListener('myahl:dashboard-rendered', function () { mountAll(); });
  if (document.readyState !== 'loading') mountAll();
  else document.addEventListener('DOMContentLoaded', function () { mountAll(); });

  window.AHLPubAdd = { mount: mount };
})();
