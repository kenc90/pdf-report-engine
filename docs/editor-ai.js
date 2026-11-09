// AI report assist for the online editor (editor.html / editor.js).
//
// Bring-your-own-key (BYOK): the visitor supplies their own provider + API key,
// the browser calls that provider *directly* (never through us), and the model
// writes this editor's constrained-HTML dialect so the result is valid IR.
// Nothing here ships a key or a backend — the key lives in the visitor's own
// localStorage (or memory for one session) and only ever goes to their chosen
// endpoint.
//
// The system prompt is generated from the palette `BLOCKS` examples in
// editor-defs.js, which are the authoritative shapes of the dialect, so the
// model can only imitate markup the adapter actually accepts.

import { parseHtml, serializeHtml, BLOCKS } from './editor-defs.js';

// ---------------------------------------------------------------------------
// Provider presets
// ---------------------------------------------------------------------------

/**
 * One entry per selectable provider. `kind` picks the request builder:
 *  - 'openai'    → OpenAI Chat Completions (also OpenRouter and other compatible servers)
 *  - 'anthropic' → Anthropic Messages
 *  - 'gemini'    → Google Generative Language
 * `base` is the default endpoint, `model` a placeholder, `needsKey` whether a
 * secret is required, `showBase` whether to reveal the base-URL field.
 */
