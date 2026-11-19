# Agent instructions

## Project scope

- This is a TypeScript PDF report engine. The HTML adapter maps a supported HTML/CSS subset into the report IR; it is not a browser renderer or screenshot tool.
- Preserve the library's vector/selectable output and pagination behavior. Do not imply unsupported browser layouts such as CSS Grid are faithfully reproduced.
- Keep changes surgical and follow existing adapter, layout, and test patterns.

## Validation

- Run focused tests with `npm test -- <test-file>`, and the full suite with `npm test` when appropriate.
- Run `npm run build` for package changes.
- For browser-bundle changes, run `npm run build:browser`. This also syncs the LLM documentation.
- After editing documentation pages, run `npm run build:search` if searchable content changed.

## Generated files

- Update source files before regenerating browser bundles or search indexes; do not hand-edit generated bundles or indexes.
- Use `npm run sync:llms` when changes affect the LLM documentation.

## Changelog

- Include only library behavior/API features and fixes in `CHANGELOG.md`.
- Never list documentation, demo, editor, generated-artifact, or other non-library-only changes, even when they ship alongside library changes.
- Remove the `Unreleased` heading when it has no entries; do not leave an empty section.
