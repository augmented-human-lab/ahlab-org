/**
 * wallet-card.js — "Add to Google Wallet" surface on /my-ahl/.
 * ============================================================
 *
 * Fetches a signed save-to-wallet URL from the broker and renders:
 *   • a QR code (so desktop users can scan with their phone camera)
 *   • an "Add to Google Wallet" button (one-tap path on mobile/Android)
 *
 * Both routes resolve to https://pay.google.com/gp/v/save/<jwt>, which
 * Google Wallet handles natively on Android and via the web flow on
 * iOS / desktop.
 *
 * Why a QR code on desktop
 *   Clicking "Add to Wallet" on a desktop tries to add the pass to the
 *   browser's logged-in Google account, but the pass actually needs to
 *   land on the user's phone. The QR transfers the action: scan with
 *   the phone camera → phone opens the URL → Wallet on the phone shows
 *   the Add prompt. Direct, no account-mismatch surprises.
 *
 * Privacy
 *   The save URL contains a JWT carrying member identity. We render the
 *   QR client-side via the vendored qrcode.min.js — no third-party QR
 *   service, no leak.
 *
 * Surface
 *   Renders into a sibling element next to .myahl-idcard. If the ID
 *   card isn't on the page (auth missing, render hasn't fired), this
 *   module is a no-op.
 */
(function () {
  'use strict';

  // Google's official "Add to Google Wallet" badge (hosted by Google).
  // Brand guidelines require the official asset; using the hosted URL
  // means we always pick up Google's latest revision.
  var ADD_TO_WALLET_BADGE =
    'https://developers.google.com/static/wallet/generic/resources/enUS_add_to_google_wallet_add-wallet-badge.png';

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
      renderQr(card, data.url);
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
        '<p class="myahl-wallet-desc">Scan the code with your phone camera to add this card to Google Wallet, or tap the button below if you\'re already on your phone.</p>' +
        '<div class="myahl-wallet-btn-slot"></div>' +
      '</div>' +
      '<div class="myahl-wallet-qr-slot" aria-hidden="true">' +
        '<div class="myahl-wallet-qr-spinner" role="status" aria-label="Loading wallet code"></div>' +
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

  function renderQr(card, url) {
    card.classList.remove('is-loading');
    var slot = card.querySelector('.myahl-wallet-qr-slot');
    if (!slot) return;
    slot.innerHTML = '';
    if (typeof QRCode !== 'function') {
      slot.textContent = 'QR library missing';
      return;
    }
    // correctLevel must be L for wallet save URLs — the JWT they wrap
    // is ~1500–2000 bytes, which exceeds H's ~1273-byte capacity.
    // L gives us ~2953 bytes, comfortably fitting current URLs with
    // headroom for richer pass objects later. Phone cameras decode
    // these reliably; printed/photographed scenarios aren't a use
    // case here (the QR is shown live on a desktop screen).
    try {
      new QRCode(slot, {
        text: url,
        width: 200,
        height: 200,
        colorDark: '#000000',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.L
      });
    } catch (err) {
      slot.textContent = 'QR too large';
      // eslint-disable-next-line no-console
      console.error('wallet-card: QR render failed', err, 'url length =', url.length);
    }
  }

  function renderButton(card, url) {
    var slot = card.querySelector('.myahl-wallet-btn-slot');
    if (!slot) return;
    slot.innerHTML = '';
    var a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.className = 'myahl-wallet-btn';
    a.setAttribute('aria-label', 'Add card to Google Wallet');
    var img = document.createElement('img');
    img.src = ADD_TO_WALLET_BADGE;
    img.alt = 'Add to Google Wallet';
    img.height = 48;
    a.appendChild(img);
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
