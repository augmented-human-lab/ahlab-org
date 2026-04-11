// nav-include.js — fetches /nav.html, injects at #site-nav-mount,
// then wires up scrolled class, active link, mobile carousel centering,
// and hamburger drawer toggle (fullscreen, hamburger morphs into X via CSS).
(function () {
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
  }
})();