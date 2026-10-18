# AGENTS.md

This repo is a [Termix](https://github.com/Termix-SSH/Termix) plugin. These notes are for AI coding tools.

## Read first

Before changing anything, read `node_modules/@termix-ssh/plugin-sdk/PLUGIN-GUIDE.md`. It covers the
manifest, backend, database, frontend, UI, testing, releasing and submitting to the community registry,
and it matches the SDK version installed here. If it is missing, run `npm install`. If it is still missing,
the SDK is older than 1.0.6: run `npm install -D @termix-ssh/plugin-sdk@latest` or read
https://docs.termix.site/develop instead.

If the guide and the SDK's TypeScript types disagree, the types are right.

## Commands

```bash
npm run build        # bundle into dist/
npm test             # run the tests
npm run typecheck    # type check
npm run validate     # check manifest.json, migrations, changelog and docs
npm run migrations   # write migrations after changing src/backend/tables.ts
npm run pack         # write <id>-<version>.tmxplug
npm run format       # format with Prettier
```

`npx termix-plugin dev --server <url> --key <tmx_...>` installs the plugin on a Termix server with
developer mode on and reinstalls it on every save. Don't start it unless the user asks.

## Done means

- `npm test`, `npm run typecheck`, `npm run validate`, `npm run build` and `npm run format:check` pass
- `npx termix-plugin migrations --check` passes
- New UI text is in `locales/en.json`, new routes have an `@openapi` block and a test
- `docs/` and the section below still match what the plugin does
- User facing changes are in `CHANGELOG.md` under the version they ship in

## About this plugin

Keep this section current when the plugin changes: what it does, how it is put together, decisions that
aren't obvious from the code, and anything that has bitten you before.

- What it does: imports the logins in chosen Dashlane collections as Termix password credentials and keeps
  them in sync, per user, on a schedule or on demand.
- `src/backend/dashlane/`: the Dashlane side. `device-key.ts` parses `dls_...` service device keys,
  `api.ts` signs and sends `sync/GetLatestContent` with `@dashlane/apiconnect-worker` over `ctx.fetch`,
  `crypto.ts` decrypts Dashlane's `$1$...` payloads (ported from the Dashlane CLI, Apache-2.0),
  `vault.ts` turns transactions into logins and collections.
- `core-credentials.ts`: Termix's `/credentials` API on `127.0.0.1:30001` with a token from
  `ctx.auth.issueUserToken`. The SDK can only create SSH key credentials, so this is the only way to write
  password credentials.
- `sync.ts`: picks logins by collection name (case-insensitive), creates, updates (recreates on 404) and
  removes credentials, and records a hash per item so unchanged logins cost nothing. Nothing is removed on a
  run where some transaction failed to decrypt.
- `schedule.ts`: a one-minute tick that syncs connections older than the admin interval, each inside
  `ctx.asUser`. It never throws, so a broken account can't spend the error budget.
- Every credential carries `dashlane` and `dashlane:<id>` (`credentialIdTag`, the normalized Dashlane id,
  upper case, no braces). The id tag is a public contract: NetBox Sync assigns credentials to hosts by it, so
  never change its format.
- Password references (`connections.passwordReferences`, on by default, also for rows from before 1.2.0): the sync writes
  `dashlane://<id>/password` (`passwordReference`) instead of the password, and `resolver.ts` answers the
  `dashlane` scheme via `ctx.credentials.registerSecretResolver` (`auth:provide`). Termix calls it at host
  resolution with the credential owner's id; it reads their key with `ctx.asUser`, fetches the vault,
  and only answers for logins in their chosen collections. Vaults are cached in memory for 30s per user
  (Termix adds its own 60s cache) and `forget` drops them on connect, config change and disconnect.
  Never persist resolved passwords.
- Collections are not documented by Dashlane: a collection's members are every GUID written anywhere in it
  except its own `Id` and `SpaceId`. Keep that tolerant.
- `json()` columns are plain text: the repository `JSON.stringify`s on write.
- Use npm 11 to install. npm 10 crashes resolving the dev dependency peer set.
- Releases: run the Release workflow (shared `plugin-release.yml` from Termix-Registry) from a `dev-X.Y.Z`
  branch. `.github/workflows/registry.yml` then runs `scripts/build-registry.mjs` (copied from
  Tabisch/termix-netbox-import) and pushes `index.json` to the `registry` branch, so the repo is its own
  custom registry. It lists only releases whose `.tmxplug.sig` verifies against `TERMIX_PLUGIN_SIGNING_KEY`
  and derives the index's `publicKey` from that secret. Changing the secret breaks every install.
  `--sign-missing` signs and attaches a `.sig` for any release built without one.
