/**
 * wallet-card.js — "Add to Google Wallet" surface on /my-ahl/.
 * ============================================================
 *
 * Fetches a signed save-to-wallet URL from the broker and renders an
 * "Add to Google Wallet" button. The button resolves to
 * https://pay.google.com/gp/v/save/<jwt>, which Google handles natively
 * on Android and via a web preview on iOS / desktop.
 *
 * On desktop, Google's web preview offers to send the pass to the
 * user's signed-in phone. (We tried embedding the URL as a QR for
 * scan-from-desktop transfer, but the JWT is ~1500–2000 bytes — too
 * dense for a 200×200 QR to be camera-readable. Until we add a
 * shortener-style redirect, button-only is the cleanest path.)
 *
 * Privacy
 *   The save URL contains a JWT carrying member identity. The page
 *   never exposes it to a third-party service.
 *
 * Surface
 *   Renders into a sibling element next to .myahl-idcard. If the ID
 *   card isn't on the page (auth missing, render hasn't fired), this
 *   module is a no-op.
 */
(function () {
  'use strict';

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
    var url = broker + (broker.indexOf('?') === -1 ? '?' : '&') +
      'action=wallet-pass-url&token=' + encodeURIComponent(token);

    fetchJsonp(url).then(function (data) {
      if (!data || data.error || !data.url) {
        renderError(card, (data && data.error) || 'Could not load wallet pass.');
        return;
      }
      renderButton(card, data.url);
    }).catch(function (err) {
      var detail = err && err.message ? ' (' + err.message + ')' : '';
      renderError(card, 'Could not reach the wallet service' + detail + '.');
    });
  }

  // ── DOM construction ─────────────────────────────────────────

  function buildCardSkeleton() {
    var card = document.createElement('div');
    card.className = 'myahl-wallet-card is-loading';
    card.innerHTML =
      '<div class="myahl-wallet-text">' +
        '<h3 class="myahl-wallet-title">Add to phone wallet</h3>' +
        '<p class="myahl-wallet-desc">Add this membership card to Google Wallet on your phone. On desktop, Google will offer to send it to your signed-in phone.</p>' +
      '</div>' +
      '<div class="myahl-wallet-btn-slot">' +
        '<div class="myahl-wallet-qr-spinner" role="status" aria-label="Loading"></div>' +
      '</div>';
    return card;
  }

  function insertNextToIdCard(idCard, card) {
    // The id card lives inside .myahl-header-row — a flex row of
    // [profile][idcard]. The wallet card slots in after the header
    // row as its own block, so it lays out as a wide horizontal
    // strip below the row on desktop and stacks naturally on mobile.
    var headerRow = idCard.closest('.myahl-header-row');
    if (headerRow && headerRow.parentNode) {
      headerRow.parentNode.insertBefore(card, headerRow.nextSibling);
    } else {
      idCard.parentNode.insertBefore(card, idCard.nextSibling);
    }
  }

  function renderButton(card, url) {
    card.classList.remove('is-loading');
    var slot = card.querySelector('.myahl-wallet-btn-slot');
    if (!slot) return;
    slot.innerHTML = '';
    var a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.className = 'myahl-wallet-btn';
    a.setAttribute('aria-label', 'Add card to Google Wallet');
    // Inline SVG of a wallet glyph — no external image dependency, so
    // the button can never break from a stale CDN URL.
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

  function renderError(card, msg) {
    card.classList.remove('is-loading');
    card.classList.add('is-error');
    var slot = card.querySelector('.myahl-wallet-qr-slot');
    if (slot) slot.innerHTML = '';
    var btnSlot = card.querySelector('.myahl-wallet-btn-slot');
    if (btnSlot) btnSlot.textContent = msg;
  }

  // ── JSONP helper (mirror of myahl-patches.js) ────────────────
  // Apps Script web apps don't honour CORS for fetch(); a <script>
  // tag is the only viable cross-origin read pattern. The broker
  // emits `<callback>(<json>);` when ?callback=… is present.
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
      // 30s — matches Apps Script's max web-app execution time. The
      // wallet endpoint can take longer than the 15s used elsewhere
      // because doGet may be serialised behind another concurrent
      // broker call (e.g. list-my-patches firing on the same event).
      timer = setTimeout(function () {
        if (window[cb]) { cleanup(); reject(new Error('JSONP timeout')); }
      }, 30000);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
