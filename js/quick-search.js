// quick-search.js
// =================
// A floating "command-palette"-style filter that materializes when the
// user starts typing alphanumerics anywhere on the page. Used by
// /people/, /publications/, /projects/, /press/.
//
// Two modes (mix-and-match):
//
//   AUTO mode — `items:` is provided.
//     The component toggles `qs-hidden` on each item based on whether
//     its haystack matches the current needle. Pages that already drive
//     their own visibility (e.g. /people/ chips + year + segment) skip
//     this and use MANUAL mode instead.
//
//   MANUAL mode — `onChange:` is provided.
//     The component just owns the palette UI + needle state and calls
//     `onChange` after every keystroke. The page reads
//     `QuickSearch.matches(text)` from inside its own filter function
//     and ANDs the result with its other filters.
//
// Matching is "every needle token is a substring of the (lowercased)
// haystack". Tokens are split on whitespace, so:
//
//   needle "haptic neural" matches "Neural Haptic Devices for Touch"
//   needle "smith j"       matches "Dr. John Smith"
//
// This handles long publication / press titles for free — substring
// search already chunks the title into searchable words, and multi-token
// needles let users type fragments in any order.
//
// The palette UI (markup + CSS) is owned here. CSS lives in theme.css
// under `.quick-search` so every page that loads theme.css gets it.
// The element is created on first open and kept around for re-use.
//
// Keyboard contract:
//   * Any single alphanumeric press anywhere on the page (no modifiers,
//     not inside another input) opens the palette pre-filled with that
//     character.
//   * Esc closes the palette and clears the needle.
//   * Clicks on the rest of the page are intentionally NOT closes —
//     pages have their own filter UIs (year timelines, hero chips) and
//     interacting with those should compose with the search rather
//     than reset it. To dismiss, press Esc or empty the input.
//   * On close, focus is moved off the palette input so the *next*
//     alphanumeric press re-opens it cleanly. This was the bug fix for
//     the original /people/ implementation: without the blur, focus
//     stayed on the (faded-out) input and subsequent typing landed in
//     it silently — filtering the page with no visible UI.
(function (global) {
  'use strict';

  // Single-instance state. The component supports one palette per page;
  // attach() can be called multiple times during a SPA-like flow but in
  // practice each page calls it exactly once.
  const S = {
    palette: null,
    input: null,
    count: null,
    needle: '',
    tokens: [],
    closeTimer: 0,

    // Per-attach config
    items: null,                // Array of {el, haystack} in auto mode
    onChange: null,             // (needle, tokens) => void  (manual mode hook)
    onAfterFilter: null,        // () => void                (auto mode post-pass hook)
    countItems: null,           // () => number              (overrides default count)
    placeholder: 'Type to filter…',
    listenersBound: false,
  };

  // ── Matching ─────────────────────────────────────────────
  function tokenize(s) {
    return s.toLowerCase().trim().split(/\s+/).filter(Boolean);
  }

  // Public matcher — pages in manual mode call this from inside their
  // own filter predicate. Empty needle ⇒ everything matches.
  function matches(text) {
    if (!S.tokens.length) return true;
    const hay = (text || '').toLowerCase();
    for (let i = 0; i < S.tokens.length; i++) {
      if (hay.indexOf(S.tokens[i]) === -1) return false;
    }
    return true;
  }

  // ── Palette UI ───────────────────────────────────────────
  function build() {
    const el = document.createElement('div');
    el.className = 'quick-search';
    el.id = 'quickSearch';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Quick search');
    el.hidden = true;
    el.innerHTML =
      '<svg class="qs-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
        '<circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
        '<line x1="10.4" y1="10.4" x2="14" y2="14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
      '</svg>' +
      '<input type="search" class="qs-input" autocomplete="off" spellcheck="false" aria-label="Quick search">' +
      '<span class="qs-count" aria-live="polite"></span>' +
      '<span class="qs-hint" aria-hidden="true">Esc</span>';
    document.body.appendChild(el);

    S.palette = el;
    S.input   = el.querySelector('.qs-input');
    S.count   = el.querySelector('.qs-count');
    S.input.placeholder = S.placeholder;

    S.input.addEventListener('input', onInput);
  }

  function open(initialChar) {
    if (!S.palette) build();
    S.palette.hidden = false;
    // Force a layout pass before flipping to .is-open so the transition
    // runs from the hidden→shown state instead of being collapsed into
    // a single style commit by the browser.
    void S.palette.offsetHeight;
    S.palette.classList.add('is-open');

    if (typeof initialChar === 'string' && initialChar.length === 1) {
      S.input.value = initialChar;
    }
    S.input.focus();
    try {
      const v = S.input.value;
      S.input.setSelectionRange(v.length, v.length);
    } catch (_) { /* type=search rejects setSelectionRange in some browsers */ }
    onInput();   // sync needle + run filter pass for the seed character
  }

  function close() {
    if (!S.palette) return;
    S.palette.classList.remove('is-open');
    S.input.value = '';
    S.needle = '';
    S.tokens = [];
    // Critical: blur so the *next* alphanumeric keypress lands on the
    // document handler (which re-opens the palette) instead of the now
    // invisible input field.
    S.input.blur();
    runFilter();
    updateCount();
    clearTimeout(S.closeTimer);
    S.closeTimer = setTimeout(() => {
      if (S.palette && !S.palette.classList.contains('is-open')) {
        S.palette.hidden = true;
      }
    }, 220);
  }

  function isOpen() {
    return !!(S.palette && S.palette.classList.contains('is-open'));
  }

  function onInput() {
    S.needle = S.input.value.trim();
    S.tokens = tokenize(S.needle);
    runFilter();
    updateCount();
  }

  // Auto-mode pass: toggle `qs-hidden` on each item based on its
  // pre-extracted haystack. Skipped if the page is in manual mode
  // (no items registered) — the page handles its own toggling via
  // QuickSearch.matches() inside its own predicate.
  function runFilter() {
    if (S.items) {
      for (let i = 0; i < S.items.length; i++) {
        const it = S.items[i];
        it.el.classList.toggle('qs-hidden', !matches(it.haystack));
      }
      if (typeof S.onAfterFilter === 'function') S.onAfterFilter();
    }
    if (typeof S.onChange === 'function') S.onChange(S.needle, S.tokens);
  }

  function updateCount() {
    if (!S.count) return;
    if (!S.needle) { S.count.textContent = ''; return; }
    let n;
    if (typeof S.countItems === 'function') {
      n = S.countItems();
    } else if (S.items) {
      n = 0;
      for (let i = 0; i < S.items.length; i++) {
        if (matches(S.items[i].haystack)) n++;
      }
    } else {
      // No items + no countItems hook → no count display.
      S.count.textContent = '';
      return;
    }
    S.count.textContent = (n === 1) ? '1 match' : (n + ' matches');
  }

  // ── Haystack extraction ──────────────────────────────────
  // `getText` can be:
  //   - a function (el) => string            — fully custom
  //   - a string starting with "data-"       — read that data attribute
  //   - a CSS selector inside the item       — concatenate matched text
  //   - undefined                            — smart default fallback
  function defaultGetText(el) {
    return el.dataset.search
        || el.querySelector('.pub-title, .press-title, .qs-title, h3, h2')?.textContent
        || el.textContent
        || '';
  }

  function makeExtractor(getText) {
    if (typeof getText === 'function') return getText;
    if (typeof getText === 'string') {
      if (getText.indexOf('data-') === 0) {
        const key = getText.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        return el => el.dataset[key] || '';
      }
      // Treat as a selector inside the item.
      return el => Array.from(el.querySelectorAll(getText)).map(n => n.textContent).join(' ');
    }
    return defaultGetText;
  }

  // Desktop-only feature. Mobile users have no physical keyboard to
  // trigger the palette and the floating-overlay UX doesn't fit a
  // small screen, so we suppress the open path entirely below 992px.
  // This matches the codebase's existing desktop/mobile breakpoint
  // (e.g. /people/'s `.hero-summary-right` and the year-nav layout
  // both flip at 991px). Re-checked per-keystroke so resizing a
  // window re-enables the feature without a reload.
  function isMobileViewport() {
    return window.matchMedia('(max-width: 991px)').matches;
  }

  // ── Global key + click handlers (one-time install) ───────
  function bindGlobalListeners() {
    if (S.listenersBound) return;
    S.listenersBound = true;

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        if (isOpen()) {
          e.preventDefault();
          close();
        }
        return;
      }
      // Don't hijack typing in other fields.
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      // If already open, the input owns the keystrokes. We compare
      // against `is-open` (visual state) rather than `hidden` (layout
      // state) because there's a 220ms tail after close() where the
      // element is still in layout but already invisible — during that
      // window the next keystroke should re-open the palette.
      if (isOpen()) return;
      // Browser shortcuts (⌘F, Ctrl+R, Alt+…) stay with the browser.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.length !== 1 || !/^[a-zA-Z0-9]$/.test(e.key)) return;
      // Skip on mobile / narrow viewports — see isMobileViewport().
      if (isMobileViewport()) return;
      e.preventDefault();
      open(e.key);
    });
  }

  // ── Public API ───────────────────────────────────────────
  function attach(opts) {
    opts = opts || {};
    S.placeholder = opts.placeholder || S.placeholder;
    if (S.input) S.input.placeholder = S.placeholder;

    // Auto mode: items + extractor → pre-compute haystacks.
    if (opts.items) {
      const list = (typeof opts.items === 'string')
        ? document.querySelectorAll(opts.items)
        : opts.items;
      const extract = makeExtractor(opts.getText);
      const out = [];
      for (let i = 0; i < list.length; i++) {
        const el = list[i];
        out.push({ el, haystack: (extract(el) || '').toLowerCase().trim() });
      }
      S.items = out;
    } else {
      S.items = null;
    }

    S.onChange      = opts.onChange      || null;
    S.onAfterFilter = opts.onAfterFilter || null;
    S.countItems    = opts.countItems    || null;

    bindGlobalListeners();
  }

  global.QuickSearch = {
    attach,
    matches,
    open,
    close,
    isOpen,
    get needle() { return S.needle; },
    get tokens() { return S.tokens.slice(); },
  };
})(window);
