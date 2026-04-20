/**
 * auth.js — AHLab member login client (v5)
 * =========================================
 *
 * Companion to the Apps Script broker (apps-script/Code.gs).
 *
 * Flow (full-page redirect, OAuth-style)
 *   1. User on /projects/zenflow/ clicks "Member login" in the nav.
 *   2. auth.js stashes { returnPath, nonce } in localStorage and
 *      navigates the WHOLE TAB to
 *        APPS_SCRIPT_URL?return=<callback>&nonce=<nonce>
 *   3. Apps Script reads the user's identity (trusted because the webapp
 *      is Workspace-gated), then redirects back to
 *        <callback>#email=...&name=...&picture=...&nonce=...
 *   4. /auth-callback/ page runs a tiny inline script that:
 *        - parses the hash
 *        - verifies the nonce matches the one in localStorage
 *        - saves the identity to sessionStorage[STORAGE_KEY]
 *        - redirects to the stashed returnPath (or / if none)
 *   5. Browser loads the return page normally. auth.js reads the cached
 *      identity from sessionStorage and renders the avatar + dropdown.
 *
 * Why full-page redirect instead of a popup
 *   v1/v2/v3 all tried popup-based flows and all broke under modern
 *   browser security:
 *     - v1 (postMessage to opener) — blocked by COOP on Apps Script
 *     - v2 (shared localStorage)   — blocked by opener storage partitioning
 *     - v3 (poll popup.location)   — blocked by BCG isolation after COOP
 *   The root issue is that opening any popup to a cross-origin URL now
 *   puts that popup in an isolated Browsing Context Group. Nothing the
 *   two windows can share survives that isolation (except postMessage,
 *   which requires a window.opener that COOP nulls).
 *
 *   Full-page redirect has only one browsing context for the entire flow.
 *   No cross-window coordination, no storage partitioning, no COOP.
 *   This is how production OAuth integrations (Google Sign-In redirect
 *   mode, GitHub OAuth, etc.) have always worked.
 *
 * v5 storage fix
 *   v4 stashed the nonce and return path in sessionStorage, which seemed
 *   correct — sessionStorage persists across same-origin navigations in
 *   the same tab. But sessionStorage is also partitioned by top-level
 *   BrowsingContext ID, and browsers can swap the BrowsingContext during
 *   a cross-origin navigation (process isolation). Result: an empty
 *   sessionStorage on return, even in the same tab. v5 stashes those
 *   two values in localStorage instead, which is partitioned only by
 *   origin and survives the round trip. The identity cache stays in
 *   sessionStorage so sessions still die with the tab.
 *
 * Security notes
 *   - The nonce proves the identity hash on /auth-callback/ came from a
 *     real click on this site (and not, say, a URL someone emailed to
 *     the user). Without nonce verification an attacker could craft a
 *     link like https://new.ahlab.org/auth-callback/#email=boss@ahlab.org
 *     and trick users into visiting it to spoof a sign-in.
 *   - Nonces are single-use — deleted immediately after verification.
 *   - Session cache dies with the tab (sessionStorage).
 *   - The cached identity is NOT a credential. Future write endpoints
 *     must re-verify the caller server-side via Session.getActiveUser().
 */

