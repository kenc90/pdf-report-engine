// Tiny, dependency-free helpers for the static docs site.
(function () {
  // Highlight the current page in the nav.
  var here = location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav a').forEach(function (a) {
    var target = a.getAttribute('href');
    if (target === here || (here === '' && target === 'index.html')) a.classList.add('active');
  });

  // Keep the footer copyright year honest.
  document.querySelectorAll('[data-year]').forEach(function (el) {
    el.textContent = String(new Date().getFullYear());
  });

  // Add a "copy" button to every code block that has a data-copy attribute.
  document.querySelectorAll('pre[data-copy]').forEach(function (pre) {
    var btn = document.createElement('button');
    btn.className = 'copy';
    btn.type = 'button';
    btn.textContent = 'copy';
    btn.addEventListener('click', function () {
      var text = pre.querySelector('code') ? pre.querySelector('code').innerText : pre.innerText;
      navigator.clipboard.writeText(text).then(function () {
        btn.textContent = 'copied!';
        setTimeout(function () { btn.textContent = 'copy'; }, 1400);
      });
    });
    pre.appendChild(btn);
  });
})();

// Build a sticky side table of contents on long pages by reading the <section id>
// headings. Short pages (a landing hero, the browser demo) are left untouched.
(function () {
  var main = document.querySelector('main');
  if (!main) return;

  var sections = [];
  for (var i = 0; i < main.children.length; i += 1) {
    var el = main.children[i];
    if (el.tagName === 'SECTION' && el.id) sections.push(el);
  }
  if (sections.length < 6) return; // only worth a TOC on genuinely long pages

  var used = {};
  function slug(text, prefix) {
    var base = (text || '')
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!base || /^\d/.test(base)) base = (prefix || 'sec') + (base ? '-' + base : '');
    var id = base, n = 2;
    while (used[id]) id = base + '-' + (n += 1);
    used[id] = true;
    return id;
  }

  function headingOf(section) {
    return section.querySelector('h1, h2, h3, h4');
  }

  var nav = document.createElement('nav');
  nav.className = 'toc';
  nav.setAttribute('aria-label', 'On this page');
  var title = document.createElement('div');
  title.className = 'toc-title';
  title.textContent = 'On this page';
  nav.appendChild(title);

  var root = document.createElement('ul');

  sections.forEach(function (section) {
    var heading = headingOf(section);
    var label = heading ? heading.textContent.trim() : section.id;
    var li = document.createElement('li');
    var a = document.createElement('a');
    a.href = '#' + section.id;
    a.textContent = label;
    li.appendChild(a);

    // Nest real sub-headings (h3/h4) that are not the section's own title.
    var subs = [];
    var all = section.querySelectorAll('h3, h4');
    for (var k = 0; k < all.length; k += 1) if (all[k] !== heading) subs.push(all[k]);

    if (subs.length) {
      var ul = document.createElement('ul');
      ul.className = 'toc-sub';
      subs.forEach(function (h) {
        if (!h.id) h.id = slug(h.textContent, section.id);
        var sli = document.createElement('li');
        var sa = document.createElement('a');
        sa.href = '#' + h.id;
        sa.textContent = h.textContent.trim();
        sli.appendChild(sa);
        ul.appendChild(sli);
      });
      li.appendChild(ul);
    }
    root.appendChild(li);
  });

  nav.appendChild(root);

  // Move every current child into a content wrapper, then place TOC beside it.
  var body = document.createElement('div');
  body.className = 'doc-body';
  while (main.firstChild) body.appendChild(main.firstChild);
  main.className = (main.className ? main.className + ' ' : '') + 'has-toc';
  main.appendChild(nav);
  main.appendChild(body);

  // Scroll-spy: highlight the entry for the heading nearest the top of the view.
  var links = Array.prototype.slice.call(nav.querySelectorAll('a[href^="#"]'));
  var targets = links
    .map(function (a) { return document.getElementById(a.getAttribute('href').slice(1)); })
    .filter(Boolean);
  function onScroll() {
    if (!targets.length) return;
    var offset = 90;
    var current = targets[0];
    for (var t = 0; t < targets.length; t += 1) {
      if (targets[t].getBoundingClientRect().top - offset <= 0) current = targets[t];
      else break;
    }
    links.forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('href') === '#' + current.id);
    });
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
})();

// Floating scroll-to-top button: appears once the reader has scrolled down,
// replacing the old footer "Back to top" link.
(function () {
  var btn = document.createElement('button');
  btn.className = 'to-top';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Back to top');
  btn.textContent = '\u2191';
  btn.addEventListener('click', function () {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  document.body.appendChild(btn);

  function toggle() { btn.classList.toggle('show', window.scrollY > 300); }
  window.addEventListener('scroll', toggle, { passive: true });
  window.addEventListener('resize', toggle);
  toggle();
})();

// Light / dark theme: a header toggle overrides the OS preference and remembers the
// choice. The inline script in each page's <head> has already applied the resolved
// theme before first paint; this wires up the button and keeps following the OS
// until the user explicitly chooses.
(function () {
  var root = document.documentElement;
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function stored() {
    try { return localStorage.getItem('pre-theme'); } catch (e) { return null; }
  }
  function resolved() {
    return root.getAttribute('data-theme') || (mq && mq.matches ? 'dark' : 'light');
  }

  var btn = document.querySelector('.theme-toggle');
  if (btn) {
    btn.addEventListener('click', function () {
      var next = resolved() === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('pre-theme', next); } catch (e) {}
    });
  }

  if (mq) {
    var onChange = function (e) {
      if (!stored()) root.setAttribute('data-theme', e.matches ? 'dark' : 'light');
    };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }
})();
