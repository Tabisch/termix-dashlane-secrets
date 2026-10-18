# Changelog

## 1.1.0

### Added

- Every imported credential is tagged `dashlane:<id>` with its Dashlane id, which stays the same across syncs and when a credential is made again. The tab shows it under each credential. Credentials imported before get the tag on the next sync

## 1.0.0

### Added

- Connect a Dashlane account with a service device key from `dcli devices register`
- Pick which Dashlane collections to import
- Logins in those collections become Termix password credentials, in a folder per collection and tagged `dashlane`
- Sync on a schedule an admin sets, or with Sync now
- Changed logins are updated, and logins that leave the collections can be deleted from Termix
