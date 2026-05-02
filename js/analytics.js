// analytics.js — Google Analytics (GA4) gtag bootstrap.
//
// Loaded from nav-include.js so every page that mounts the nav also fires
// pageviews, with no per-page <script> tag needed. Until MEASUREMENT_ID is
// filled in, this file is a no-op — safe to ship before the GA property
// is provisioned.
//
// To configure:
//   1. Create / open your GA4 property and copy its Measurement ID
//      (looks like "G-XXXXXXXXXX").
//   2. Replace MEASUREMENT_ID below.
//   3. (Optional) For privacy-tighter behavior, set ANONYMIZE_IP = true
//      to mask the last octet of visitor IPs server-side.
(function () {
  var MEASUREMENT_ID = 'G-G2C5HSDCNX';
  var ANONYMIZE_IP   = false;

  if (!MEASUREMENT_ID || MEASUREMENT_ID.indexOf('XXXX') !== -1) return;

  // Load the gtag library asynchronously.
  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + MEASUREMENT_ID;
  document.head.appendChild(s);

  // Standard gtag bootstrap.
  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { window.dataLayer.push(arguments); };
  gtag('js', new Date());

  var cfg = {};
  if (ANONYMIZE_IP) cfg.anonymize_ip = true;
  gtag('config', MEASUREMENT_ID, cfg);
})();
