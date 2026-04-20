/**
 * hero-parallax.js — tilt-driven horizontal pan of the hero background
 * ====================================================================
 *
 * On phones, `.hero::before` uses `background-size: cover`, which leaves
 * extra image cropped off the left and right edges on portrait screens.
 * This script reads device-orientation gamma (left/right roll) and
 * updates the CSS variable `--hero-tilt-x` so the hero pages read:
 *
 *   background-position: calc(50% + var(--hero-tilt-x, 0px)) center;
 *
 * As the user tilts the phone, the image pans horizontally and reveals
 * the cropped edges. A low-pass filter on the raw sensor value + rAF
 * driven DOM writes keep the motion smooth.
 *
 * Activation gates (all must pass, else this script is a no-op):
 *   1. `.hero` element exists on the page
 *   2. `(pointer: coarse)` — mobile/touch-primary. Desktop is skipped.
 *   3. `prefers-reduced-motion` is not set
 *
 * iOS 13+ permission flow
 *   Safari on iOS requires DeviceOrientationEvent.requestPermission() to
 *   be called from a user-gesture handler. We attach a one-shot touchend
 *   + click listener to `document`; on the user's first interaction we
 *   trigger the permission prompt. If granted, we start listening; if
 *   denied or dismissed, the hero stays static (same as before).
 *
 * Debug: append `?parallax-debug=1` to the URL for console logging of
 * sensor events — useful when sensors look dead (e.g. Chrome on Android
 * silently blocks these events on plain HTTP).
 */
(function () {
  'use strict';

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  // Mobile-only: coarse pointer = touch-primary device.
  if (!window.matchMedia('(pointer: coarse)').matches) return;

  var heroes = document.querySelectorAll('.hero');
  if (heroes.length === 0) return;

  var DEBUG = /[?&]parallax-debug=1\b/.test(location.search);
  var log = DEBUG
    ? function () { console.log.apply(console, ['[hero-parallax]'].concat([].slice.call(arguments))); }
    : function () {};

  // gamma is left/right roll in degrees (-90…+90 in portrait). Map
  // ±MAX_TILT_DEG to ±MAX_SHIFT_PX; deeper tilts clamp so the image
  // never pans off the cropped region.
  var MAX_TILT_DEG = 20;
  var MAX_SHIFT_PX = 60;

  var targetShift = 0;
  var currentShift = 0;
  var rafScheduled = false;

  function clamp(v, min, max) { return v < min ? min : v > max ? max : v; }

  function applyShift() {
    rafScheduled = false;
    // Low-pass filter: approach the target by ~25% per frame. Smooths
    // jitter from the sensor and makes the pan feel eased rather than
    // rigidly tracking every micro-motion.
    currentShift += (targetShift - currentShift) * 0.25;
    heroes.forEach(function (h) {
      h.style.setProperty('--hero-tilt-x', currentShift.toFixed(1) + 'px');
    });
    if (Math.abs(targetShift - currentShift) > 0.1) {
      rafScheduled = true;
      requestAnimationFrame(applyShift);
    } else {
      currentShift = targetShift;
    }
  }

  var firstEvent = true;
  function onOrientation(e) {
    // Browsers warm up sensors asynchronously — first few events may
    // carry null gamma. Skip those rather than bailing.
    if (e.gamma == null) return;
    if (firstEvent) {
      log('first valid event:', { beta: e.beta, gamma: e.gamma, absolute: e.absolute });
      firstEvent = false;
    }
    var ratio = clamp(e.gamma / MAX_TILT_DEG, -1, 1);
    targetShift = ratio * MAX_SHIFT_PX;
    if (!rafScheduled) {
      rafScheduled = true;
      requestAnimationFrame(applyShift);
    }
  }

  function attachListeners() {
    // Attach both flavors — some Android browsers (Samsung Internet,
    // older Chromes) only dispatch one or the other.
    window.addEventListener('deviceorientation', onOrientation, { passive: true });
    window.addEventListener('deviceorientationabsolute', onOrientation, { passive: true });
    log('listeners attached');
  }

  var needsPermission =
    typeof DeviceOrientationEvent !== 'undefined' &&
    typeof DeviceOrientationEvent.requestPermission === 'function';

  if (needsPermission) {
    // iOS 13+: requestPermission must run inside a user-gesture handler.
    // The first tap anywhere on the page is our trigger. Using `once`
    // via a manual removeEventListener so both touch + click dedupe
    // cleanly (once:true would keep the *other* listener live).
    var handleFirstGesture = function () {
      document.removeEventListener('touchend', handleFirstGesture, true);
      document.removeEventListener('click', handleFirstGesture, true);
      log('first gesture — requesting permission');
      DeviceOrientationEvent.requestPermission()
        .then(function (response) {
          log('permission:', response);
          if (response === 'granted') attachListeners();
        })
        .catch(function (err) { log('permission error:', err); });
    };
    // Capture phase so we run before link handlers; passive because we
    // don't interfere with the gesture itself.
    document.addEventListener('touchend', handleFirstGesture, true);
    document.addEventListener('click', handleFirstGesture, true);
    log('awaiting first gesture to request iOS motion permission');
  } else {
    attachListeners();
  }

  if (DEBUG) {
    setTimeout(function () {
      if (firstEvent) log('no orientation events after 3s — sensor unavailable / blocked / awaiting permission');
    }, 3000);
  }
})();
