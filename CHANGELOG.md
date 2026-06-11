# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Create missing declared log files and parent directories before opening embedded or Ghostty log terminals, preventing `tail` startup errors.

## [1.0.5] - 2026-06-09

### Added

- Added critical service monitoring with notifications when a critical service goes down.
- Added collapsible sections to the tree service detail view.

### Fixed

- Restored full service card information by allowing long titles, labels, and service info to wrap instead of being clipped.
- Fixed embedded terminal sessions by loading `node-pty` through the module namespace used by the Electron bundle.
- Kept embedded log terminals stretched to the page height and pinned to the bottom after writes, exits, and resizes.
- Open the app directly into the services tree view and keep the runtime/actions card sized to its content.

## [1.0.4] - 2026-05-14

### Changed

- Refreshed the app icon assets used for packaged macOS builds.
- Updated the bundled Ghostty archive used by release packaging.
- Ignored the generated `codedb.snapshot` index in future commits.

### Fixed

- Quoted repository paths in generated service run commands so spaces and apostrophes work.
- Kept live service refreshes from replacing stable service metadata while still updating runtime state.
- Showed in-progress service feedback in the service tree during start, stop, and restart actions.

## [1.0.2] - 2026-05-09

### Added

- Added repository-assisted service registration with folder selection, run-command detection, and generated automatic launch plist settings.

### Changed

- Restart now unloads and bootstraps launchd jobs before kickstarting so failed starts can be retried from a fresh launchd state.
- Start and restart actions clear stale failure guidance as soon as a new attempt begins.

### Fixed

- Gave the log tail more room on the launch failure page by making troubleshooting guidance more compact and scrollable.

## [1.0.1] - 2026-04-29

### Added

- Added service creation from the app, including plist validation and helper snippets.
- Added service folders, tree navigation, drag-and-drop organization, and folder-level actions.
- Added embedded terminal and Ghostty launch support for service and log sessions.
- Added usage-based sorting and background usage polling for launchd services.
- Added bundled Ghostty resources for release packaging.

### Changed

- Isolated live usage refreshes so background polling updates only the usage metrics component instead of replacing the full service roster UI.
- Split display aliases from service folder organization while migrating legacy alias paths.
- Improved tray icon rendering with SVG and PNG fallbacks.

### Fixed

- Cleared npm audit findings by upgrading Electron, Vite, the React Vite plugin, electron-vite, and the transitive @xmldom/xmldom lock entry.
- Corrected virtual memory unit conversion for process snapshots.
- Guarded terminal input and resize handling after embedded sessions exit.
