# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-08-04

First release.

### Added

- Read-only Markdown viewer for Windows. Opens a file passed on the command line, associated with
  `.md` and `.markdown`, chosen with `Ctrl+O`, or dropped on the window. Reads `.md`, `.markdown`
  and `.txt`.
- GitHub Flavored Markdown rendering with marked, sanitised with DOMPurify.
- Reloads when the open file changes on disk, at the same scroll position.
- Find in page (`Ctrl+F`) with a match counter, Enter and Shift+Enter to step, Escape to close.
- Outline sidebar (`Ctrl+Shift+O`) with the section being read highlighted as the page scrolls.
- Syntax highlighting for fenced code blocks, with a copy button on each. highlight.js loads after
  the first paint and only for documents that contain code.
- Content width control in the toolbar: Narrow, Default, Wide, Full.
- Zoom with the View menu, `Ctrl+=` / `Ctrl+-` / `Ctrl+0`, or `Ctrl` and the mouse wheel.
- Theme following the Windows setting, or forced to Light or Dark from View > Theme.
- Print (`Ctrl+P`) and Export as PDF. The toolbar, find bar, outline and copy buttons are left off
  the page.
- File > Open Recent, the last ten files, and the Windows jump list.
- File > Windows Integration to register the app as an "Open with" handler for `.md` and
  `.markdown`, writing only under `HKEY_CURRENT_USER`. Mainly for the portable build.
- YAML front matter shown as a collapsed block of raw text.
- Window size and position, theme, content width, outline state and the reading position of each
  file are remembered between runs.
- Single instance: opening a second file reuses the existing window.
- Windows installer and portable executable, built in GitHub Actions and published with SHA-256
  sums, a virus scan report and a build provenance attestation.

[0.1.0]: https://github.com/chryaner/light-md-viewer/releases/tag/v0.1.0