const PRESETS = {
  openai: { kind: 'openai', base: 'https://api.openai.com/v1', model: 'gpt-4o-mini', needsKey: true, showBase: false },
  openrouter: { kind: 'openai', base: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini', needsKey: true, showBase: false, keyPlaceholder: 'sk-or-v1-…' },
  anthropic: { kind: 'anthropic', base: 'https://api.anthropic.com', model: 'claude-3-5-sonnet-latest', needsKey: true, showBase: false },
  gemini: { kind: 'gemini', base: 'https://generativelanguage.googleapis.com', model: 'gemini-2.0-flash', needsKey: true, showBase: false },
  ollama: { kind: 'openai', base: 'http://localhost:11434/v1', model: 'llama3.1', needsKey: false, showBase: true },
  custom: { kind: 'openai', base: '', model: '', needsKey: false, showBase: true },
};

const CFG_KEY = 'pdf-report-engine:ai:cfg';
const SECRET_KEY = 'pdf-report-engine:ai:key';

// ---------------------------------------------------------------------------
// The dialect reference handed to the model
// ---------------------------------------------------------------------------

/** Turn a palette snippet into prompt-safe example text (no giant data-URIs). */
function exampleOf(block) {
  return block.snippet.split('@@LOGO@@').join('assets/logo.png').replace(/\s+/g, ' ').trim();
}

/**
 * The system prompt: role + the hard rules of the HTML subset + one canonical
 * example per palette block (so the model mirrors markup that is known to work).
 * Derived from `BLOCKS`, so it stays in sync with what the editor supports.
 */
function buildSystemPrompt() {
  const rules = [
    'You author reports for `pdf-report-engine`, a pure-JavaScript paginated PDF report engine.',
    'You are a helpful assistant embedded in a visual PDF-report editor. Chat with the user about the report they want.',
    'Keep your prose short and friendly. Whenever you create or change the report, ALWAYS output the FULL document (not a diff, not a fragment) inside a single ```html fenced block, so it can replace the editor contents. If the report binds data (reads `$data`), ALSO output a single ```json fenced block containing that dataset. It is fine to add a one- or two-sentence note around the blocks.',
    'For PDFs, use the extracted text and rendered page images to understand content and layout.',
    'For JRXML/XML, translate the attached source markup into the supported HTML report dialect.',
    '',
    '## Hard rules (a strict subset — anything outside it will be dropped or break rendering)',
    '- The document is a flat sequence of blocks. A leading <style> and/or <body ...> wrapper is allowed.',
    '- Block tags only: h1..h6, p, div, section, article, header, footer, main, ul, ol, li, table (thead/tbody/tfoot/tr/th/td), hr, img, inline <svg>, blockquote.',
    '- Inline tags only: b/strong, i/em, u/ins, span, font, a (href), mark, br.',
    '- Styling is inline `style=` (plus class rules defined in <style>) using this flat CSS subset ONLY: font-family, font-size, font-weight, font-style, color, line-height, letter-spacing, text-align, text-decoration, text-transform, white-space, background, opacity, width, height, min-height, border*, border-radius, box-shadow, padding*, margin*, vertical-align, position:absolute|fixed + left/top/z-index, transform:rotate(<deg>), break-before|after|inside:page|avoid, display:flex + flex-direction/wrap/justify-content/align-items/gap + child flex/align-self, column-count/column-gap.',
    '- NO CSS float, grid, position:relative/absolute side-anchoring outside the listed subset, pseudo-classes, shorthand beyond the listed properties, or external stylesheets.',
    '- Units are points (pt), mm, cm, in, px or %. Percentages resolve against the content width.',
    '- Page setup: <meta name="pdf-page" content="size=a4; margin=48; orientation=landscape"> or a `@page { size: A4 landscape; margin: 15mm }` rule inside <style>. Standard sizes: a3 a4 a5 b4 b5 letter legal tabloid executive.',
    '',
    '## Bands (repeating / pinned regions)',
    '- Put data-band="pageHeader" | "pageFooter" | "title" | "summary" on a header/footer/section/div to lift it out of the body flow. pageHeader/pageFooter repeat on every page; title is once at the top of page 1; summary once at the end.',
    '- Running page numbers use the literal tokens {PAGE} and {TOTAL}, and they ONLY resolve inside bands (never in the body).',
    '',
    '## Special blocks are triggered by DATA ATTRIBUTES on a <div> or <table> (never a type= attribute, never <chart>/<barcode> tags)',
    '- Chart: <div data-chart="KIND" ...>. KIND in bar|line|area|pie|donut|combo|waterfall|scatter|bubble|radar|gauge|heatmap|gantt. Attributes: data-title, data-categories="A,B,C", data-values="1,2,3" (single series), data-series="Name:v1,v2; Name2:v1,v2", data-colors="#hex,#hex", data-legend="none|top|bottom|right", data-show-values="true", data-stacked="true|100%", data-value-format="#,##0.0", data-min/data-max/data-ticks, data-x-format, data-axis-labels/data-category-labels/data-grid-lines. Combo: data-series-types="bar,line" + data-series-axes="left,right" + data-right-min/-max/-format. Scatter/bubble/range: data-series-x / data-series-r / data-series-low + data-series-high. Waterfall: data-totals="0,4" + data-waterfall-colors="increase=#15803d;decrease=#b91c1c;total=#0f2f57". Gauge: data-gauge-value + data-gauge-max. Heatmap: data-heatmap-colors="from=#eef4ff;to=#1e3a8a". Gantt: data-gantt-tasks="name:start:end[:color[:progress[:deps]]]" + data-gantt-unit/-start/-end. data-reference-lines="250:SLO,color=#c00". Always give a chart element style="height:140pt" (or similar). A <table data-chart="..."> plots from its own rows.',
    '- Barcode: <div data-barcode="qr|code128|ean13" data-value="..."> with optional data-module-size, data-quiet-zone, data-error-correction="L|M|Q|H", data-show-text.',
    '- Table of contents: <div data-toc data-title="Contents" data-level="2">.',
    '- Multi-column: <div style="column-count:2; column-gap:16pt"> children </div>.',
    '- Watermark: on <body> add data-watermark="DRAFT" (+ data-watermark-rotate="-35", data-watermark-size="72", data-watermark-color="#c0c0c0", data-watermark-opacity="0.2", data-watermark-layer="background|foreground").',
    '- Diagonal (two-way) corner header cell: <th data-diagonal data-diagonal-bottom="Gender">Preferred Pet</th>. Cell merge via colspan="n" / rowspan="n".',
    '',
    '## Data-bound tables + expressions',
    '- WHERE THE DATA LIVES: `$data` is supplied by the user in a separate "Data (JSON)" tab in this editor. Whenever your HTML reads `$data.<...>`, you MUST also emit ONE ```json fenced block holding a single JSON object whose shape matches those reads exactly (e.g. reading `$data.rows` ⇒ `{ "rows": [ { ... }, { ... } ] }`). The editor applies the ```html and ```json blocks together, so the report renders filled. If the report needs no bound data, write the figures inline and emit NO json block.',
    '- Turn a table into a data region with data-each="row in $data.list" (or data-bind="$data.list") on the <table>. The header lives in <thead>/<th>. The FIRST <tbody> row is a template; repeat it once per data row. Bind each template cell with data-bind="field" and optional data-format="#,##0.00".',
    '- Conditional style on a row/cell/block: data-when="<expr>" + data-when-style="<css>". Conditional visibility / row filter: data-if="<expr>". Numeric heatmap: data-color-scale="from=#eef4ff; to=#1e3a8a" (omit min/max to auto-derive per column).',
    '- IMPORTANT: row grouping with per-group subtotals is NOT authorable from HTML. If grouping/subtotals are wanted, emit STATIC <tbody> rows with the figures written out literally (and/or a summary band).',
    '- Expression scope in data-bind/data-when/data-if/data-each: $data.<path>, $vars.<name>, $item (the data-each value), $row.<field>, $value (a bound cell value), $index, $group.<key>_sum|_avg|_min|_max|_count, $page.number/$page.total (bands only). Functions: sum avg min max count rows rowCount concat format(v,"pattern") money(v) percent(v) number(v) cond(test,a,b) date(v,"yyyy-MM-dd") now() abs round floor ceil length upper lower trim.',
    '- number format tokens: 0 . , % $ ( ) - + ; and \'literal\'; e.g. "#,##0.00", "$#,##0", "0.0%". date tokens: yy yyyy M MM MMM d dd HH hh mm ss a.',
    '',
    '## Do NOT',
    '- Do NOT invent attributes or tags. There is no data-col, data-label, data-field, data-expr, data-anchor, no chart-type / type="chart", no type="barcode", no <canvas>, no <iframe>, no JavaScript. Keep strictly to the rules above.',
    '- Do NOT include an <html> or <head> tag; start with optional <style>, optional <meta name="pdf-page">, a <body ...> (which may carry data-watermark) or the first block directly.',
    '',
    '## Canonical examples (copy these exact shapes)',
  ].join('\n');

  const examples = BLOCKS.map((b) => `- ${b.group} / ${b.name}: ${exampleOf(b)}`).join('\n');
  return `${rules}\n\n${examples}`;
}

/**
 * A system-level context turn describing what is currently in the editor, so
 * "make the chart a donut" refers to the real document. Only added when the
 * user leaves "Use current doc" on.
 */
function buildContextMessage(currentHtml, currentData) {
  const src = String(currentHtml || '').trim();
  const dataStr = String(currentData || '').trim();
  if (!src && !dataStr) return null;
  return {
    role: 'system',
    content: [
      'The user currently has this report in the editor. When they ask to change it, edit it and return the FULL updated document (preserving anything they did not mention). If you use `$data` bindings, keep the dataset in a ```json block in lockstep with the HTML.',
      '',
      '## Report source (HTML)',
      src || '(empty)',
      '',
      '## Report data (JSON, bound as $data)',
      dataStr || '(none — emit a ```json block if your HTML reads $data)',
    ].join('\n'),
  };
}

/**
 * Pull the report HTML out of a model reply. Prefers an explicit ```html fence,
 * otherwise the first fenced block that is NOT ```json; with no fences at all the
 * whole reply is treated as markup (back-compat for unfenced output).
 */
function extractHtml(text) {
  const t = String(text || '').trim();
  const explicit = t.match(/```html\s*([\s\S]*?)```/i);
  if (explicit) return explicit[1].trim();
  const fences = [...t.matchAll(/```(\w*)\s*([\s\S]*?)```/gi)];
  if (fences.length) {
    const htmlFence = fences.find((f) => !/^json$/i.test(f[1] || ''));
    return htmlFence ? htmlFence[2].trim() : '';
  }
  return t;
}

/** Pull the ```json dataset out of a reply; returns the parsed value or null. */
function extractJson(text) {
  const t = String(text || '').trim();
  const m = t.match(/```json\s*([\s\S]*?)```/i);
  if (!m) return null;
  try { return JSON.parse(m[1].trim()); } catch { return null; }
}

/** Strip fenced html/json blocks (and their fences) from a reply, leaving prose. */
function stripFences(text) {
  return String(text || '').replace(/```(?:html|json)[\s\S]*?```/gi, '').trim();
}

/**
 * Read an image File into a provider-ready part: `{ mime, data, previewUrl }`.
 * Oversized images are downscaled (max edge 1568px) and re-encoded to keep the
 * request payload and model vision-token cost reasonable.
 */
function fileToImagePart(file) {
  return new Promise((resolve, reject) => {
    if (!file || !String(file.type).startsWith('image/')) return reject(new Error('not an image'));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read failed'));
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const comma = dataUrl.indexOf(',');
      const mime = dataUrl.slice(5, dataUrl.indexOf(';')) || file.type;
      const finish = (m, url) => resolve({ mime: m, data: url.slice(url.indexOf(',') + 1), previewUrl: url });
      const img = new Image();
      img.onerror = () => finish(mime, dataUrl); // not decodable as bitmap → send raw
      img.onload = () => {
        const MAX = 1568;
        if (img.width <= MAX && img.height <= MAX) return finish(mime, dataUrl);
        const scale = Math.min(MAX / img.width, MAX / img.height);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        finish('image/jpeg', canvas.toDataURL('image/jpeg', 0.9));
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('could not read file bytes'));
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const comma = dataUrl.indexOf(',');
      if (comma < 0) return reject(new Error('invalid data URL'));
      resolve(dataUrl.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

let pdfjsPromise;

async function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('./assets/pdfjs.mjs').then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('./assets/pdf.worker.mjs', import.meta.url).href;
      return pdfjs;
    }).catch((err) => {
      pdfjsPromise = null;
      throw new Error(`Could not load the PDF reader: ${err.message}`);
    });
  }
  return pdfjsPromise;
}

function samplePdfPages(pageCount, maxImages) {
  const count = Math.min(pageCount, maxImages);
  if (count === pageCount) return Array.from({ length: count }, (_v, i) => i + 1);
  if (count <= 1) return [1];
  return Array.from({ length: count }, (_v, i) => Math.round(i * (pageCount - 1) / (count - 1)) + 1);
}

async function readPdfFile(file, maxImages) {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({ data: await file.arrayBuffer() });
  const pdf = await task.promise;
  const textPages = [];
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = content.items.map((item) => typeof item.str === 'string' ? item.str : '').filter(Boolean).join(' ');
      if (pageText) textPages.push(`--- Page ${pageNumber} ---\n${pageText}`);
    }

    const pageImages = [];
    for (const pageNumber of samplePdfPages(pdf.numPages, maxImages)) {
      const page = await pdf.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = Math.min(1.6, 1400 / baseViewport.width, 1400 / baseViewport.height);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      const previewUrl = canvas.toDataURL('image/jpeg', 0.82);
      pageImages.push({
        mime: 'image/jpeg',
        data: previewUrl.slice(previewUrl.indexOf(',') + 1),
        previewUrl,
        pdfName: file.name,
        label: `${file.name}, page ${pageNumber}`,
      });
      canvas.width = 0;
      canvas.height = 0;
    }
    let text = textPages.join('\n\n') || '(No extractable text; this may be a scanned PDF.)';
    return { pageCount: pdf.numPages, text, pageImages };
  } finally {
    await pdf.destroy();
  }
}