(function () {
  'use strict';

  // ── Configuration ─────────────────────────────────────────────
  // After deploying the Apps Script, paste the /exec URL here.
  // See apps-script/DEPLOY.md.
  var APPS_SCRIPT_URL = 'https://script.google.com/a/macros/ahlab.org/s/AKfycbwHPIr3JR0ZQ9471E1W0KqM-BggXLv8g8wvx0Z3Qwjx2HajD71gBf60CxrJBcrN_51T/exec';

  // The URL on THIS site that Apps Script redirects back to after
  // reading the user's identity. Must be listed verbatim in the
  // ALLOWED_RETURN_URLS array in Code.gs (both sides must agree).
  var CALLBACK_URL = location.origin + '/auth-callback/';

  // Storage keys. Choice of storage is deliberate and important:
  //
  //   STORAGE_KEY — cached identity (the "session"). Lives in
  //     SESSIONSTORAGE so sessions die when the tab closes. Good for
  //     shared machines; prevents a user on a public computer from
  //     leaving themselves signed in by accident.
  //
  //   NONCE_KEY, RETURN_KEY — in-flight state for the login round-trip.
  //     Live in LOCALSTORAGE because sessionStorage is partitioned by
  //     top-level BrowsingContext ID, and cross-origin navigations
  //     (localhost → script.google.com → localhost) can swap the
  //     BrowsingContext, leaving sessionStorage empty on return.
  //     localStorage is only partitioned by origin, so it survives
  //     the round-trip cleanly.
  var STORAGE_KEY = 'ahl-auth-v1';
  var NONCE_KEY   = 'ahl-auth-nonce-v1';
  var RETURN_KEY  = 'ahl-auth-return-v1';


  // ── State ──────────────────────────────────────────────────────
  var currentUser = loadSession();
  var listeners = [];
  var peopleIndex = null;       // lazy-loaded people.json lookup
  var peopleIndexPromise = null;


  // ── Public API ─────────────────────────────────────────────────
  var API = {
    /** Returns the cached identity { email, name, picture, person } or null. */
    getUser: function () { return currentUser; },

    /** Opens the login popup. */
    login: openLoginPopup,

    /** Clears the local session and fires change listeners. */
    logout: function () {
      try { sessionStorage.removeItem(STORAGE_KEY); } catch (e) {}
      currentUser = null;
      fire();
      renderAll();
    },

    /** Subscribe to login/logout. Returns an unsubscribe function. */
    onChange: function (cb) {
      listeners.push(cb);
      // Fire once so subscribers learn current state without polling.
      try { cb(currentUser); } catch (e) {}
      return function () {
        var i = listeners.indexOf(cb);
        if (i !== -1) listeners.splice(i, 1);
      };
    },

    /** Force a re-render of every known auth UI slot on the page. */
    render: renderAll
  };
  window.AHLAuth = API;


  // ── Identity ingestion ─────────────────────────────────────────
  // Called when the popup's URL reveals the signed-in identity.
  // Looks up a matching people.json record, caches everything in
  // sessionStorage, re-renders the UI, fires listeners.
  function ingestIdentity(data) {
    attachPersonRecord(data).then(function (enriched) {
      currentUser = {
        email: enriched.email,
        name: enriched.name || enriched.email,
        picture: enriched.picture || '',
        person: enriched.person || null,
        ts: data.ts || Date.now()
      };
      saveSession(currentUser);
      fire();
      renderAll();
    });
  }


  // ── DOM ready: render any slots already on the page ─────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderAll);
  } else {
    renderAll();
  }

  // nav-include.js injects the nav asynchronously, after fetch+parse.
  // Listen for a custom event the nav can fire once it's in the DOM,
  // and also fall back to a short polling loop for safety.
  document.addEventListener('ahl-nav-ready', renderAll);
  var pollCount = 0;
  var poll = setInterval(function () {
    if (document.querySelector('[data-auth-slot]')) { renderAll(); clearInterval(poll); }
    if (++pollCount > 40) clearInterval(poll); // give up after ~8s
  }, 200);


  // ── Implementation ─────────────────────────────────────────────

  function openLoginPopup() {
    // Despite the function name (kept for API compatibility with earlier
    // versions that used a popup), v4+ performs a FULL-PAGE REDIRECT
    // rather than opening a popup. See the header doc for why.
    //
    // Steps:
    //   1. Stash the current path so we can return here after sign-in.
    //   2. Generate a nonce and stash it. The callback page will verify
    //      the hash it receives carries the same nonce.
    //   3. Navigate the whole tab to the Apps Script URL.

    // About storage choice (v5 fix):
    //   The nonce and return-path must survive a cross-origin redirect
    //   (localhost → script.google.com → localhost). They go into
    //   localStorage because sessionStorage is partitioned by top-level
    //   BrowsingContext ID, and cross-origin navigations can swap the
    //   BrowsingContext — leaving the callback page with an EMPTY
    //   sessionStorage even though it's the same tab. localStorage is
    //   partitioned only by origin and survives the round trip cleanly.
    //
    //   The identity cache (STORAGE_KEY) still uses sessionStorage
    //   because we WANT the session to die when the tab closes — that
    //   isolation is correct for a "session," wrong for in-flight flow
    //   state.

    // (1) Stash return path. Use pathname+search+hash so query strings
    //     and scroll anchors are preserved. If we're already on the
    //     callback itself (shouldn't happen, but defensive), skip to /.
    var returnPath = location.pathname + location.search + location.hash;
    if (returnPath.indexOf('/auth-callback/') === 0) {
      returnPath = '/';
    }
    try { localStorage.setItem(RETURN_KEY, returnPath); }
    catch (e) { /* quota / privacy mode — proceed anyway; /auth-callback/
                    will fall back to '/' if it can't read this */ }

    // (2) Nonce.
    var nonce = generateNonce();
    try { localStorage.setItem(NONCE_KEY, nonce); }
    catch (e) {
      alert('Your browser blocked site storage. Sign-in needs ' +
            'localStorage; please try again in a regular (non-private) window.');
      return;
    }

    // (3) Build the webapp URL and navigate. location.assign (rather than
    //     .href =) makes the navigation show up as a history entry we can
    //     back out of if the user changes their mind.
    var webappUrl = APPS_SCRIPT_URL +
      (APPS_SCRIPT_URL.indexOf('?') === -1 ? '?' : '&') +
      'return=' + encodeURIComponent(CALLBACK_URL) +
      '&nonce=' + encodeURIComponent(nonce);

    location.assign(webappUrl);
    // Nothing after this runs — the tab is navigating away.
  }


  /**
   * Generate an opaque, high-entropy nonce for the login round-trip.
   * Uses crypto.getRandomValues when available (essentially always in
   * modern browsers); falls back to Math.random on ancient ones.
   */
  function generateNonce() {
    try {
      var buf = new Uint8Array(16);
      crypto.getRandomValues(buf);
      return Array.prototype.map.call(buf, function (b) {
        return ('0' + b.toString(16)).slice(-2);
      }).join('');
    } catch (e) {
      return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    }
  }


  function loadSession() {
    try {
      var raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || !parsed.email) return null;
      return parsed;
    } catch (e) { return null; }
  }

  function saveSession(user) {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(user)); }
    catch (e) { /* quota / privacy mode */ }
  }


  /**
   * Given the raw identity from Apps Script, attempt to find the matching
   * record in /people.json and attach it. Non-fatal: if the file can't be
   * loaded or no match exists, the user is still logged in — they simply
   * don't get a "View my profile" link in the dropdown.
   *
   * Match strategy, in order of preference:
   *   1. Exact match on person.email (future-proof; requires schema update)
   *   2. Exact match on person.slug === local-part of email
   *   3. Fuzzy: local-part matches start of name (e.g. "sankha" → "Sankha Cooray")
   *      Only used as a last resort because names collide.
   */
  function attachPersonRecord(data) {
    return loadPeopleIndex().then(function (idx) {
      if (!idx) return data;
      var email = (data.email || '').toLowerCase();
      if (!email) return data;
      var local = email.split('@')[0];

      // (1) explicit email field
      if (idx.byEmail[email]) {
        data.person = idx.byEmail[email];
        return data;
      }
      // (2) slug == local-part (e.g. "suranga-nanayakkara")
      if (idx.bySlug[local]) {
        data.person = idx.bySlug[local];
        return data;
      }
      // (2b) dotted local-part → hyphenated slug
      var dotted = local.replace(/\./g, '-');
      if (idx.bySlug[dotted]) {
        data.person = idx.bySlug[dotted];
        return data;
      }
      // (3) fuzzy first-name match — ONLY if exactly one person's slug
      // starts with the local-part. Avoids collisions on common names.
      var candidates = idx.slugs.filter(function (s) {
        return s === local || s.indexOf(local + '-') === 0;
      });
      if (candidates.length === 1) {
        data.person = idx.bySlug[candidates[0]];
      }
      return data;
    }).catch(function () {
      return data;
    });
  }


  function loadPeopleIndex() {
    if (peopleIndex) return Promise.resolve(peopleIndex);
    if (peopleIndexPromise) return peopleIndexPromise;

    // Fetch fallback chain: matches the established site-wide pattern
    // (../data.json → ./data.json → /data.json → CDN).
    var urls = ['/people.json', '/data/people.json'];
    peopleIndexPromise = tryFetch(urls).then(function (arr) {
      if (!Array.isArray(arr)) return null;
      var byEmail = {}, bySlug = {}, slugs = [];
      arr.forEach(function (p) {
        if (!p || !p.slug) return;
        bySlug[p.slug] = p;
        slugs.push(p.slug);
        if (p.email) byEmail[String(p.email).toLowerCase()] = p;
      });
      peopleIndex = { byEmail: byEmail, bySlug: bySlug, slugs: slugs };
      return peopleIndex;
    }).catch(function () { return null; });

    return peopleIndexPromise;
  }

  function tryFetch(urls) {
    var i = 0;
    function next() {
      if (i >= urls.length) return Promise.reject(new Error('all fetch urls failed'));
      return fetch(urls[i++], { cache: 'default' })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('not ok')); })
        .catch(next);
    }
    return next();
  }


  function fire() {
    listeners.slice().forEach(function (cb) {
      try { cb(currentUser); } catch (e) { /* swallow */ }
    });
  }


  // ── Rendering ──────────────────────────────────────────────────
  function renderAll() {
    var slots = document.querySelectorAll('[data-auth-slot]');
    slots.forEach(renderSlot);
  }

  function renderSlot(slot) {
    // Each slot gets one of two UIs depending on auth state. We rebuild
    // the DOM each time rather than toggling — simpler, and these slots
    // are small enough that the thrash doesn't matter.
    slot.innerHTML = '';

    if (!currentUser) {
      slot.appendChild(buildLoginButton(slot));
    } else {
      slot.appendChild(buildProfileInline(slot));
    }
  }

  function buildLoginButton(slot) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ahl-login-btn';
    btn.setAttribute('aria-label', 'Sign in as AHLab member');

    // Profile icon SVG — head + shoulders silhouette. Uses currentColor
    // so it inherits from the button text color and reads cleanly on
    // both the gradient nav and the scrolled/light states.
    btn.innerHTML =
      '<svg class="ahl-login-icon" viewBox="0 0 24 24" width="16" height="16" ' +
      'fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<circle cx="12" cy="8" r="4"/>' +
      '<path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>' +
      '</svg>' +
      '<span class="ahl-login-label">Member login</span>';

    btn.addEventListener('click', function (e) {
      e.preventDefault();
      openLoginPopup();
    });
    return btn;
  }

  /**
   * Build the logged-in UI: avatar button next to a text link.
   *
   * Default state:   [avatar] My AHL         (clicking "My AHL" goes to /my-ahl/)
   * Logout state:    [avatar] Logout         (red; clicking it signs out)
   *
   * Clicking the avatar toggles default → logout. In logout state:
   *   - 5-second timer auto-reverts to default if user doesn't act
   *   - Clicking outside the wrapper also reverts
   *   - Clicking the avatar again reverts (toggle)
   *
   * Both slots (desktop + drawer) use a different render path:
   *   - Desktop: inline avatar + link, compact
   *   - Drawer: single link styled like a drawer grid item, avatar inline
   *     with the text. No logout action in the drawer itself; users tap
   *     through to /my-ahl/ where a logout button is available.
   */
  function buildProfileInline(slot) {
    // Drawer slot gets a completely different layout. Check the parent
    // or the slot's own attribute to decide which variant to render.
    // The drawer slot is inside .nav-drawer; desktop slot is inside
    // .site-nav. Use closest() for a reliable test.
    var isDrawer = slot.getAttribute('data-auth-slot') === 'drawer' ||
                   !!slot.closest('.nav-drawer');

    if (isDrawer) return buildProfileForDrawer(slot);
    return buildProfileForDesktop(slot);
  }


  function buildProfileForDesktop(slot) {
    var wrap = document.createElement('div');
    wrap.className = 'ahl-profile';

    // Layout (left → right in DOM order, matching visual order):
    //   [ My AHL / Logout ]  [ avatar ]
    //
    // Both action labels are in the DOM simultaneously. CSS flips
    // which is visible based on .ahl-profile-logout-visible on the
    // wrapper. They share the same slot so the layout doesn't shift
    // when toggling.

    // "My AHL" link — visible by default, hidden in logout state.
    var myLink = document.createElement('a');
    myLink.href = '/my-ahl/';
    myLink.className = 'ahl-profile-action ahl-profile-action-primary';
    myLink.textContent = 'My AHL';
    wrap.appendChild(myLink);

    // "Logout" button — hidden by default, visible in logout state.
    var logoutBtn = document.createElement('button');
    logoutBtn.type = 'button';
    logoutBtn.className = 'ahl-profile-action ahl-profile-action-logout';
    logoutBtn.textContent = 'Logout';
    logoutBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      API.logout();
    });
    wrap.appendChild(logoutBtn);

    // Avatar button — the only interactive element that toggles state.
    // Comes last in DOM order so it renders on the right visually.
    var trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'ahl-profile-trigger';
    trigger.setAttribute('aria-label',
      'Account actions for ' + currentUser.name + '. Click to toggle sign-out.');
    trigger.appendChild(buildAvatar(currentUser, 32));
    wrap.appendChild(trigger);

    // ── State toggle ───────────────────────────────────────────
    // Toggling the .ahl-profile-logout-visible class swaps which
    // action is shown. A 5-second auto-revert timer is stored on the
    // wrapper so re-clicking cancels and restarts it cleanly.
    var revertTimer = null;

    function setLogoutVisible(visible) {
      wrap.classList.toggle('ahl-profile-logout-visible', visible);
      if (revertTimer) {
        clearTimeout(revertTimer);
        revertTimer = null;
      }
      if (visible) {
        revertTimer = setTimeout(function () {
          wrap.classList.remove('ahl-profile-logout-visible');
          revertTimer = null;
        }, 5000);
      }
    }

    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      setLogoutVisible(!wrap.classList.contains('ahl-profile-logout-visible'));
    });

    // Clicking anywhere outside the wrapper dismisses the logout state
    // back to default. (Same behavior as a dropdown closing on outside
    // click.) Using the capture phase and a once-installed listener
    // keeps this idempotent across renders.
    document.addEventListener('click', function (e) {
      if (wrap.classList.contains('ahl-profile-logout-visible') &&
          !wrap.contains(e.target)) {
        setLogoutVisible(false);
      }
    });

    return wrap;
  }


  function buildProfileForDrawer(slot) {
    // Drawer variant: one link styled like every other drawer grid item,
    // containing the avatar inline with "My AHL" text. Logout lives on
    // the /my-ahl/ page itself — mobile users tap through to it.
    var wrap = document.createElement('div');
    wrap.className = 'ahl-profile-drawer';

    var a = document.createElement('a');
    a.href = '/my-ahl/';
    a.className = 'ahl-profile-drawer-link';

    a.appendChild(buildAvatar(currentUser, 28));

    var label = document.createElement('span');
    label.className = 'ahl-profile-drawer-label';
    label.textContent = 'My AHL';
    a.appendChild(label);

    wrap.appendChild(a);
    return wrap;
  }

  /**
   * Render an avatar img or initials fallback. Wrapped in a span so CSS
   * can size/frame it the same way regardless of which path rendered.
   */
  function buildAvatar(user, px) {
    var el = document.createElement('span');
    el.className = 'ahl-avatar';
    el.style.width = px + 'px';
    el.style.height = px + 'px';
    el.style.fontSize = Math.round(px * 0.42) + 'px';

    if (user.picture) {
      var img = document.createElement('img');
      img.src = user.picture;
      img.alt = '';
      img.referrerPolicy = 'no-referrer'; // Google photos honor this for caching
      // If the picture fails to load (e.g. Google photo URLs sometimes
      // require auth), fall back to initials.
      img.addEventListener('error', function () {
        el.removeChild(img);
        el.textContent = initialsOf(user.name || user.email);
      });
      el.appendChild(img);
    } else {
      el.textContent = initialsOf(user.name || user.email);
    }
    return el;
  }

  function initialsOf(s) {
    if (!s) return '?';
    // Strip the "@domain" if this is an email, then split on non-letters
    // and grab the first char of up to two word tokens.
    var base = String(s).split('@')[0].replace(/[._-]+/g, ' ');
    var parts = base.split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    var a = parts[0].charAt(0);
    var b = parts.length > 1 ? parts[parts.length - 1].charAt(0) : '';
    return (a + b).toUpperCase();
  }

})();