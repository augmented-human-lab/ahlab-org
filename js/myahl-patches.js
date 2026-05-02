/**
 * myahl-patches.js — fetches the user's pending patches from the
 * Apps Script broker and renders them as grey "Pending review"
 * overlays on top of the my-ahl dashboard.
 *
 * Two visibility surfaces:
 *
 *   • Patches the user submitted themselves (own projects, own pubs,
 *     own press, own profile edits, etc.)
 *   • Patches another member submitted that include this user in
 *     the proposed people[] (e.g. someone added you to their new
 *     project — you'll see it as Pending in your "My Projects").
 *
 * The broker returns { own: [...], coMember: [...] } as JSON. We
 * dedupe on patchId and slip a pending tile into the right section
 * with a `.is-pending` class so CSS desaturates / overlays it.
 */
(function () {
  'use strict';

  // The /my-ahl/ page builds the dashboard markup asynchronously
  // (auth → fetch JSON → render). We wait for its
  // `myahl:dashboard-rendered` event before touching the DOM.
  // This way the projects grid (and friends) actually exist when we
  // try to insert pending tiles.
  var ranOnce = false;
  function init() {
    if (!window.AHLAuth) return;
    document.addEventListener('myahl:dashboard-rendered', onDashboardReady);
    // If the event already fired before we attached (e.g. dashboard
    // re-renders later via auth state changes), the listener catches
    // future ones; the first render just lands when it lands.
  }

  function onDashboardReady() {
    var cachedRendered = false;
    if (window.AHLPendingCache) {
      var cached = window.AHLPendingCache.getAll();
      if (cached && cached.length) {
        renderFromCache(cached);
        cachedRendered = true;
      }
    }
    var token = window.AHLAuth.getToken();
    if (!token) return;
    var broker = window.AHLAuth.getBrokerUrl();
    var url = broker + (broker.indexOf('?') === -1 ? '?' : '&') +
      'action=list-my-patches&token=' + encodeURIComponent(token);
    // De-dupe across multiple dashboard renders within one tab.
    if (ranOnce) clearCachedTiles();
    ranOnce = true;
    // Apps Script web apps don't honour CORS for fetch(); a
    // cross-origin fetch returns a 302 to the Apps Script login page
    // (since `credentials: 'omit'` strips the user's cookies).
    // JSONP via <script> tag is the only viable read pattern: the tag
    // is allowed cross-origin AND carries cookies, so the broker can
    // identify the user via Session.getActiveUser. Broker emits
    // `<callback>(<json>);` when ?callback=… is present.
    fetchJsonp(url).then(function (data) {
      if (!data || data.error) return;
      // Server has caught up — drop covered entries from the local
      // cache, then clear any cached tiles and re-render from
      // authoritative data.
      var allServer = (data.own || []).concat(data.coMember || []);
      if (window.AHLPendingCache) window.AHLPendingCache.pruneCovered(allServer);
      if (cachedRendered) clearCachedTiles();
      renderPending(data);
    }).catch(function () {});
  }

  // Tiny JSONP loader. Generates a unique global callback name,
  // injects a <script src="…&callback=cb">, resolves with whatever
  // the script invokes the callback with. Cleans up + times out at
  // 15s so a missing/blocked response doesn't leak globals forever.
  var _jsonpSeq = 0;
  function fetchJsonp(url) {
    return new Promise(function (resolve, reject) {
      var cb = '__ahlp_jsonp_' + (++_jsonpSeq) + '_' + Date.now().toString(36);
      var script = document.createElement('script');
      var timer;
      function cleanup() {
        try { delete window[cb]; } catch (e) { window[cb] = undefined; }
        if (script && script.parentNode) script.parentNode.removeChild(script);
        clearTimeout(timer);
      }
      window[cb] = function (data) { cleanup(); resolve(data); };
      script.onerror = function () { cleanup(); reject(new Error('JSONP load failed')); };
      script.src = url + (url.indexOf('?') === -1 ? '?' : '&') + 'callback=' + cb;
      document.head.appendChild(script);
      timer = setTimeout(function () {
        if (window[cb]) { cleanup(); reject(new Error('JSONP timeout')); }
      }, 15000);
    });
  }

  // Re-shape cached entries to look like the server response, so we
  // can reuse renderPending without branching everywhere.
  function renderFromCache(entries) {
    var asServerShape = entries.map(function (e) {
      return {
        patchId:     e.clientId,            // synthetic id; collisions with server impossible
        targetType:  e.targetType,
        targetSlug:  e.targetSlug,
        action:      e.action,
        submittedAt: e.cachedAt,
        patch:       e.patch || {},
        _fromCache:  true                   // marker so we can find/clear later
      };
    });
    renderPending({ own: asServerShape, coMember: [] });
  }

  function clearCachedTiles() {
    Array.prototype.forEach.call(
      document.querySelectorAll('[data-pending-from-cache]'),
      function (el) { el.remove(); }
    );
    // Also clear the profile-pending badge if it was added by cache.
    var profileTile = document.querySelector('.myahl-profile-tile.is-pending[data-pending-from-cache]');
    if (profileTile) profileTile.classList.remove('is-pending');
  }

  function renderPending(data) {
    var allPatches = (data.own || []).concat(data.coMember || []);
    if (!allPatches.length) return;

    // Group by section.
    var byType = { project: [], publication: [], press: [], profile: [] };
    var seen = {};
    allPatches.forEach(function (p) {
      if (seen[p.patchId]) return;
      seen[p.patchId] = true;
      if (byType[p.targetType]) byType[p.targetType].push(p);
    });

    // Insert into each section (project / publication / press) at
    // position 1 — right after the "+ Add new" tile.
    insertPendingProjects(byType.project);
    insertPendingPublications(byType.publication);
    insertPendingPress(byType.press);
    flagPendingProfile(byType.profile);
  }

  function tagCacheOrigin(el, p) {
    if (p && p._fromCache) el.setAttribute('data-pending-from-cache', '');
  }

  function insertPendingProjects(patches) {
    if (!patches.length) return;
    var grid = document.querySelector('.myahl-projects-grid');
    if (!grid) return;
    patches.forEach(function (p) {
      var card = document.createElement('div');
      card.className = 'myahl-project-wrap is-pending';
      card.title = 'Pending review — submitted ' + (p.submittedAt || '');
      var title = (p.patch && p.patch.title) || p.targetSlug || 'New project';
      card.innerHTML =
        '<div class="myahl-project-card is-pending">' +
          '<div class="myahl-project-thumb"><div class="myahl-project-thumb-placeholder">' +
            escHtml(title.charAt(0)) + '</div></div>' +
          '<div class="myahl-project-body">' +
            '<h5>' + escHtml(title) + '</h5>' +
          '</div>' +
        '</div>' +
        '<div class="myahl-pending-badge">Pending</div>';
      tagCacheOrigin(card, p);
      var addnew = grid.querySelector('.myahl-addnew-project');
      if (addnew && addnew.nextSibling) {
        grid.insertBefore(card, addnew.nextSibling);
      } else {
        grid.appendChild(card);
      }
    });
  }

  function insertPendingPublications(patches) {
    if (!patches.length) return;
    var list = document.querySelector('.myahl-pub-list');
    if (!list) return;
    patches.forEach(function (p) {
      var li = document.createElement('li');
      li.className = 'myahl-pub-item is-pending';
      li.title = 'Pending review';
      var title = (p.patch && p.patch.title) || 'New publication';
      var citation = (p.patch && p.patch.citation) || '';
      li.innerHTML =
        '<div class="myahl-pub-pending-badge">Pending</div>' +
        '<div class="myahl-pub-title">' + escHtml(title) + '</div>' +
        (citation ? '<div class="myahl-pub-citation">' + escHtml(citation) + '</div>' : '');
      tagCacheOrigin(li, p);
      var addnew = list.querySelector('.myahl-addnew-pub');
      if (addnew && addnew.parentNode && addnew.parentNode.nextSibling) {
        list.insertBefore(li, addnew.parentNode.nextSibling);
      } else {
        list.appendChild(li);
      }
    });
  }

  function insertPendingPress(patches) {
    if (!patches.length) return;
    var grid = document.querySelectorAll('.myahl-tile-grid')[1]; // second tile-grid is press; first is events
    if (!grid) return;
    patches.forEach(function (p) {
      var div = document.createElement('div');
      div.className = 'myahl-tile is-pending';
      div.title = 'Pending review';
      var title = (p.patch && p.patch.title) || 'New press mention';
      var meta = [(p.patch && p.patch.outlet), (p.patch && p.patch.year)].filter(Boolean).join(' · ');
      div.innerHTML =
        '<div class="myahl-tile-icon news"><svg aria-hidden="true"><use href="#i-myahl-news"/></svg></div>' +
        '<div class="myahl-tile-body">' +
          '<div class="myahl-tile-title">' + escHtml(title) + '</div>' +
          (meta ? '<div class="myahl-tile-meta">' + escHtml(meta) + '</div>' : '') +
        '</div>' +
        '<div class="myahl-tile-pending-badge">Pending</div>';
      tagCacheOrigin(div, p);
      var addnew = grid.querySelector('.myahl-addnew-tile');
      if (addnew && addnew.nextSibling) {
        grid.insertBefore(div, addnew.nextSibling);
      } else {
        grid.appendChild(div);
      }
    });
  }

  function flagPendingProfile(patches) {
    if (!patches.length) return;
    var tile = document.querySelector('.myahl-profile-tile');
    if (!tile) return;
    tile.classList.add('is-pending');
    if (patches[0] && patches[0]._fromCache) tile.setAttribute('data-pending-from-cache', '');
    var info = tile.querySelector('.myahl-profile-info');
    if (info && !info.querySelector('.myahl-profile-pending-badge')) {
      var badge = document.createElement('div');
      badge.className = 'myahl-profile-pending-badge';
      badge.textContent = 'Profile edit pending review';
      info.appendChild(badge);
    }
  }

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