// ---------------------------------------------------------------------------
// Provider request builders (all browser-direct; each returns assistant text)
// ---------------------------------------------------------------------------

async function readError(res) {
  let detail = `${res.status} ${res.statusText}`;
  try {
    const txt = await res.text();
    if (txt) {
      try {
        const j = JSON.parse(txt);
        detail += `: ${j.error?.message || j.message || txt.slice(0, 300)}`;
      } catch { detail += `: ${txt.slice(0, 300)}`; }
    }
  } catch { /* ignore */ }
  return new Error(detail);
}

/**
 * Read a Server-Sent-Events stream and invoke `onData` for each JSON payload.
 * Ignores keep-alive comments and the `[DONE]` sentinel. Shared by every
 * provider's streaming branch.
 */
async function sseTokens(res, onData) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (!line || line.startsWith(':') || !line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try { onData(JSON.parse(data)); } catch { /* ignore partial/keepalive */ }
    }
  }
}

/**
 * Turn an internal message (`{ role, content, images? }`) into an OpenAI
 * Chat Completions message. `images` are `{ mime, data(base64) }`.
 */
function openAIMessage(m) {
  if (m.role !== 'user' || !m.images || !m.images.length) return { role: m.role, content: m.content };
  const parts = [];
  for (const img of m.images || []) {
    if (img.label) parts.push({ type: 'text', text: `Attached image: ${img.label}` });
    parts.push({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.data}` } });
  }
  if (m.content) parts.push({ type: 'text', text: m.content });
  return { role: m.role, content: parts };
}

/** Anthropic variant: image → `{ type:'image', source:{ type:'base64', ... } }`. */
function anthropicMessage(m) {
  if (m.role !== 'user' || (!(m.images && m.images.length) && !(m.documents && m.documents.length))) {
    return { role: m.role, content: m.content };
  }
  const parts = [];
  const documentNames = new Set((m.documents || []).map((document) => document.name));
  for (const document of m.documents || []) {
    parts.push({ type: 'text', text: `Attached PDF: ${document.name}` });
    parts.push({
      type: 'document',
      source: { type: 'base64', media_type: document.mime, data: document.data },
    });
  }
  for (const img of m.images || []) {
    if (img.pdfName && documentNames.has(img.pdfName)) continue;
    if (img.label) parts.push({ type: 'text', text: `Attached image: ${img.label}` });
    parts.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data } });
  }
  if (m.content) parts.push({ type: 'text', text: m.content });
  return { role: m.role, content: parts };
}

/** Gemini variant: image → inlineData part alongside the text part. */
function geminiMessage(m) {
  const parts = [];
  if (m.role === 'user') {
    const documentNames = new Set((m.documents || []).map((document) => document.name));
    for (const document of m.documents || []) {
      parts.push({ text: `Attached PDF: ${document.name}` });
      parts.push({ inlineData: { mimeType: document.mime, data: document.data } });
    }
    for (const img of m.images || []) {
      if (img.pdfName && documentNames.has(img.pdfName)) continue;
      if (img.label) parts.push({ text: `Attached image: ${img.label}` });
      parts.push({ inlineData: { mimeType: img.mime, data: img.data } });
    }
  }
  if (m.content) parts.push({ text: m.content });
  if (!parts.length) parts.push({ text: '' });
  return { role: m.role === 'assistant' ? 'model' : 'user', parts };
}

/**
 * OpenAI Chat Completions — also any OpenAI-compatible base URL (incl. Ollama /v1).
 * When `handlers` is supplied it streams and forwards reasoning deltas
 * (`reasoning_content` / `reasoning`, emitted by DeepSeek-R1 / Ollama / etc.).
 */
async function callOpenAI({ base, key, model }, messages, signal, handlers) {
  const url = `${base.replace(/\/$/, '')}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  const stream = !!handlers;
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers,
    body: JSON.stringify({ model, temperature: 0.2, messages: messages.map(openAIMessage), ...(stream ? { stream: true } : {}) }),
  });
  if (!res.ok) throw await readError(res);
  if (!stream) {
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? '';
  }
  let full = '';
  await sseTokens(res, (d) => {
    const delta = d.choices?.[0]?.delta || {};
    const r = delta.reasoning_content || delta.reasoning;
    if (r) handlers.onReasoning?.(r);
    if (delta.content) { full += delta.content; handlers.onText?.(delta.content); }
  });
  return full;
}

