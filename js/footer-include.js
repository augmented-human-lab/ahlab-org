// footer-include.js — fetches /footer.html and injects into <div id="site-footer-mount"></div>
(function(){
  var mount = document.getElementById('site-footer-mount');
  if(!mount) return;
  fetch('/footer.html', {cache:'no-cache'})
    .then(function(r){ return r.ok ? r.text() : ''; })
    .then(function(html){ if(html) mount.outerHTML = html; })
    .catch(function(){});
})();