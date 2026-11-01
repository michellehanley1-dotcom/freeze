// Icicle freeze overlay. Plays on every open, and again when someone calls freeze or wins a round.
// Tap anywhere to skip. A plain script so the opening screen shows before the game code loads.
(function () {
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var rnd = function (a, b) { return a + Math.random() * (b - a); };

  function icicleHtml() {
    var n = Math.max(9, Math.round(window.innerWidth / 34));
    var html = '';
    for (var i = 0; i < n; i++) {
      var w = rnd(14, 34), h = rnd(60, 230) * (reduce ? 0.6 : 1);
      var left = (i / n) * 100 + rnd(-1.2, 1.2);
      var delay = reduce ? 0 : rnd(0.05, 0.75);
      var id = 'g' + Math.random().toString(36).slice(2, 8) + i;
      html += '<svg class="ic" style="left:' + left.toFixed(2) + '%;width:' + w.toFixed(1) + 'px;height:' + h.toFixed(0) + 'px;animation-delay:' + delay.toFixed(2) + 's" viewBox="0 0 ' + w.toFixed(1) + ' ' + h.toFixed(0) + '" preserveAspectRatio="none" aria-hidden="true">' +
        '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F4FBFF"/><stop offset=".55" stop-color="#BFE6FA"/><stop offset="1" stop-color="#6FB8E0" stop-opacity=".85"/></linearGradient></defs>' +
        '<path d="M0 0 H' + w.toFixed(1) + ' C' + (w * 0.9).toFixed(1) + ' ' + (h * 0.45).toFixed(0) + ' ' + (w * 0.62).toFixed(1) + ' ' + (h * 0.92).toFixed(0) + ' ' + (w * 0.5).toFixed(1) + ' ' + h.toFixed(0) + ' C' + (w * 0.38).toFixed(1) + ' ' + (h * 0.92).toFixed(0) + ' ' + (w * 0.1).toFixed(1) + ' ' + (h * 0.45).toFixed(0) + ' 0 0Z" fill="url(#' + id + ')"/>' +
        '<path d="M' + (w * 0.3).toFixed(1) + ' ' + (h * 0.1).toFixed(0) + ' Q' + (w * 0.2).toFixed(1) + ' ' + (h * 0.4).toFixed(0) + ' ' + (w * 0.42).toFixed(1) + ' ' + (h * 0.8).toFixed(0) + '" stroke="rgba(255,255,255,.8)" stroke-width="1.4" fill="none" stroke-linecap="round"/>' +
        '</svg>';
    }
    return html;
  }

  // Build (or reuse) the overlay, then play it. `title` is optional text shown in the middle.
  function play(opts) {
    opts = opts || {};
    var old = document.getElementById('freeze-intro');
    if (old) old.remove();
    var el = document.createElement('div');
    el.id = 'freeze-intro';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = '<div class="frost"></div><div class="ic-row">' + icicleHtml() + '</div><div class="ic-title"></div>';
    var t = el.querySelector('.ic-title');
    t.textContent = opts.title || 'FREEZE';
    if (opts.sub) { var s = document.createElement('div'); s.className = 'ic-sub'; s.textContent = opts.sub; t.appendChild(s); }
    document.body.appendChild(el);
    var hold = (reduce ? 900 : (opts.hold || 2600));
    var done = false;
    function finish() {
      if (done) return;
      done = true;
      el.classList.add('thaw');
      setTimeout(function () { el.remove(); }, reduce ? 200 : 900);
    }
    el.addEventListener('click', finish);
    setTimeout(finish, hold);
  }

  // The first screen: the static overlay in index.html gets the same treatment.
  window.freezeIntro = play;
  play({});
})();