/**
 * Anthropic Messages (uses the browser-direct access header). With
 * `handlers.reasoning` it requests extended thinking, whose `thinking_delta`
 * chunks are forwarded to `onReasoning` while `text_delta` fills the answer.
 */
async function callAnthropic({ base, key, model }, messages, signal, handlers) {
  const url = `${base.replace(/\/$/, '')}/v1/messages`;
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const chat = messages.filter((m) => m.role !== 'system').map(anthropicMessage);
  const wantThinking = !!handlers?.reasoning;
  const payload = { model, max_tokens: wantThinking ? 8000 : 4000, system, messages: chat };
  if (wantThinking) {
    payload.thinking = { type: 'enabled', budget_tokens: 3000 };
    payload.temperature = 1; // Anthropic requires temperature 1 when thinking is enabled
  }
  if (handlers) payload.stream = true;
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw await readError(res);
  if (!handlers) {
    const data = await res.json();
    return (data.content || []).map((c) => c.text || '').join('');
  }
  let full = '';
  await sseTokens(res, (d) => {
    if (d.type === 'content_block_delta') {
      const dl = d.delta || {};
      if (dl.type === 'thinking_delta') handlers.onReasoning?.(dl.thinking || '');
      else if (dl.type === 'text_delta') { full += dl.text || ''; handlers.onText?.(dl.text || ''); }
    }
  });
  return full;
}

/** Google Generative Language (key in a header). Streams any `thought` parts. */
async function callGemini({ base, key, model }, messages, signal, handlers) {
  const verb = handlers ? 'streamGenerateContent?alt=sse' : 'generateContent';
  const url = `${base.replace(/\/$/, '')}/v1beta/models/${encodeURIComponent(model)}:${verb}`;
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map(geminiMessage);
  const body = { contents };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  body.generationConfig = { temperature: 0.2 };
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await readError(res);
  if (!handlers) {
    const data = await res.json();
    return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  }
  let full = '';
  await sseTokens(res, (d) => {
    for (const p of (d.candidates?.[0]?.content?.parts || [])) {
      if (p.thought) handlers.onReasoning?.(p.text || '');
      else if (p.text) { full += p.text; handlers.onText?.(p.text); }
    }
  });
  return full;
}

/** `handlers` (onReasoning/onText/reasoning) ⇒ streaming; omitted ⇒ single JSON reply. */
function callProvider(preset, cfg, messages, signal, handlers) {
  const args = { base: cfg.baseUrl || preset.base, key: cfg.apiKey, model: cfg.model };
  if (preset.kind === 'anthropic') return callAnthropic(args, messages, signal, handlers);
  if (preset.kind === 'gemini') return callGemini(args, messages, signal, handlers);
  return callOpenAI(args, messages, signal, handlers);
}

// ---------------------------------------------------------------------------
// Config persistence (key kept separately, only when "remember" is checked)
// ---------------------------------------------------------------------------

function loadConfig() {
  let cfg = { provider: 'openai', model: '', baseUrl: '', reasoning: false, remember: false };
  try { cfg = { ...cfg, ...JSON.parse(localStorage.getItem(CFG_KEY) || '{}') }; } catch { /* ignore */ }
  let storedKey = '';
  try { storedKey = localStorage.getItem(SECRET_KEY) || ''; } catch { /* ignore */ }
  cfg.apiKey = cfg.remember ? storedKey : '';
  return cfg;
}

