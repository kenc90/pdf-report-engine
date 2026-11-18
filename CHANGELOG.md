# Changelog

Notable user-facing changes for each release are listed here.

## [Unreleased]

### Added

- Browser-only live DOM capture from current computed styles, including canvas snapshots as PNG images.
- Optional live-DOM header and footer bands from Elements or HTML strings.

### Fixed

- Preserve browser-computed line-height and center text within the line box in live-DOM reports.
- Preserve inline content alongside block elements without duplicating the parent container's box styling.
- Extend paragraph background fills through vertical padding and preserve rounded backgrounds on flex items.
- Include text nested in flex and container blocks when collecting remote-font subsets.

## [0.2.1] - 2026-11-10

### Added

- Opt-in tagged PDF output with screen-reader-oriented structure, document language, and figure alternative text.
- Opt-in PDF/A-2b output with embedded-font checks and encryption rejection.
- HTML adapter support for document language and chart alternative labels.

## [0.2.0]

### Added

- Pagination across pages for eligible oversized, text-only table rows.

### Fixed

- Corrected the PDF metadata field name from `Creater` to `Creator`.

## [0.1.1] - 2026-11-08

This retrospective entry is reconstructed from the commits leading up to the release tag.

### Added

- Browser-ready library bundle.
- Report features including data-driven and rich tables, conditional formatting, charts, barcodes, SVG, flex and multi-column layouts, Gantt charts, links, table of contents, watermarks, and absolute positioning.
- Embedded and web-font support with per-glyph fallback, plus streaming and encrypted PDF output.

### Changed

- Added bounded remote downloads, configurable page buffering, and controls for filesystem image access.

### Fixed

- Corrected border rendering around padded boxes.
