const REPORT_START = /^\s*(?:<!doctype\s+html>\s*)?<(?:style|meta|link|body|h[1-6]|p|div|section|article|header|footer|main|ul|ol|li|table|hr|img|svg|blockquote)\b/i;

function looksLikeReportHtml(value) {
  return REPORT_START.test(String(value || ''));
}

export function extractHtmlFromReply(text) {
  const reply = String(text || '').trim();
  const fences = [...reply.matchAll(/```([a-z0-9_-]*)\s*([\s\S]*?)```/gi)];
  const htmlFence = fences.find((fence) => fence[1].toLowerCase() === 'html');
  if (htmlFence) return htmlFence[2].trim();

  const unlabelledHtmlFence = fences.find((fence) => !fence[1] && looksLikeReportHtml(fence[2]));
  if (unlabelledHtmlFence) return unlabelledHtmlFence[2].trim();
  if (fences.length) return '';

  return looksLikeReportHtml(reply) ? reply : '';
}
