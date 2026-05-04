/**
 * wallet-card.js — phone-wallet enrollment surface on /my-ahl/.
 * ============================================================
 *
 * Renders one or two buttons next to the existing membership card:
 *   • Google Wallet — works on every platform (web preview on iOS/desktop)
 *   • Apple Wallet  — Apple platforms only (iPhone, iPad, Mac)
 *
 * Flows
 *   Google:  page-load JSONP fetch → `<a href="pay.google.com/.../<jwt>">`
 *            (button is a real link; click goes through immediately)
 *   Apple:   on-click JSONP fetch → broker proxies to Cloud Function →
 *            base64 .pkpass returned in JSON envelope → decode to Blob →
 *            programmatic download. iOS Safari recognises the
 *            application/vnd.apple.pkpass MIME type and opens Wallet.
 *
 * Why pre-fetch Google but on-click for Apple
 *   Google flow signs a small JWT, ~100 ms broker work — cheap to do
 *   on every page load. Apple flow runs through a Cloud Function that
 *   does CMS signing + zip bundling, ~500 ms — only worth doing if the
 *   user actually clicks. Plus the Apple button only appears for Apple
 *   platforms, so the slowest action is also the rarest in aggregate.
 *
 * Privacy
 *   Both URLs/payloads carry member identity. Page never sends them
 *   to a third-party service.
 */
