// Minimal ambient types for the plain-JS editor module (docs/editor-defs.js),
// which is consumed by the browser editor and by test/editor-defs.test.ts.
// The module is authored in plain JS with no annotations; these declarations
// exist only so the strict `typecheck` script can resolve the import. The HTML
// element model is intentionally loose (`any`) — the tests exercise the parse →
// serialize round-trip, not the full node shape.

export function parseHtml(src: string): any;
export function serializeWithOffsets(root: any): any;
