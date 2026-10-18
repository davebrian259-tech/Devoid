// Remembers this site's light or dark choice in your browser. It is the site's only script: it
// reads and writes that one preference and nothing else. It runs before the page paints, so the
// right theme shows from the first frame.
(function () {
  var root = document.documentElement;
  var KEY = 'devoid-theme';
  var system = window.matchMedia('(prefers-color-scheme: dark)');
  try {
    var saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark') root.setAttribute('data-theme', saved);
  } catch (e) { /* storage blocked: follow the system */ }
  root.classList.add('js');

  function current() { return root.getAttribute('data-theme') || (system.matches ? 'dark' : 'light'); }

  document.addEventListener('DOMContentLoaded', function () {
    var buttons = document.querySelectorAll('[data-theme-toggle]');
    function label() {
      var next = current() === 'dark' ? 'light' : 'dark';
      buttons.forEach(function (b) { b.setAttribute('aria-label', 'Switch to ' + next + ' theme'); b.title = 'Switch to ' + next + ' theme'; });
    }
    buttons.forEach(function (b) {
      b.addEventListener('click', function () {
        var next = current() === 'dark' ? 'light' : 'dark';
        root.setAttribute('data-theme', next);
        try { localStorage.setItem(KEY, next); } catch (e) { /* the choice lasts until reload */ }
        label();
      });
    });
    system.addEventListener('change', label);
    label();
  });
})();