function saveConfig(cfg, apiKey) {
  const { apiKey: _omit, ...safe } = cfg;
  try { localStorage.setItem(CFG_KEY, JSON.stringify({ ...safe, remember: cfg.remember })); } catch { /* ignore */ }
  try {
    if (cfg.remember && apiKey) localStorage.setItem(SECRET_KEY, apiKey);
    else localStorage.removeItem(SECRET_KEY);
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------

/**
 * Install the AI assist chat drawer. Called by editor.js once the editor exists.
 * @param {object} hooks
 * @param {() => string} hooks.getEditorValue - current source (for context)
 * @param {(html: string) => void} hooks.applyGenerated - replace the editor doc
 * @param {(msg: string, isError?: boolean) => void} hooks.status - app status line
 */
/**
 * Minimal, XSS-safe Markdown → HTML for assistant replies. Everything is
 * HTML-escaped first, then a constrained set of block constructs (headings,
 * fenced code, blockquotes, ordered/unordered lists with nesting, GFM pipe
 * tables, horizontal rules, paragraphs) and inline spans (code, bold, italic,
 * strikethrough, links) are applied. Only tags we emit ourselves reach the DOM.
 */
function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function mdInline(text) {
  let s = escHtml(text);
  s = s.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>').replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t, u) => {
    const safe = /^(https?:|mailto:|#|\/)/i.test(u) ? u : '#';
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${t}</a>`;
  });
  return s;
}
function mdSplitRow(r) {
  return r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
}
function mdParseList(lines, start) {
  const itemRe = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;
  const first = itemRe.exec(lines[start]);
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const tag = ordered ? 'ol' : 'ul';
  let html = `<${tag}>`;
  let i = start;
  while (i < lines.length) {
    if (/^\s*$/.test(lines[i])) {
      let j = i + 1;
      while (j < lines.length && /^\s*$/.test(lines[j])) j += 1;
      const nm = j < lines.length ? itemRe.exec(lines[j]) : null;
      if (nm && nm[1].length >= baseIndent && /\d/.test(nm[2]) === ordered) { i = j; continue; }
      break;
    }
    const m = itemRe.exec(lines[i]);
    if (!m) break;
    const indent = m[1].length;
    if (indent < baseIndent) break;
    if (indent > baseIndent) {
      const sub = mdParseList(lines, i);
      html = html.replace(/<\/li>$/, '') + sub.html + '</li>';
      i = sub.next;
      continue;
    }
    if (/\d/.test(m[2]) !== ordered) break; // marker type changed → a new list
    html += `<li>${mdInline(m[3])}</li>`;
    i += 1;
  }
  html += `</${tag}>`;
  return { html, next: i };
}
function renderMarkdown(src) {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  const isBlank = (l) => /^\s*$/.test(l);
  const tableSep = (l) => /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(l);
  let out = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m = /^```(\w*)\s*$/.exec(line);
    if (m) {
      let code = '';
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { code += lines[i] + '\n'; i += 1; }
      i += 1;
      out += `<pre><code>${escHtml(code.replace(/\n$/, ''))}</code></pre>`;
      continue;
    }
    m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) { const lvl = m[1].length; out += `<h${lvl}>${mdInline(m[2].trim())}</h${lvl}>`; i += 1; continue; }
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) { out += '<hr>'; i += 1; continue; }
    if (/^\s*>\s?/.test(line)) {
      let buf = '';
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf += lines[i].replace(/^\s*>\s?/, '') + '\n'; i += 1; }
      out += `<blockquote>${renderMarkdown(buf)}</blockquote>`;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && tableSep(lines[i + 1])) {
      const header = mdSplitRow(line);
      const aligns = mdSplitRow(lines[i + 1]).map((c) => {
        const l = c.startsWith(':'), r = c.endsWith(':');
        return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
      });
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && !isBlank(lines[i])) { rows.push(mdSplitRow(lines[i])); i += 1; }
      const cellAttr = (ci) => (aligns[ci] ? ` style="text-align:${aligns[ci]}"` : '');
      let t = '<table><thead><tr>';
      header.forEach((h, ci) => { t += `<th${cellAttr(ci)}>${mdInline(h)}</th>`; });
      t += '</tr></thead><tbody>';
      rows.forEach((r) => {
        t += '<tr>';
        header.forEach((_h, ci) => { t += `<td${cellAttr(ci)}>${mdInline(r[ci] || '')}</td>`; });
        t += '</tr>';
      });
      t += '</tbody></table>';
      out += t;
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) { const res = mdParseList(lines, i); out += res.html; i = res.next; continue; }
    if (isBlank(line)) { i += 1; continue; }
    const buf = [];
    while (i < lines.length && !isBlank(lines[i])
      && !/^(#{1,6}\s|```|\s*>|\s*([-*+]|\d+\.)\s)/.test(lines[i])
      && !(lines[i].includes('|') && i + 1 < lines.length && tableSep(lines[i + 1]))) {
      buf.push(lines[i]); i += 1;
    }
    if (!buf.length) { buf.push(lines[i]); i += 1; }
    out += `<p>${mdInline(buf.join('\n'))}</p>`;
  }
  return out;
}

