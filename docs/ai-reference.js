const STOP_WORDS = new Set([
  'a', 'about', 'all', 'an', 'and', 'are', 'as', 'at', 'be', 'best', 'can', 'could',
  'do', 'does', 'for', 'from', 'get', 'give', 'how', 'i', 'in', 'is', 'it', 'me',
  'my', 'of', 'on', 'or', 'please', 'show', 'tell', 'that', 'the', 'this', 'to',
  'engine', 'library', 'package', 'pdf', 'report', 'use', 'using', 'what', 'when',
  'where', 'which', 'with', 'would',
]);

const LIBRARY_TERMS = new Set([
  'api', 'barcode', 'block', 'browser', 'bundle', 'chart', 'cli', 'data', 'esm',
  'expression', 'font', 'html', 'image', 'install', 'javascript', 'library', 'package',
  'page', 'pdf', 'render', 'report', 'script', 'stream', 'table', 'type',
]);

const BROAD_QUESTION = /\b(?:overview|capabilities|all features|everything|comprehensive|getting started|what(?:'s| is) supported|what can (?:this )?(?:library|package|pdf-report-engine) do|how (?:do i|can i) use (?:this )?(?:library|package|pdf-report-engine))\b/i;
const MAX_SECTIONS = 4;
const MAX_SELECTED_CHARS = 12000;

function tokens(value) {
  return String(value || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.map((term) => {
      if (term === 'series' || term === 'species') return term;
      if (term.endsWith('ies') && term.length > 4) return `${term.slice(0, -3)}y`;
      if (term.endsWith('s') && !/(?:ss|us|is)$/.test(term) && term.length > 3) return term.slice(0, -1);
      return term;
    }) || [];
}

function splitSections(reference) {
  const sections = [];
  let parent = '';
  let title = 'Introduction';
  let lines = [];

  const save = () => {
    const content = lines.join('\n').trim();
    if (content) sections.push({ title, content });
  };

  for (const line of String(reference).split(/\r?\n/)) {
    const heading = /^(#{2,3})\s+(.+)$/.exec(line);
    if (!heading) {
      lines.push(line);
      continue;
    }

    save();
    if (heading[1].length === 2) {
      parent = heading[2];
      title = parent;
    } else {
      title = parent ? `${parent} — ${heading[2]}` : heading[2];
    }
    lines = [line];
  }
  save();
  return sections;
}

function scoreSection(section, queryTerms) {
  const titleTerms = new Set(tokens(section.title));
  const contentTerms = tokens(section.content);
  let score = 0;
  for (const term of queryTerms) {
    if (titleTerms.has(term)) score += 5;
    let occurrences = 0;
    for (const contentTerm of contentTerms) {
      if (contentTerm === term && ++occurrences === 3) break;
    }
    score += occurrences;
  }
  return score;
}

export function selectDetailedReference(reference, question) {
  const fullReference = String(reference || '').trim();
  if (!fullReference) return '';

  const query = String(question || '').trim();
  if (!query) return '';
  if (BROAD_QUESTION.test(query)) return fullReference;

  const queryTerms = [...new Set(tokens(query).filter((term) => term.length > 1 && !STOP_WORDS.has(term)))];
  if (!queryTerms.length) return '';

  const sections = splitSections(fullReference)
    .map((section) => ({ ...section, score: scoreSection(section, queryTerms) }))
    .sort((a, b) => b.score - a.score);
  const relevant = sections.filter((section) => section.score >= 2);
  if (!relevant.length) {
    const hasLibraryIntent = tokens(query).some((term) => LIBRARY_TERMS.has(term));
    return hasLibraryIntent ? fullReference : '';
  }

  const selected = [];
  let selectedChars = 0;
  for (const section of relevant) {
    if (selected.length >= MAX_SECTIONS) break;
    if (selected.length && selectedChars + section.content.length > MAX_SELECTED_CHARS) break;
    selected.push(section.content);
    selectedChars += section.content.length;
  }
  return selected.join('\n\n');
}
