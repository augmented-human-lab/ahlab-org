// harvard-cite.js
// ===============
// Pure parser + matcher for Harvard-style publication citations as
// produced by Google Scholar's "Cite → Harvard" panel.
//
// Two public entry points:
//
//   HarvardCite.parse(citation) → {
//     ok: boolean,
//     authors: [{ surname, initials, raw }],   // in citation order
//     year, month, title, venue, pages,         // best-effort fields
//     reason?: string                           // when ok === false
//   }
//
//   HarvardCite.matchAuthors(parsedAuthors, peopleIndex) → [
//     { input, status, slug?, name?, candidates? }
//   ]
//     where status ∈ "matched-form" | "matched-fuzzy" | "ambiguous" | "unmatched"
//
// peopleIndex shape (one entry per person — built by build-myahl.js):
//   [{ slug, name, surname, firstInitial, citationForms: ["Surname, I.", ...] }]
//
// The parser intentionally targets the canonical Google-Scholar Harvard
// shape:
//
//   Surname, I.[I.] [, Surname, I., ... and Surname, I.], YYYY[, Month].
//   Title. In Venue (pp. X-Y).
//
// Real historical citations in cdn-ahlab-org/data/publications/ are
// messier than this (see survey in PR description), but this module is
// for *new* submissions where the user pastes from Scholar. When the
// input falls outside the canonical shape, parse() returns
// { ok: false, reason }, and the UI surfaces a parse-failed banner so
// the user can paste a clean Harvard form (per Q1 in design review).
//
// Module wrapper: works in the browser (registers window.HarvardCite)
// and in Node (CommonJS export) for build-time tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HarvardCite = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── Normalization helpers ────────────────────────────────────

  // Strip diacritics and lowercase. Used for surname/forename
  // comparisons so "García" matches "Garcia".
  function fold(s) {
    return String(s || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .trim();
  }

  // Canonicalize an initials token: collapse spaces, ensure each
  // letter has a trailing period.
  //   "S. C."  → "S.C."
  //   "S.C"    → "S.C."
  //   "J.-P."  → "J.-P."
  //   "Y.V."   → "Y.V."
  function normalizeInitials(raw) {
    var s = String(raw || '').replace(/\s+/g, '');
    // Insert a period after any uppercase letter not already followed
    // by '.' or '-' (the latter for hyphenated initials like J.-P.).
    s = s.replace(/([A-Z])(?![.\-])/g, '$1.');
    return s;
  }

  // Canonical "Surname, I.I." form used as the citationForms key.
  function canonicalAuthor(surname, initials) {
    return String(surname).trim() + ', ' + normalizeInitials(initials);
  }

  // ── Parser ───────────────────────────────────────────────────

  // Match the year boundary that ends the author block. Captures
  // year and optional month. The lead must be a comma, whitespace, or
  // an opening paren — the paren handles APA-style parenthesized years
  // (e.g. "…, S.C. (2023). Title…"). The trail accepts period-or-comma
  // (with optional closing paren) followed by whitespace; comma
  // trailing covers citations like "…, 2014, Birdie: …" where the
  // title follows a comma.
  //   ", 2023. "
  //   " 2023. "
  //   ", 2023a. "
  //   ", 2026, April. "
  //   ", 2014, Title…"
  //   " (2023). "
  var YEAR_BOUNDARY = /[\s,(]\s*((?:19|20)\d{2})([a-z])?(?:,\s+([A-Z][a-z]+))?\)?[.,]\s+/;

  // Single token classifier — returns "initials" if the whole token
  // looks like an initials cluster, else "surname".
  //   "Q."        → initials
  //   "S.C."      → initials
  //   "S. C."     → initials (after we collapse internal whitespace)
  //   "J.-P."     → initials
  //   "van der Berg" → surname
  //   "O'Brien"   → surname
  //   "García-Márquez" → surname
  function classifyToken(tok) {
    var t = String(tok).trim();
    if (!t) return 'empty';
    var collapsed = t.replace(/\s+/g, '');
    // initials: 1+ uppercase letters each separated by '.' or '-',
    // with a trailing period optional. Allows "J.-P." (hyphenated) and
    // "S.C." (run-on). Strict pattern — try this first.
    if (/^[A-Z](?:[.\-]+[A-Z])*\.?$/.test(collapsed)) return 'initials';
    // surname: starts with a (Unicode) letter — allow lowercase
    // particles like "van" — then any letters / spaces / hyphens /
    // apostrophes / periods. Periods admit suffixes like "Jr." which
    // get split off as part of the surname token after the comma split.
    if (/^[\p{L}][\p{L}'\-\s.]*$/u.test(t)) return 'surname';
    return 'other';
  }

  // Split the author block into [surname, initials] pairs.
  // Returns null if the structure doesn't tokenize cleanly.
  function tokenizeAuthors(block) {
    if (!block) return null;

    // Normalize separators: turn final "and"/"&" into a comma so we
    // can split uniformly. Handles "X, Y and Z", "X, Y, and Z" (Oxford
    // comma), and "X, Y & Z".
    var normalized = block
      .replace(/,\s+&\s+/g, ', ')
      .replace(/\s+&\s+/g, ', ')
      .replace(/,\s+and\s+/gi, ', ')
      .replace(/\s+and\s+/gi, ', ');

    var tokens = normalized.split(/,\s+/).map(function (t) { return t.trim(); }).filter(Boolean);
    if (!tokens.length) return null;

    var pairs = [];
    var i = 0;
    while (i < tokens.length) {
      var surnameTok = tokens[i];
      var initialsTok = tokens[i + 1];
      if (classifyToken(surnameTok) !== 'surname') return null;
      if (!initialsTok || classifyToken(initialsTok) !== 'initials') return null;
      pairs.push({
        surname: surnameTok,
        initials: normalizeInitials(initialsTok),
        raw: canonicalAuthor(surnameTok, initialsTok)
      });
      i += 2;
    }
    return pairs;
  }

  // Best-effort title / venue / pages extraction from the post-year
  // remainder: "Title. In Venue (pp. 1-15)." — none of these are
  // load-bearing for the matcher, but we surface them in the preview.
  function parseRemainder(rest) {
    var out = { title: '', venue: '', pages: '' };
    if (!rest) return out;
    var s = String(rest).trim().replace(/\s+/g, ' ');

    // Pages: "(pp. 1-15)" or "(pp. 1)" — strip when found.
    var pagesMatch = s.match(/\(pp?\.?\s*([\d\-–,\s]+)\)/i);
    if (pagesMatch) {
      out.pages = pagesMatch[1].trim();
      s = s.replace(pagesMatch[0], '').trim();
    }

    // Split title from venue at the first ". In " — Scholar's standard
    // separator. Fall back to the first sentence as the title if there's
    // no "In " marker (journal articles, technical reports).
    var inIdx = s.search(/\.\s+In\s+/);
    if (inIdx !== -1) {
      out.title = s.slice(0, inIdx).trim();
      out.venue = s.slice(inIdx).replace(/^\.\s+In\s+/, '').replace(/\.\s*$/, '').trim();
    } else {
      var firstStop = s.search(/\.\s/);
      if (firstStop !== -1) {
        out.title = s.slice(0, firstStop).trim();
        out.venue = s.slice(firstStop + 1).replace(/\.\s*$/, '').trim();
      } else {
        out.title = s.replace(/\.\s*$/, '').trim();
      }
    }
    return out;
  }

  function parse(citation) {
    var input = String(citation || '').trim().replace(/\s+/g, ' ');
    if (!input) return { ok: false, reason: 'Empty citation.' };

    // Pre-clean: strip corresponding-author asterisks ("S*.", "C.*")
    // and the "eds." editor marker before the year. Both are common in
    // pasted citations and don't affect the underlying author identity.
    input = input.replace(/\*/g, '').replace(/\s+eds\.\s+/i, ' ');

    var m = input.match(YEAR_BOUNDARY);
    if (!m) {
      return {
        ok: false,
        reason: 'Could not find a year (expected "…, YYYY." after the author list). Paste the Harvard form from Google Scholar.'
      };
    }

    var authorBlock = input.slice(0, m.index).trim();
    var rest = input.slice(m.index + m[0].length);

    var authors = tokenizeAuthors(authorBlock);
    if (!authors || !authors.length) {
      return {
        ok: false,
        reason: 'Could not parse authors. Each author should look like "Surname, I." separated by commas, with "and" before the last.'
      };
    }

    var rem = parseRemainder(rest);

    return {
      ok: true,
      authors: authors,
      year: m[1] + (m[2] || ''),
      month: m[3] || '',
      title: rem.title,
      venue: rem.venue,
      pages: rem.pages
    };
  }

  // ── Matcher ──────────────────────────────────────────────────

  // Build a fast lookup index from the people-citations data the
  // build step emits. Two maps:
  //   formMap:    canonicalForm (folded) → [slug]
  //   surnameMap: surnameFolded → [{ slug, firstInitial }]
  function buildIndex(peopleIndex) {
    var formMap = {};
    var surnameMap = {};
    (peopleIndex || []).forEach(function (p) {
      if (!p || !p.slug) return;
      var sf = fold(p.surname || '');
      if (sf) {
        if (!surnameMap[sf]) surnameMap[sf] = [];
        surnameMap[sf].push({
          slug: p.slug,
          name: p.name || '',
          firstInitial: String(p.firstInitial || '').toUpperCase().replace(/\./g, '')
        });
      }
      (p.citationForms || []).forEach(function (form) {
        var key = fold(form).replace(/\.$/, '');
        if (!key) return;
        if (!formMap[key]) formMap[key] = [];
        formMap[key].push(p.slug);
      });
    });
    return { formMap: formMap, surnameMap: surnameMap };
  }

  function matchAuthors(parsedAuthors, peopleIndex) {
    var idx = buildIndex(peopleIndex);
    return (parsedAuthors || []).map(function (a) {
      // Tier 1: exact citation form (deterministic).
      var formKey = fold(a.raw).replace(/\.$/, '');
      var formHit = idx.formMap[formKey];
      if (formHit && formHit.length === 1) {
        return { input: a, status: 'matched-form', slug: formHit[0] };
      }
      if (formHit && formHit.length > 1) {
        return {
          input: a,
          status: 'ambiguous',
          candidates: formHit.map(function (slug) { return { slug: slug }; })
        };
      }

      // Tier 2: surname + first-initial fuzzy match.
      var surnameHits = idx.surnameMap[fold(a.surname)] || [];
      var firstInit = (a.initials.match(/[A-Z]/) || [''])[0];
      var byInitial = surnameHits.filter(function (h) {
        return h.firstInitial && h.firstInitial[0] === firstInit;
      });
      if (byInitial.length === 1) {
        return {
          input: a,
          status: 'matched-fuzzy',
          slug: byInitial[0].slug,
          name: byInitial[0].name
        };
      }
      if (byInitial.length > 1) {
        return { input: a, status: 'ambiguous', candidates: byInitial };
      }

      // Tier 3: surname only (no first-initial match) — likely an
      // outsider, but offer the surname-mates as "did you mean…"
      // suggestions. Status stays "unmatched" so the chip renders as
      // outsider; the candidates are exposed so the picker can still
      // be opened on click for the rare correct-but-typo case.
      if (surnameHits.length) {
        return { input: a, status: 'unmatched', candidates: surnameHits };
      }
      return { input: a, status: 'unmatched' };
    });
  }

  // Find each parsed author's start/end offset in the original input.
  // Used by the form to wrap mentions with <span> highlights so the
  // user can see which strings were detected as authors.
  //
  // Strategy: walk left-to-right, regex-finding each author from the
  // position after the previous author's match. Permissive on
  // separators (comma optional, whitespace flexible) so initials like
  // "S. C." in the source still match a parsed "S.C." token.
  function findAuthorRanges(input, authors) {
    var src = String(input || '');
    var ranges = [];
    var pos = 0;
    (authors || []).forEach(function (a) {
      var surnameEsc = String(a.surname || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      var initialsLetters = String(a.initials || '').replace(/[^A-Z]/gi, '').split('');
      if (!surnameEsc || !initialsLetters.length) {
        ranges.push(null);
        return;
      }
      // Each initial letter, period optional, separator optional
      // between letters (matches "S.C.", "S. C.", "S C", "S-C", etc.)
      var initialsPattern = initialsLetters
        .map(function (L) { return L + '\\.?'; })
        .join('[\\s.\\-]*');
      var re = new RegExp(surnameEsc + '\\s*,?\\s*' + initialsPattern, 'i');
      var slice = src.substring(pos);
      var m = slice.match(re);
      if (!m) { ranges.push(null); return; }
      var start = pos + m.index;
      var end = start + m[0].length;
      ranges.push({ start: start, end: end });
      pos = end;
    });
    return ranges;
  }

  return {
    parse: parse,
    matchAuthors: matchAuthors,
    findAuthorRanges: findAuthorRanges,
    // Exposed for tests:
    _normalizeInitials: normalizeInitials,
    _classifyToken: classifyToken,
    _tokenizeAuthors: tokenizeAuthors,
    _fold: fold
  };
}));