(function () {
  'use strict';

  // /Macintosh/ catches both macOS Safari and Chrome — both let the
  // user open .pkpass via Wallet preview, so it's worth offering.
  var IS_APPLE_PLATFORM = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent || '');

  function init() {
    if (!window.AHLAuth) return;
    document.addEventListener('myahl:dashboard-rendered', onDashboardReady);
  }

  function onDashboardReady() {
    var idCard = document.querySelector('.myahl-idcard');
    if (!idCard) return;

    // Avoid double-mounting if the dashboard re-renders.
    if (document.querySelector('.myahl-wallet-card')) return;

    var token = window.AHLAuth.getToken();
    if (!token) return;

    var card = buildCardSkeleton();
    insertNextToIdCard(idCard, card);

    var broker = window.AHLAuth.getBrokerUrl();

    // ── Google: pre-fetch URL on page load
    var googleUrl = broker + (broker.indexOf('?') === -1 ? '?' : '&') +
      'action=wallet-pass-url&token=' + encodeURIComponent(token);
    fetchJsonp(googleUrl).then(function (data) {
      if (!data || data.error || !data.url) {
        renderSlotError(card, '.myahl-wallet-btn-slot-google',
          (data && data.error) || 'Could not load Google pass.');
        return;
      }
      renderGoogleButton(card, data.url);
    }).catch(function (err) {
      var detail = err && err.message ? ' (' + err.message + ')' : '';
      renderSlotError(card, '.myahl-wallet-btn-slot-google',
        'Google Wallet unavailable' + detail);
    });

    // ── Apple: render button immediately (on-click fetches)
    if (IS_APPLE_PLATFORM) {
      renderAppleButton(card, token, broker);
    } else {
      // Hide the apple slot entirely on non-Apple platforms — keeps
      // the layout tight rather than showing a useless second button.
      var appleSlot = card.querySelector('.myahl-wallet-btn-slot-apple');
      if (appleSlot && appleSlot.parentNode) appleSlot.parentNode.removeChild(appleSlot);
    }
  }

  // ── DOM construction ─────────────────────────────────────────

  function buildCardSkeleton() {
    var card = document.createElement('div');
    card.className = 'myahl-wallet-card is-loading';
    card.innerHTML =
      '<div class="myahl-wallet-text">' +
        '<h3 class="myahl-wallet-title">Add to phone wallet</h3>' +
        '<p class="myahl-wallet-desc">Add this membership card to your phone\'s wallet — handy at conferences and events. Works on Android (Google Wallet) and on iPhone / Mac (Apple Wallet).</p>' +
      '</div>' +
      '<div class="myahl-wallet-btn-stack">' +
        '<div class="myahl-wallet-btn-slot myahl-wallet-btn-slot-apple">' +
          '<div class="myahl-wallet-spinner" role="status" aria-label="Loading"></div>' +
        '</div>' +
        '<div class="myahl-wallet-btn-slot myahl-wallet-btn-slot-google">' +
          '<div class="myahl-wallet-spinner" role="status" aria-label="Loading"></div>' +
        '</div>' +
      '</div>';
    return card;
  }

  function insertNextToIdCard(idCard, card) {
    var headerRow = idCard.closest('.myahl-header-row');
    if (headerRow && headerRow.parentNode) {
      headerRow.parentNode.insertBefore(card, headerRow.nextSibling);
    } else {
      idCard.parentNode.insertBefore(card, idCard.nextSibling);
    }
  }

  function renderGoogleButton(card, url) {
    card.classList.remove('is-loading');
    var slot = card.querySelector('.myahl-wallet-btn-slot-google');
    if (!slot) return;
    slot.innerHTML = '';
    var a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.className = 'myahl-wallet-btn';
    a.setAttribute('aria-label', 'Add card to Google Wallet');
    a.innerHTML =
      '<svg class="myahl-wallet-btn-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
        '<path d="M21 7H5a1 1 0 0 1 0-2h13.5a.75.75 0 0 0 0-1.5H5a2.5 2.5 0 0 0-2.5 2.5v12A2.5 2.5 0 0 0 5 20.5h16a1.5 1.5 0 0 0 1.5-1.5V8.5A1.5 1.5 0 0 0 21 7Zm-3 7.25a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5Z"/>' +
      '</svg>' +
      '<span class="myahl-wallet-btn-text">' +
        '<span class="myahl-wallet-btn-line1">Add to</span>' +
        '<span class="myahl-wallet-btn-line2">Google Wallet</span>' +
      '</span>';
    slot.appendChild(a);
  }

  function renderAppleButton(card, token, broker) {
    card.classList.remove('is-loading');
    var slot = card.querySelector('.myahl-wallet-btn-slot-apple');
    if (!slot) return;
    slot.innerHTML = '';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'myahl-wallet-btn';
    btn.setAttribute('aria-label', 'Add card to Apple Wallet');
    // Ticket-stub glyph — visually distinct from the Google wallet
    // glyph and instantly recognisable as a "pass".
    btn.innerHTML =
      '<svg class="myahl-wallet-btn-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
        '<path d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 0 0-4V7Zm12.5 1a.75.75 0 0 0-1.5 0v8a.75.75 0 0 0 1.5 0V8Z"/>' +
      '</svg>' +
      '<span class="myahl-wallet-btn-text">' +
        '<span class="myahl-wallet-btn-line1">Add to</span>' +
        '<span class="myahl-wallet-btn-line2">Apple Wallet</span>' +
      '</span>';

    btn.addEventListener('click', function () {
      if (btn.classList.contains('is-loading')) return;
      btn.classList.add('is-loading');
      btn.disabled = true;
      var url = broker + (broker.indexOf('?') === -1 ? '?' : '&') +
        'action=apple-pass&token=' + encodeURIComponent(token);
      fetchJsonp(url).then(function (data) {
        btn.classList.remove('is-loading');
        btn.disabled = false;
        if (!data || data.error || !data.pkpass) {
          alert('Could not generate Apple pass: ' + ((data && data.error) || 'unknown error'));
          return;
        }
        triggerPkpassDownload(data.pkpass, data.filename || 'ahl_member.pkpass');
      }).catch(function (err) {
        btn.classList.remove('is-loading');
        btn.disabled = false;
        var detail = err && err.message ? ' (' + err.message + ')' : '';
        alert('Apple Wallet unavailable' + detail);
      });
    });

    slot.appendChild(btn);
  }

  // base64 → Uint8Array → Blob → programmatic download. iOS Safari
  // sees the application/vnd.apple.pkpass MIME and opens the system
  // Wallet preview directly; macOS does the same.
  function triggerPkpassDownload(base64, filename) {
    var bin = atob(base64);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    var blob = new Blob([arr], { type: 'application/vnd.apple.pkpass' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
      if (a.parentNode) a.parentNode.removeChild(a);
    }, 100);
  }

  function renderSlotError(card, slotSelector, msg) {
    card.classList.remove('is-loading');
    var slot = card.querySelector(slotSelector);
    if (!slot) return;
    slot.innerHTML = '<span class="myahl-wallet-slot-error">' + escapeHtml(msg) + '</span>';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
    });
  }

  // ── JSONP helper (mirror of myahl-patches.js) ────────────────
  var _jsonpSeq = 0;
  function fetchJsonp(url) {
    return new Promise(function (resolve, reject) {
      var cb = '__ahlw_jsonp_' + (++_jsonpSeq) + '_' + Date.now().toString(36);
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
      // 60s — Apple-pass requests round-trip through Cloud Functions
      // (cold start can be 5–10s on first hit) and the broker also
      // takes its own time. On cellular this can stretch; 30s was
      // too tight in practice.
      timer = setTimeout(function () {
        if (window[cb]) { cleanup(); reject(new Error('JSONP timeout')); }
      }, 60000);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
