// Tiny, dependency-free helpers for the static docs site.
// Single source of truth is package.json; `npm version` rewrites this line via
// scripts/sync-version.mjs. It is stamped into every [data-version] placeholder.
var VERSION = '0.1.0';
(function () {
  // Show the current version wherever a [data-version] placeholder exists.
  document.querySelectorAll('[data-version]').forEach(function (el) {
    el.textContent = 'v' + VERSION;
  });

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

// Mobile: tuck the header away when the reader scrolls down, bring it back on
// scroll up. Only active on narrow screens (the 2-row header eats vertical space).
(function () {
  var header = document.querySelector('.site-header');
  if (!header) return;
  var mq = window.matchMedia('(max-width: 720px)');
  var last = window.scrollY;
  function onScroll() {
    var y = window.scrollY;
    if (!mq.matches) {
      if (header.classList.contains('header-hidden')) header.classList.remove('header-hidden');
      last = y;
      return;
    }
    var down = y > last + 4;
    var up = y < last - 4;
    if (y <= 8) header.classList.remove('header-hidden');       // always show near the top
    else if (down && y > 140) header.classList.add('header-hidden');
    else if (up) header.classList.remove('header-hidden');
    last = y;
  }
  window.addEventListener('scroll', onScroll, { passive: true });
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

// Wrap content tables in a scroll container so a wide table scrolls inside its own
// box on narrow screens instead of forcing the whole page into horizontal scroll.
(function () {
  document.querySelectorAll('main table').forEach(function (t) {
    var p = t.parentElement;
    if (p && p.classList && p.classList.contains('table-scroll')) return;
    var wrap = document.createElement('div');
    wrap.className = 'table-scroll';
    t.parentNode.insertBefore(wrap, t);
    wrap.appendChild(t);
  });
})();

// ---- code colouring for the <pre data-copy> blocks on the docs pages -------
// A tiny, dependency-free highlighter mirroring the browser-demo editor. The
// real text already lives in the <code> element (textContent, entities decoded);
// we re-tokenise it and re-escape into <span class="tok-*">. Language is taken
// from a `data-lang` attribute when present, otherwise sniffed from how the
// block starts. The footer "copy" button reads code.innerText, which still
// returns the original text after the spans are injected, so copying is safe.
(function () {
  if (!document.querySelector) return;

  function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function sp(cls, text) { return '<span class="tok-' + cls + '">' + esc(text) + '</span>'; }

  // ---- shared lexers (HTML + CSS), the same shape the editor overlay uses ----
  function textTokens(raw) {
    var out = '', last = 0, m, re = /&[#A-Za-z0-9]{1,10};/g;
    while ((m = re.exec(raw)) !== null) { out += esc(raw.slice(last, m.index)) + sp('entity', m[0]); last = m.index + m[0].length; }
    return out + esc(raw.slice(last));
  }
  function lex(raw, rules, fallback) {
    var out = '', i = 0;
    while (i < raw.length) {
      var rest = raw.slice(i), hit = null;
      for (var r = 0; r < rules.length; r += 1) { var m = rules[r][0].exec(rest); if (m && m[0].length) { hit = { text: m[0], cls: rules[r][1] }; break; } }
      if (!hit) hit = { text: rest[0], cls: fallback };
      out += hit.cls ? sp(hit.cls, hit.text) : esc(hit.text);
      i += hit.text.length;
    }
    return out;
  }
  var ATTR_RULES = [
    [/^\s+/, null],
    [/^"[^"]*"?|^'[^']*'?/, 'string'],
    [/^[A-Za-z_:@][-.:\w@]*/, 'attr'],
    [/^[=/>]/, 'punct'],
  ];
  function tagTokens(raw) {
    var closing = raw.indexOf('</') === 0;
    var out = sp('punct', closing ? '</' : '<');
    var rest = raw.slice(closing ? 2 : 1);
    var name = /^[A-Za-z][-.:\w]*/.exec(rest);
    if (name) { out += sp('tag', name[0]); rest = rest.slice(name[0].length); }
    var tail = /\/?>$/.exec(rest);
    if (tail) return out + lex(rest.slice(0, tail.index), ATTR_RULES, 'punct') + sp('punct', tail[0]);
    return out + lex(rest, ATTR_RULES, 'punct');
  }
  function cssTokens(src) {
    var out = '', i = 0, inBlock = false, inValue = false;
    function emit(cls, text) { out += cls ? sp(cls, text) : esc(text); i += text.length; }
    while (i < src.length) {
      var rest = src.slice(i), m;
      if ((m = /^\/\*[\s\S]*?(?:\*\/|$)/.exec(rest))) emit('comment', m[0]);
      else if ((m = /^"[^"]*"?|^'[^']*'?/.exec(rest))) emit('string', m[0]);
      else if ((m = /^\s+/.exec(rest))) emit(null, m[0]);
      else if ((m = /^@[-\w]+/.exec(rest))) emit('attr', m[0]);
      else if ((m = /^[{}]/.exec(rest))) { inBlock = m[0] === '{'; inValue = false; emit('punct', m[0]); }
      else if ((m = /^;/.exec(rest))) { inValue = false; emit('punct', m[0]); }
      else if ((m = /^:/.exec(rest))) { if (inBlock) inValue = true; emit('punct', m[0]); }
      else if (inBlock && inValue && (m = /^#[0-9a-fA-F]{3,8}\b|^[-+]?\d[\d.]*[a-z%]*|^[-\w]+/i.exec(rest))) emit('value', m[0]);
      else if ((m = /^[-\w]+/.exec(rest))) emit(inBlock ? 'prop' : 'selector', m[0]);
      else emit('punct', rest[0]);
    }
    return out;
  }
  function htmlTokens(src) {
    var out = '', i = 0;
    while (i < src.length) {
      var lt = src.indexOf('<', i);
      if (lt === -1) return out + textTokens(src.slice(i));
      out += textTokens(src.slice(i, lt));
      if (src.indexOf('<!--', lt) === lt) {
        var end = src.indexOf('-->', lt); var stop = end === -1 ? src.length : end + 3;
        out += sp('comment', src.slice(lt, stop)); i = stop; continue;
      }
      if (src.indexOf('<!', lt) === lt || src.indexOf('<?', lt) === lt) {
        var de = src.indexOf('>', lt); var ds = de === -1 ? src.length : de + 1;
        out += sp('meta', src.slice(lt, ds)); i = ds; continue;
      }
      var j = lt + 1, quote = '';
      while (j < src.length) {
        var c = src[j];
        if (quote) { if (c === quote) quote = ''; }
        else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
        j += 1;
      }
      var ts = j >= src.length ? src.length : j + 1;
      var raw = src.slice(lt, ts);
      out += tagTokens(raw); i = ts;
      var name = /^<\/?\s*([A-Za-z][-.:\w]*)/.exec(raw);
      name = name && name[1].toLowerCase();
      if (name === 'style' && raw.indexOf('</') !== 0) {
        var off = src.slice(i).toLowerCase().indexOf('</style');
        var bodyEnd = off === -1 ? src.length : i + off;
        out += cssTokens(src.slice(i, bodyEnd)); i = bodyEnd;
      }
    }
    return out;
  }

  // ---- JS / TS / JSON ----
  var JS_KEYWORDS = { import: 1, export: 1, from: 1, const: 1, let: 1, var: 1, function: 1, return: 1, await: 1, async: 1, new: 1, if: 1, else: 1, for: 1, while: 1, do: 1, of: 1, in: 1, class: 1, extends: 1, implements: 1, as: 1, try: 1, catch: 1, finally: 1, switch: 1, throw: 1, typeof: 1, instanceof: 1, yield: 1, delete: 1, get: 1, set: 1, static: 1 };
  var JS_LITERALS = { true: 1, false: 1, null: 1, undefined: 1, NaN: 1, Infinity: 1 };
  function classifyIdent(rest, w) {
    if (JS_LITERALS[w]) return 'bool';
    var tail = rest.slice(w.length);
    if (/^\s*\??\s*:(?![:=])/.test(tail)) return 'prop';   // object key / optional property
    if (JS_KEYWORDS[w]) return 'keyword';
    if (/^\s*\(/.test(tail)) return 'func';
    if (/^[A-Z]/.test(w)) return 'class';                    // TS type / interface
    return null;
  }
  function jsTokens(src) {
    var out = '', i = 0;
    while (i < src.length) {
      var rest = src.slice(i), m;
      if ((m = /^\s+/.exec(rest))) { out += esc(m[0]); i += m[0].length; continue; }
      if ((m = /^\/\/[^\n]*/.exec(rest))) { out += sp('comment', m[0]); i += m[0].length; continue; }
      if ((m = /^\/\*[\s\S]*?(?:\*\/|$)/.exec(rest))) { out += sp('comment', m[0]); i += m[0].length; continue; }
      if (rest[0] === '`') { var j = 1; while (j < rest.length) { if (rest[j] === '\\') { j += 2; continue; } if (rest[j] === '`') { j += 1; break; } j += 1; } var seg = rest.slice(0, j); out += sp('string', seg); i += seg.length; continue; }
      if ((m = /^"(?:\\.|[^"\\])*"?|^'(?:\\.|[^'\\])*'?/.exec(rest))) { out += sp('string', m[0]); i += m[0].length; continue; }
      if ((m = /^\$[A-Za-z_][\w$]*/.exec(rest))) { out += sp('var', m[0]); i += m[0].length; continue; }
      if ((m = /^0[xX][0-9a-fA-F]+|^\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?/.exec(rest))) { out += sp('number', m[0]); i += m[0].length; continue; }
      if ((m = /^[A-Za-z_][\w$]*/.exec(rest))) { var cls = classifyIdent(rest, m[0]); out += cls ? sp(cls, m[0]) : esc(m[0]); i += m[0].length; continue; }
      if ((m = /^[{}()\[\],;:.?=<>!+\-*/%&|^~]+/.exec(rest))) { out += sp('punct', m[0]); i += m[0].length; continue; }
      out += esc(rest[0]); i += 1;
    }
    return out;
  }

  // ---- bash / shell ----
  var BASH_CMDS = { npm: 1, npx: 1, node: 1, yarn: 1, pnpm: 1, git: 1, cd: 1, curl: 1, ls: 1, echo: 1, mkdir: 1 };
  function bashTokens(src) {
    var out = '', i = 0, prev = '', atStart = true;
    while (i < src.length) {
      var rest = src.slice(i), c = rest[0], m;
      if (c === '\n') { out += '\n'; i += 1; prev = '\n'; atStart = true; continue; }
      if (/\s/.test(c)) { m = /^\s+/.exec(rest)[0]; out += esc(m); i += m.length; prev = m.charAt(m.length - 1); continue; }
      var wordStart = atStart || /\s/.test(prev);
      if (c === '#' && wordStart) { m = /^[^\n]*/.exec(rest)[0]; out += sp('comment', m); i += m.length; prev = '#'; atStart = false; continue; }
      if (c === '"' || c === "'") { var q = c, j = 1; while (j < rest.length) { if (rest[j] === '\\') { j += 2; continue; } if (rest[j] === q) { j += 1; break; } j += 1; } var seg = rest.slice(0, j); out += sp('string', seg); i += seg.length; prev = seg.charAt(seg.length - 1) || c; atStart = false; continue; }
      if (wordStart && /^-{1,2}[\w][\w-]*/.test(rest)) { m = /^-{1,2}[\w][\w-]*/.exec(rest)[0]; out += sp('attr', m); i += m.length; prev = m.charAt(m.length - 1); atStart = false; continue; }
      if (atStart && /^[A-Za-z][\w-]*/.test(rest)) { m = /^[A-Za-z][\w-]*/.exec(rest)[0]; out += (BASH_CMDS[m] ? sp('func', m) : esc(m)); i += m.length; prev = m.charAt(m.length - 1); atStart = false; continue; }
      out += esc(c); i += 1; prev = c; atStart = false;
    }
    return out;
  }

  var TOKENIZERS = { html: htmlTokens, css: cssTokens, js: jsTokens, bash: bashTokens };

  function detect(text) {
    var t = text.replace(/^\s+/, '');
    if (t.charAt(0) === '<') return 'html';
    var first = (text.match(/[^\n]*/) || [''])[0].replace(/^\s+/, '');
    if (first.charAt(0) === '#') return 'bash';
    if (/^(npm|npx|node|yarn|pnpm|git|cd|curl|ls|echo|mkdir)\b/.test(first)) return 'bash';
    return 'js';
  }

  function highlight(code) {
    var pre = code.parentNode;
    var lang = ((pre && pre.getAttribute('data-lang')) || code.getAttribute('data-lang') || '').toLowerCase();
    if (lang === 'text' || lang === 'none' || lang === 'plain' || lang === 'plaintext') return;
    var raw = code.textContent;
    var fn = TOKENIZERS[lang] || TOKENIZERS[detect(raw)];
    code.innerHTML = fn(raw);
  }

  var blocks = document.querySelectorAll('pre[data-copy] > code');
  for (var b = 0; b < blocks.length; b += 1) { try { highlight(blocks[b]); } catch (e) { /* leave the block uncoloured */ } }
})();
