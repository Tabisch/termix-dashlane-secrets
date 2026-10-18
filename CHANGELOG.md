# Changelog

## 1.0.1

### Fixed

- Installs on Termix 26.10.0 and 26.10.1 (plugin API 1.2). Sync now uses your own session there
- Automatic sync runs on Termix 26.10.2 or newer. On older servers the tab says so and Sync now still works

## 1.0.0

### Added

- Connect a Dashlane account with a service device key from `dcli devices register`
- Pick which Dashlane collections to import
- Logins in those collections become Termix password credentials, in a folder per collection and tagged `dashlane`
- Sync on a schedule an admin sets, or with Sync now
- Changed logins are updated, and logins that leave the collections can be deleted from Termix
