# Dashlane for Termix

A [Termix](https://github.com/Termix-SSH/Termix) plugin that imports the logins in your Dashlane collections as Termix credentials and keeps them in sync.

- Connect with a Dashlane service device key (`dcli devices register`), so it works with no one signed in
- Pick which collections to import
- Each login becomes a password credential, filed in a folder named after its collection and tagged `dashlane`
- Each credential also gets a `dashlane:<Dashlane id>` tag that never changes, not on edits, moves or a reimport. The tab shows it under each credential
- With [NetBox Sync](https://github.com/Tabisch/termix-netbox-import), tag a device in NetBox with that same `dashlane:<id>` and its host connects with that login
- Syncs on a schedule an admin sets, or when you press Sync now
- Updates changed logins, and can delete credentials whose login left the collections
- Keep passwords in Dashlane (on by default): credentials hold a `dashlane://<id>/password` reference instead of the password, and Termix asks Dashlane for it when a host connects, like Secret Sources does for 1Password. Nothing secret is stored in Termix

How to set it up and use it: [docs/index.md](docs/index.md).

## Install from GitHub

This repo is its own Termix plugin registry. Add it once and Termix installs the plugin straight from the GitHub releases and offers every new version under Updates.

1. In Termix, open Plugins, Registries and press Add registry.
2. Paste this URL and press Check:

   ```
   https://raw.githubusercontent.com/Tabisch/termix-dashlane-secrets/registry/index.json
   ```

3. Check that the key id Termix shows matches the one in the latest [Registry workflow run](https://github.com/Tabisch/termix-dashlane-secrets/actions/workflows/registry.yml) summary, then press Trust and add.
4. Open Browse, find Dashlane and press Install. Approve the capabilities it asks for.

You can also download `dashlane-secrets-<version>.tmxplug` from [Releases](https://github.com/Tabisch/termix-dashlane-secrets/releases) and install it from Plugins, Install from file, with Plugin developer mode on under Settings, General. A plugin installed that way doesn't update on its own.

### Releasing (maintainers)

Releases are signed with the `TERMIX_PLUGIN_SIGNING_KEY` repository secret. Anyone with this key can publish plugins your registry's users will trust. If you change it later, everyone has to remove and add the registry again.

1. Bump the version in `manifest.json`, `package.json` and a new `CHANGELOG.md` section.
2. Make a `dev-X.Y.Z` branch from `main`, then run the Release workflow from it in Actions. It signs the `.tmxplug`, publishes the GitHub release and merges into `main`. Pick `beta` to publish `X.Y.Z-beta.N` instead, or `dry-run` to check without publishing.
3. The Registry workflow runs after it and writes `index.json` to the `registry` branch. Its run summary shows the registry URL and the key id. Run it by hand from Actions at any time to rebuild the index.

The Registry workflow signs any release that has no `.sig` yet and attaches the `.sig` to it, so every release gets listed. The index's public key is derived from the secret, so there is nothing else to keep in sync.

## How it works

1. The service device key holds your Dashlane login, a device key pair and your master password. It is stored with `ctx.secrets`, encrypted with the Termix installation key, so scheduled syncs can read it.
2. A sync calls Dashlane's `sync/GetLatestContent` API, signed with the device keys, and gets every transaction in the personal vault.
3. Each transaction is decrypted the way the [Dashlane CLI](https://github.com/Dashlane/dashlane-cli) does it: Argon2d or PBKDF2 key derivation, AES-256-CBC with HMAC-SHA256, then raw deflate. That gives the login (`AUTHENTIFIANT`) and collection items as XML.
4. Logins in the chosen collections are written to Termix's `/credentials` API as the user, with a short-lived session from `ctx.auth.issueUserToken`. The plugin keeps a table of which Dashlane item became which credential and a hash of what it wrote, so unchanged logins are not written again.
5. With Keep passwords in Dashlane on, the password written is `dashlane://<id>/password`. The plugin registers the `dashlane` scheme with `ctx.credentials.registerSecretResolver`, so when a host connects Termix hands it the reference and the credential's owner. It reads that user's vault (cached in memory for 30 seconds) and returns the password.

Capabilities it asks for:

| Capability          | Why                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| `users:impersonate` | A short-lived Termix session per sync, to create, update and delete the user's credentials as that user. |
| `auth:provide`      | Resolve `dashlane://` references in credentials when a host connects.                                    |
| `network:outbound`  | Reach `api.dashlane.com`, and Termix's own API on `127.0.0.1`.                                           |
| `secrets:own`       | Store each user's device key encrypted.                                                                  |
| `db:own`            | Remember which credential each Dashlane login became.                                                    |
| `network:serve`     | The tab's API routes.                                                                                    |
| `ui:surface`        | The Dashlane tab.                                                                                        |

### Things to know

- Dashlane doesn't document how collections are stored. The plugin reads a collection's `Name` and treats every item id inside it as a member, so it does not depend on the exact element names. If a Dashlane update breaks this, the tab shows collections with 0 logins.
- Only the personal vault is read. Items and collections shared with you (Dashlane's sharing API) are not imported yet.
- Requests are signed with the Dashlane CLI's public application keys, because a service device key belongs to the CLI's application. See [NOTICE](NOTICE).

## Development

You need Node 24 and npm 11. npm 10 fails to resolve the dev dependency tree with `Cannot read properties of null (reading 'edgesOut')`.

```bash
npm install
npm test
npm run typecheck
npm run validate
npm run build
```

To try it on a Termix server (26.10 or newer) with Plugin developer mode on:

```bash
npx termix-plugin dev --server http://localhost:30001 --key tmx_your_key
```

Or `npm run build && npm run pack`, then install the `.tmxplug` from Plugins, Install from file.

The tests fake both Dashlane and Termix behind `ctx.fetch` and serve real encrypted vaults (see `tests/backend/fixtures.ts`), so signing, decryption, parsing and the credential calls all run in them.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
