# Changelog

## 1.2.1

### Fixed

- The plugin stopped on start with "cannot register secret scheme "dashlane": it is not listed in contributes.auth.secretSchemes". The manifest now declares the `dashlane` scheme

## 1.2.0

### Added

- Keep passwords in Dashlane: credentials get a `dashlane://<id>/password` reference instead of the password, and the password is read from Dashlane each time a host connects, like the Secret Sources plugin does for 1Password. No password is stored in Termix. On by default, also for accounts connected before, so their next sync swaps the stored passwords for references. Turn it off per user in the tab. The plugin now asks for the `auth:provide` capability to resolve the references

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