export function initAiAssist({ getEditorValue, getEditorData, applyGenerated, status }) {
  const $ = (id) => document.getElementById(id);
  const grid = document.querySelector('.wb-grid');
  const chat = $('ai-chat');
  const settingsEl = $('ai-settings');
  const providerEl = $('ai-provider');
  const modelEl = $('ai-model');
  const modelListEl = $('ai-model-options');
  const keyEl = $('ai-key');
  const baseRow = $('ai-base-row');
  const baseEl = $('ai-base');
  const rememberEl = $('ai-remember');
  const thinkEl = $('ai-think');
  const keyRow = $('ai-key-row');
  const testBtn = $('ai-test');
  const statusEl = $('ai-status');
  const messagesEl = $('ai-messages');
  const inputEl = $('ai-input');
  const sendBtn = $('ai-send');
  const contextEl = $('ai-context');
  const attachEl = $('ai-attachments');
  const attachBtn = $('ai-attach-btn');
  const attachInput = $('ai-attach-input');

  const cfg = loadConfig();
  let secret = cfg.apiKey || ''; // in-memory key (survives only this session unless remembered)
  let history = []; // {role, content, images?} turns sent to / received from the provider
  let pending = []; // staged images for the next user turn: {mime, data, previewUrl}
  let controller = null;
  let busy = false;

  aiStatus('');

  function currentPreset() { return PRESETS[providerEl.value] || PRESETS.openai; }

  function readForm() {
    const preset = currentPreset();
    return {
      provider: providerEl.value,
      model: modelEl.value.trim() || preset.model,
      baseUrl: preset.showBase ? baseEl.value.trim() : '',
      remember: rememberEl.checked,
      reasoning: thinkEl ? thinkEl.checked : false,
      apiKey: keyEl.value.trim() || secret,
    };
  }

  function aiStatus(msg, isError) {
    statusEl.textContent = msg;
    statusEl.className = `ai-status${isError ? ' error' : ''}`;
  }

  let openRouterModelRequest = 0;
  async function loadOpenRouterModels() {
    const requestId = ++openRouterModelRequest;
    aiStatus('Loading OpenRouter models…');
    try {
      const res = await fetch('https://openrouter.ai/api/v1/models');
      if (!res.ok) throw await readError(res);
      const response = await res.json();
      if (!Array.isArray(response.data)) throw new Error('Invalid model list response');
      const models = response.data
        .filter((model) => model && typeof model.id === 'string' && model.id)
        .sort((a, b) => a.id.localeCompare(b.id));
      if (!models.length) throw new Error('The model list was empty');
      if (requestId !== openRouterModelRequest || providerEl.value !== 'openrouter') return;
      modelListEl.replaceChildren();
      for (const model of models) {
        const option = document.createElement('option');
        option.value = model.id;
        option.label = typeof model.name === 'string' ? model.name : model.id;
        modelListEl.appendChild(option);
      }
    } catch (err) {
      if (requestId === openRouterModelRequest && providerEl.value === 'openrouter') {
        aiStatus(`Could not load OpenRouter models: ${err.message}`, true);
      }
    }
  }

  /** Reflect provider choice: model placeholder, base visibility, key necessity. */
  function applyPreset() {
    const preset = currentPreset();
    modelEl.placeholder = preset.model || 'model name';
    if (providerEl.value === 'openrouter') modelEl.setAttribute('list', 'ai-model-options');
    else {
      modelEl.removeAttribute('list');
      modelListEl.replaceChildren();
    }
    baseRow.hidden = !preset.showBase;
    baseEl.placeholder = preset.base || 'https://your-endpoint/v1';
    keyRow.style.opacity = preset.needsKey ? '1' : '';
    keyEl.placeholder = preset.needsKey ? (preset.keyPlaceholder || 'sk-…') : '(no key needed)';
    // Extended-thinking is an explicit request only on Anthropic; other providers
    // stream reasoning automatically when the model supports it, so hide the opt-in.
    const thinkRow = thinkEl && thinkEl.closest('.ai-row');
    if (thinkRow) thinkRow.hidden = preset.kind !== 'anthropic';
  }

  function loadFormFromCfg() {
    providerEl.value = cfg.provider;
    modelEl.value = cfg.model && cfg.model !== (PRESETS[cfg.provider] || {}).model ? cfg.model : '';
    baseEl.value = cfg.baseUrl || '';
    keyEl.value = secret;
    rememberEl.checked = !!cfg.remember;
    if (thinkEl) thinkEl.checked = !!cfg.reasoning;
    applyPreset();
  }
  loadFormFromCfg();
  if (providerEl.value === 'openrouter') void loadOpenRouterModels();

  // ---- message rendering ----
  function addBubble(kind, text) {
    const div = document.createElement('div');
    div.className = `ai-msg ${kind}`;
    div.textContent = text;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  function makeFileChip(name, kind, onRemove) {
    const chip = document.createElement('span');
    chip.className = 'ai-file-chip';
    const type = document.createElement('span');
    type.className = 'kind';
    type.textContent = kind;
    const label = document.createElement('span');
    label.className = 'name';
    label.textContent = name;
    chip.append(type, label);
    if (onRemove) {
      const remove = document.createElement('button');
      remove.className = 'remove';
      remove.type = 'button';
      remove.textContent = '×';
      remove.title = `Remove ${name}`;
      remove.setAttribute('aria-label', `Remove ${name}`);
      remove.addEventListener('click', onRemove);
      chip.appendChild(remove);
    }
    return chip;
  }

  /** A user bubble with attached file names and image previews. */
  function addUserBubble(text, attachments, images) {
    const div = addBubble('user', text || '');
    const files = attachments.filter((item) => item.kind !== 'image');
    if (files.length) {
      const row = document.createElement('div');
      row.className = 'ai-thumb-row';
      for (const file of files) row.appendChild(makeFileChip(file.name, file.kind.toUpperCase()));
      div.appendChild(row);
    }
    if (images && images.length) {
      const row = document.createElement('div');
      row.className = 'ai-thumb-row';
      for (const img of images) {
        const im = document.createElement('img');
        im.className = 'ai-thumb-img';
        im.src = img.previewUrl || `data:${img.mime};base64,${img.data}`;
        im.alt = img.label || 'attached image';
        row.appendChild(im);
      }
      div.appendChild(row);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  // ---- file attachments (drag-drop / picker / image paste) ----
  const MAX_IMAGES = 4;
  const MAX_PDF_BYTES = 12 * 1024 * 1024;
  const MAX_XML_BYTES = 20 * 1024 * 1024;
  function renderAttachments() {
    attachEl.innerHTML = '';
    attachEl.hidden = pending.length === 0;
    pending.forEach((p, i) => {
      const remove = () => { pending.splice(i, 1); renderAttachments(); };
      if (p.kind === 'image') {
        const fig = document.createElement('div');
        fig.className = 'ai-thumb';
        const im = document.createElement('img');
        im.src = p.image.previewUrl;
        im.alt = p.name;
        const rm = document.createElement('button');
        rm.className = 'ai-thumb-x';
        rm.type = 'button';
        rm.textContent = '×';
        rm.title = `Remove ${p.name}`;
        rm.setAttribute('aria-label', `Remove ${p.name}`);
        rm.addEventListener('click', remove);
        fig.append(im, rm);
        attachEl.appendChild(fig);
      } else {
        const label = p.kind === 'pdf' ? `${p.pageCount} pages` : 'XML';
        attachEl.appendChild(makeFileChip(p.name, label, remove));
      }
    });
  }

  function visualAttachmentCount() {
    return pending.reduce((total, item) => total + (item.kind === 'image' ? 1 : item.kind === 'pdf' ? item.pageImages.length : 0), 0);
  }

  async function addFiles(files) {
    for (const f of files) {
      const mime = String(f.type || '').toLowerCase();
      const name = String(f.name || 'attachment');
      const ext = name.split('.').pop().toLowerCase();
      try {
        if (mime.startsWith('image/')) {
          if (visualAttachmentCount() >= MAX_IMAGES) { aiStatus(`Max ${MAX_IMAGES} visual pages or images per message.`, true); break; }
          if (f.size > 12 * 1024 * 1024) throw new Error('image too large (>12MB)');
          pending.push({ kind: 'image', name, image: await fileToImagePart(f) });
        } else if (mime === 'application/pdf' || ext === 'pdf') {
          const currentPdfBytes = pending.reduce((total, item) => total + (item.kind === 'pdf' ? item.file.size : 0), 0);
          if (currentPdfBytes + f.size > MAX_PDF_BYTES) throw new Error('PDF attachments exceed the 12MB total limit');
          const slots = MAX_IMAGES - visualAttachmentCount();
          if (slots < 1) throw new Error(`max ${MAX_IMAGES} visual pages or images per message`);
          const pdf = await readPdfFile(f, slots);
          pending.push({ kind: 'pdf', name, file: f, ...pdf });
        } else if (['jrxml', 'xml'].includes(ext) || ['application/xml', 'text/xml'].includes(mime)) {
          if (f.size > 2 * 1024 * 1024) throw new Error('XML file too large (>2MB)');
          const currentXmlBytes = pending.reduce((total, item) => total + (item.kind === 'jrxml' ? item.fileSize : 0), 0);
          if (currentXmlBytes + f.size > MAX_XML_BYTES) throw new Error('JRXML/XML attachments exceed the 20MB total file-size limit');
          const source = await f.text();
          pending.push({
            kind: 'jrxml',
            name,
            text: source,
            fileSize: f.size,
          });
        } else {
          throw new Error('unsupported file type (attach an image, PDF, or JRXML/XML file)');
        }
        renderAttachments();
      } catch (err) {
        aiStatus(`Could not read ${name}: ${err.message}`, true);
      }
    }
  }

  // Paste an image from the clipboard anywhere in the drawer.
  chat.addEventListener('paste', (e) => {
    const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
    const imgs = items.filter((it) => it.kind === 'file' && String(it.type).startsWith('image/')).map((it) => it.getAsFile()).filter(Boolean);
    if (imgs.length) { e.preventDefault(); addFiles(imgs); }
  });

  // Drag-drop images onto the drawer.
  let dragDepth = 0;
  chat.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; chat.classList.add('ai-drag'); });
  chat.addEventListener('dragover', (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
  chat.addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; chat.classList.remove('ai-drag'); } });
  chat.addEventListener('drop', (e) => {
    e.preventDefault(); dragDepth = 0; chat.classList.remove('ai-drag');
    if (e.dataTransfer && e.dataTransfer.files) addFiles(Array.from(e.dataTransfer.files));
  });

  // Attach button: open a file picker and feed the choice through the same path.
  if (attachBtn && attachInput) {
    attachBtn.addEventListener('click', () => attachInput.click());
    attachInput.addEventListener('change', () => {
      if (attachInput.files && attachInput.files.length) addFiles(Array.from(attachInput.files));
      attachInput.value = ''; // allow re-picking the same file
    });
  }

  // ---- live "thinking" box ----
  /** A transient bubble showing phase, an elapsed timer, a Stop button, and any streamed reasoning. */
  function createThinkingBox() {
    const box = document.createElement('div');
    box.className = 'ai-msg thinking';
    const head = document.createElement('div');
    head.className = 'ai-think-head';
    const dot = document.createElement('span'); dot.className = 'ai-dot';
    const label = document.createElement('span'); label.className = 'ai-think-label'; label.textContent = 'Thinking…';
    const time = document.createElement('span'); time.className = 'ai-think-time'; time.textContent = '0s';
    const stop = document.createElement('button'); stop.className = 'ai-stop'; stop.type = 'button'; stop.textContent = 'Stop';
    stop.addEventListener('click', () => { if (controller) controller.abort(); });
    head.append(dot, label, time, stop);
    const reason = document.createElement('pre'); reason.className = 'ai-think-reason'; reason.hidden = true;
    box.append(head, reason);
    messagesEl.appendChild(box);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    const t0 = Date.now();
    const tick = setInterval(() => { time.textContent = `${Math.round((Date.now() - t0) / 1000)}s`; }, 1000);
    return {
      box,
      setPhase(txt) { label.textContent = txt; },
      addReasoning(txt) { reason.hidden = false; reason.textContent += txt; messagesEl.scrollTop = messagesEl.scrollHeight; },
      remove() { clearInterval(tick); box.remove(); return Math.round((Date.now() - t0) / 1000); },
    };
  }

  /** A collapsed "Thought for Ns" panel that persists the reasoning under the reply. */
  function buildReasoningDetails(reasoningText, secs) {
    const det = document.createElement('details');
    det.className = 'ai-think-done';
    const sum = document.createElement('summary');
    sum.textContent = `🧠 Thought for ${secs}s`;
    const pre = document.createElement('pre');
    pre.textContent = reasoningText;
    det.append(sum, pre);
    return det;
  }

  /** Attach the editable document (+ optional dataset) and Apply/Copy controls to an assistant bubble. */
  function buildDocPanel(bubble, html, data) {
    let pretty = html;
    try { pretty = serializeHtml(parseHtml(html)); } catch { /* keep raw if it won't parse */ }
    const doc = document.createElement('div');
    doc.className = 'ai-doc';

    const htmlLabel = document.createElement('div');
    htmlLabel.className = 'ai-doc-label';
    htmlLabel.textContent = 'Report source (HTML)';
    const ta = document.createElement('textarea');
    ta.rows = 5;
    ta.spellcheck = false;
    ta.wrap = 'off';
    ta.value = pretty;
    ta.setAttribute('aria-label', 'Generated report source');
    doc.append(htmlLabel, ta);

    let dataTa = null;
    if (data != null) {
      const dataLabel = document.createElement('div');
      dataLabel.className = 'ai-doc-label';
      dataLabel.textContent = 'Data (JSON) — bound as $data';
      dataTa = document.createElement('textarea');
      dataTa.rows = 5;
      dataTa.spellcheck = false;
      dataTa.wrap = 'off';
      dataTa.className = 'ai-doc-json';
      dataTa.value = JSON.stringify(data, null, 2);
      dataTa.setAttribute('aria-label', 'Generated report data (JSON)');
      doc.append(dataLabel, dataTa);
    }

    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.gap = '8px';
    row.style.alignItems = 'center';
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.type = 'button';
    btn.textContent = 'Apply & preview';
    btn.addEventListener('click', () => {
      applyGenerated(ta.value.trim(), dataTa ? dataTa.value.trim() : undefined);
      btn.textContent = 'Applied ✓';
      btn.disabled = true;
      setTimeout(() => { btn.textContent = 'Apply & preview'; btn.disabled = false; }, 1500);
      status(dataTa ? 'AI report + data applied.' : 'AI report applied.');
    });
    const small = document.createElement('button');
    small.className = 'btn ghost';
    small.type = 'button';
    small.textContent = 'Copy';
    small.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(ta.value); small.textContent = 'Copied ✓'; setTimeout(() => { small.textContent = 'Copy'; }, 1200); }
      catch { ta.focus(); ta.select(); }
    });
    row.append(btn, small);
    doc.append(row);
    bubble.appendChild(doc);
  }

  /** Turn a streaming bubble (holding the raw reply) into a finalized assistant message. */
  function finalizeAssistant(bubble, raw, reasoningText, secs) {
    bubble.hidden = false;
    bubble.textContent = ''; // drop the streamed raw text before rendering
    const html = extractHtml(raw);
    const data = extractJson(raw);
    const prose = stripFences(raw);
    const md = document.createElement('div');
    md.className = 'md';
    md.innerHTML = renderMarkdown(prose || 'Here is the updated report.');
    bubble.appendChild(md);
    if (reasoningText && reasoningText.trim()) bubble.appendChild(buildReasoningDetails(reasoningText.trim(), secs));
    if (html) buildDocPanel(bubble, html, data);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ---- open / close ----
  function toggleChat(force) {
    const open = force != null ? force : chat.hidden;
    chat.hidden = !open;
    chat.classList.toggle('open', open);
    grid.classList.toggle('ai-open', open);
    const aiBtn = $('ai-btn');
    if (aiBtn) {
      aiBtn.classList.toggle('active', open);
      aiBtn.setAttribute('aria-expanded', String(open));
    }
    if (open) {
      // Reveal settings on first use if no key is present.
      if (!currentPreset().needsKey || secret || keyEl.value.trim()) settingsEl.hidden = true;
      else settingsEl.hidden = false;
      inputEl.focus();
    }
  }

  $('ai-btn').addEventListener('click', () => toggleChat());
  $('ai-close').addEventListener('click', () => toggleChat(false));
  $('ai-settings-btn').addEventListener('click', () => { settingsEl.hidden = !settingsEl.hidden; });
  $('ai-clear').addEventListener('click', () => {
    if (controller) controller.abort();
    history = [];
    pending = [];
    renderAttachments();
    messagesEl.innerHTML = '';
    addBubble('sys', 'New conversation. Ask me to build or change the report.');
  });

  providerEl.addEventListener('change', () => {
    applyPreset();
    if (providerEl.value === 'openrouter') void loadOpenRouterModels();
    else aiStatus('');
  });
  keyEl.addEventListener('input', () => { secret = keyEl.value.trim(); });

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  sendBtn.addEventListener('click', sendMessage);

  // ---- test connection ----
  testBtn.addEventListener('click', async () => {
    const form = readForm();
    const preset = currentPreset();
    if (preset.needsKey && !form.apiKey) return aiStatus('Enter an API key first.', true);
    saveConfig({ ...cfg, ...form }, form.apiKey);
    aiStatus('Contacting provider…');
    testBtn.disabled = true;
    try {
      const text = await callProvider(preset, form, [
        { role: 'system', content: 'Reply with exactly the word: ok' },
        { role: 'user', content: 'ping' },
      ]);
      aiStatus(`Connected. Reply: “${String(text).trim().slice(0, 30) || '(empty)'}”`);
    } catch (err) {
      aiStatus(`Failed: ${err.message}`, true);
    } finally {
      testBtn.disabled = false;
    }
  });

  // ---- send a chat turn ----
  async function sendMessage() {
    if (busy) return;
    const text = inputEl.value.trim();
    const attachments = pending.slice();
    if (!text && !attachments.length) return;
    const form = readForm();
    const preset = currentPreset();
    if (preset.needsKey && !form.apiKey) {
      settingsEl.hidden = false;
      aiStatus('Enter an API key (or pick Ollama) first.', true);
      keyEl.focus();
      return;
    }

    const documents = [];
    if (preset.kind === 'anthropic' || preset.kind === 'gemini') {
      const pdfs = attachments.filter((attachment) => attachment.kind === 'pdf');
      if (pdfs.length) {
        busy = true;
        sendBtn.disabled = true;
        aiStatus('Preparing PDF for the selected provider…');
        try {
          for (const pdf of pdfs) {
            documents.push({ name: pdf.name, mime: 'application/pdf', data: await fileToBase64(pdf.file) });
          }
        } catch (err) {
          busy = false;
          sendBtn.disabled = false;
          aiStatus(`Could not prepare PDF attachment: ${err.message}`, true);
          return;
        }
      }
    }

    const images = [];
    const attachmentNotes = [];
    for (const attachment of attachments) {
      if (attachment.kind === 'image') {
        images.push({ ...attachment.image, label: attachment.name });
        attachmentNotes.push(`Attached image: ${attachment.name}.`);
      } else if (attachment.kind === 'pdf') {
        images.push(...attachment.pageImages);
        attachmentNotes.push(
          `Attached PDF "${attachment.name}" (${attachment.pageCount} pages). Text extracted in the browser:\n${attachment.text}`,
        );
      } else {
        attachmentNotes.push(`Attached JRXML/XML file "${attachment.name}":\n${attachment.text}`);
      }
    }
    const messageContent = [text, ...attachmentNotes].filter(Boolean).join('\n\n');
    saveConfig({ ...cfg, ...form }, form.apiKey);

    inputEl.value = '';
    pending = [];
    renderAttachments();
    addUserBubble(text || 'Attached files', attachments, images);
    history.push({ role: 'user', content: messageContent, images, documents });

    const messages = [{ role: 'system', content: buildSystemPrompt() }];
    if (contextEl.checked) {
      const ctx = buildContextMessage(getEditorValue(), getEditorData ? getEditorData() : '');
      if (ctx) messages.push(ctx);
    }
    messages.push(...history);

    controller?.abort();
    controller = new AbortController();
    busy = true;
    sendBtn.disabled = true;
    aiStatus('');
    const think = createThinkingBox();
    const ans = addBubble('assistant', ''); // hidden until the first token, then fills live
    ans.hidden = true;
    let full = '';
    let reasoning = '';
    let sawText = false;
    try {
      const raw = await callProvider(preset, form, messages, controller.signal, {
        reasoning: form.reasoning,
        onReasoning: (t) => { reasoning += t; think.addReasoning(t); think.setPhase('Thinking…'); },
        onText: (t) => { full += t; if (!sawText) { sawText = true; think.setPhase('Writing…'); ans.hidden = false; } ans.textContent += t; messagesEl.scrollTop = messagesEl.scrollHeight; },
      });
      const secs = think.remove();
      const finalText = String(raw || full || '');
      if (!finalText.trim() && !reasoning.trim()) { ans.remove(); addBubble('err', 'The model returned no content.'); return; }
      history.push({ role: 'assistant', content: finalText });
      finalizeAssistant(ans, finalText, reasoning, secs);
    } catch (err) {
      const secs = think.remove();
      if (err && err.name === 'AbortError') {
        if (full.trim() || reasoning.trim()) { history.push({ role: 'assistant', content: full }); finalizeAssistant(ans, full, reasoning, secs); }
        else ans.remove();
        aiStatus('Stopped.');
      } else {
        ans.remove();
        addBubble('err', `Error: ${err.message}`);
        history.pop();
      }
    } finally {
      busy = false;
      sendBtn.disabled = false;
    }
  }

  // Greeting so the panel is never blank.
  addBubble('sys', 'Ask me to build a report from scratch, or to change the one in the editor.');
}
