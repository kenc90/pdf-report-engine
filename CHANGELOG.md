# Changelog

Notable user-facing changes for each release are listed here.

## [Unreleased]

### Added

- Browser-only live DOM capture from current computed styles, including canvas snapshots as PNG images.
- Interactive live DOM demo covering supported captures, layout limitations, and intentional failures.

### Changed

- Made live DOM capture a standalone Getting Started section and added demo links to documentation footers.

### Fixed

- Preserve inline content alongside block elements without duplicating the parent container's box styling.
- Extend paragraph background fills through vertical padding and preserve rounded backgrounds on flex items.
- Include text nested in flex and container blocks when collecting remote-font subsets.

## [0.2.1] - 2026-11-10

### Added

- Opt-in tagged PDF output with screen-reader-oriented structure, document language, and figure alternative text.
- Opt-in PDF/A-2b output with embedded-font checks and encryption rejection.
- Tagged PDF and PDF/A-2b controls in the browser editor, with matching AI guidance.
- HTML adapter support for document language and chart alternative labels.
- Editor promotion on the documentation home page.

## [0.2.0]

### Added

- Pagination across pages for eligible oversized, text-only table rows.
- PDF and JRXML attachments in the editor's AI assistant.

### Fixed

- Corrected the PDF metadata field name from `Creater` to `Creator`.

## [0.1.1] - 2026-11-08

This retrospective entry is reconstructed from the commits leading up to the release tag.

### Added

- Browser-ready library bundle and a visual HTML editor with PDF preview, editable report data, and BYOK AI assistance.
- Report features including data-driven and rich tables, conditional formatting, charts, barcodes, SVG, flex and multi-column layouts, Gantt charts, links, table of contents, watermarks, and absolute positioning.
- Embedded and web-font support with per-glyph fallback, plus streaming and encrypted PDF output.
- CLI tools, examples, browser demo, and documentation site.

### Changed

- Added bounded remote downloads, configurable page buffering, and controls for filesystem image access.

### Fixed

- Improved editor attribute parsing and scroll synchronization, and corrected border rendering around padded boxes.
