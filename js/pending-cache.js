/**
 * pending-cache.js — local mirror of patches the user has just
 * submitted but whose server-side rows the broker hasn't yet sent
 * back to /my-ahl/.
 *
 * Why this exists:
 *   • After AHLPatch.submit(), the user lands on /my-ahl/. Their
 *     just-submitted project should appear as "Pending review"
 *     immediately — but the canonical list-my-patches roundtrip can
 *     take a few hundred ms (or fail entirely on flaky networks).
 *   • The form payload is in memory at submit time, so we save a
 *     snapshot here. /my-ahl/ reads it on load and renders pending
 *     tiles instantly. When the server response eventually arrives,
 *     myahl-patches.js dedupes against the cache and prunes any
 *     entries the server has already taken responsibility for.
 *
 * Storage:
 *   localStorage["ahl-pending-patches"] = JSON([{
 *     clientId, cachedAt, targetType, action, targetSlug, patch
 *   }])
 *
 *   - clientId: random; gives us a stable handle to remove without
 *     waiting for the server-minted patchId.
 *   - cachedAt: ISO timestamp; entries older than the TTL are
 *     auto-evicted on every read (so a forgotten cache can never
 *     wedge the dashboard with stale tiles forever).
 */
(function () {
  'use strict';

  var KEY = 'ahl-pending-patches';
  var TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  function safeLoad() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function safeSave(arr) {
    try { localStorage.setItem(KEY, JSON.stringify(arr)); }
    catch (e) {}
  }

  function pruneStale(arr) {
    var cutoff = Date.now() - TTL_MS;
    return arr.filter(function (e) {
      var t = Date.parse(e && e.cachedAt || '');
      return !isNaN(t) && t > cutoff;
    });
  }

  function randomId() {
    return 'c-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  function add(entry) {
    var list = pruneStale(safeLoad());
    list.unshift({
      clientId:   randomId(),
      cachedAt:   new Date().toISOString(),
      targetType: entry.targetType || '',
      action:     entry.action     || '',
      targetSlug: entry.targetSlug || '',
      patch:      entry.patch      || {}
    });
    // Cap at 50 entries so a runaway script can't fill localStorage.
    safeSave(list.slice(0, 50));
  }

  function getAll() {
    var list = pruneStale(safeLoad());
    safeSave(list);
    return list;
  }

  // Match a cached entry against the server-returned patch list.
  // Two patches refer to the same submission if:
  //   • Same targetType + same action + same derived/declared slug.
  //   • For "create" actions on items with auto-derived slugs (project,
  //     publication, press), match by slugified title.
  // Heuristic but cheap; false negatives just leave a stale tile
  // until the next page load (TTL eventually evicts).
  function slugify(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }
  function clientSlugFor(entry) {
    if (entry.targetSlug && entry.targetSlug !== '<new>') return entry.targetSlug;
    var p = entry.patch || {};
    return slugify(p.slug || p.title || '');
  }
  function serverSlugFor(serverPatch) {
    if (serverPatch.targetSlug && serverPatch.targetSlug !== '<new>') return serverPatch.targetSlug;
    var p = serverPatch.patch || {};
    return slugify(p.slug || p.title || '');
  }

  function pruneCovered(serverPatches) {
    if (!Array.isArray(serverPatches) || !serverPatches.length) return;
    var list = pruneStale(safeLoad());
    var serverIndex = {};
    serverPatches.forEach(function (sp) {
      var key = (sp.targetType || '') + '|' + (sp.action || '') + '|' + serverSlugFor(sp);
      serverIndex[key] = true;
    });
    var next = list.filter(function (e) {
      var key = e.targetType + '|' + e.action + '|' + clientSlugFor(e);
      return !serverIndex[key];
    });
    if (next.length !== list.length) safeSave(next);
  }

  function removeByClientId(clientId) {
    var list = pruneStale(safeLoad());
    var next = list.filter(function (e) { return e.clientId !== clientId; });
    if (next.length !== list.length) safeSave(next);
  }

  window.AHLPendingCache = {
    add:             add,
    getAll:          getAll,
    pruneCovered:    pruneCovered,
    removeByClientId: removeByClientId
  };
})();
