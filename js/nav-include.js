// nav-include.js — fetches /nav.html, injects at #site-nav-mount,
// then wires up scrolled class, active link, mobile carousel centering,
// and hamburger drawer toggle (fullscreen, hamburger morphs into X via CSS).
(function () {
  // ── Site-wide analytics bootstrap ─────────────────────────
  // Loaded here (rather than tagged into every page <head>) so a single
  // file owns the include and pages stay free of analytics boilerplate.
  // The /js/analytics.js file is a no-op until its MEASUREMENT_ID is
  // filled in, so this is safe to ship before the GA property exists.
  // Trade-off: gtag.js loads ~50–200ms later than a head-tagged script,
  // which is invisible for visitor counts — fine for our use case.
  (function loadAnalytics() {
    var s = document.createElement('script');
    s.src = '/js/analytics.js';
    s.async = true;
    document.head.appendChild(s);
  })();

  var mount = document.getElementById('site-nav-mount');
  if (!mount) return;
  fetch('/nav.html', { cache: 'no-cache' })
    .then(function (r) { return r.ok ? r.text() : ''; })
    .then(function (html) { if (html) { mount.outerHTML = html; init(); } })
    .catch(function () {});

  function init() {
    var nav = document.getElementById('siteNav');
    if (!nav) return;

    function onScroll() { nav.classList.toggle('scrolled', window.scrollY > 60); }
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    var path = window.location.pathname;
    var activeLink = null;
    nav.querySelectorAll('.nav-links a').forEach(function (a) {
      var lp = a.getAttribute('data-path');
      var match = lp === '/' ? (path === '/' || path === '/home/' || path === '/index.html') : path.indexOf(lp) === 0;
      if (match) { a.classList.add('active'); activeLink = a; }
    });

    if (activeLink && window.innerWidth <= 991) {
      var wrap = nav.querySelector('.nav-links');
      if (wrap) {
        requestAnimationFrame(function () {
          wrap.scrollTo({ left: activeLink.offsetLeft - (wrap.clientWidth / 2) + (activeLink.offsetWidth / 2), behavior: 'auto' });
        });
      }
    }

    // ── Rotating AHL mark before the active nav item (desktop only) ─────
    // A white AHL circle that spins on its vertical axis and sits just
    // before whichever top-nav item is active on this page.
    if (activeLink && window.matchMedia('(min-width: 992px)').matches) {
      var navLogo = document.getElementById('navLogo');
      if (!navLogo) {
        navLogo = document.createElement('div');
        navLogo.id = 'navLogo';
        navLogo.className = 'ahl-flip-logo';
        navLogo.setAttribute('aria-hidden', 'true');
        navLogo.innerHTML = '<img src="https://cdn.ahlab.org/media/site/cropped-Group@2x-192x192.png" alt="">';
        document.body.appendChild(navLogo);
      }
      var placeNav = function () {
        var a = nav.querySelector('.nav-links a.active');
        if (!a) { navLogo.classList.remove('is-visible'); return; }
        var rng = document.createRange();
        rng.selectNodeContents(a);
        var r = rng.getBoundingClientRect();
        navLogo.style.left = (r.left - navLogo.offsetWidth - 8) + 'px';
        navLogo.style.top  = (r.top + r.height / 2 - navLogo.offsetHeight / 2) + 'px';
        navLogo.classList.add('is-visible');
      };
      placeNav();
      window.addEventListener('resize', placeNav, { passive: true });
      // Re-place once web fonts settle (nav text width shifts after first paint).
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(placeNav);
      window.addEventListener('load', placeNav);
      setTimeout(placeNav, 800);
    }

    var toggle = document.getElementById('navToggle');
    var drawer = document.getElementById('navDrawer');
    if (toggle && drawer) {
      function closeDrawer() {
        drawer.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
        drawer.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';
      }
      function openDrawer() {
        drawer.classList.add('open');
        toggle.setAttribute('aria-expanded', 'true');
        drawer.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
      }
      toggle.addEventListener('click', function (e) {
        e.stopPropagation();
        drawer.classList.contains('open') ? closeDrawer() : openDrawer();
      });
      drawer.querySelectorAll('a').forEach(function (a) {
        a.addEventListener('click', closeDrawer);
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && drawer.classList.contains('open')) closeDrawer();
      });
    }

    // Let auth.js (and any other listeners) know the nav is now in the
    // DOM, so they can populate [data-auth-slot] elements without polling.
    document.dispatchEvent(new CustomEvent('ahl-nav-ready'));
  }
})();