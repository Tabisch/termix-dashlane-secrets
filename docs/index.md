Dashlane imports the logins in your Dashlane collections as Termix credentials and keeps them in sync. You pick the collections, and each login becomes a password credential you can use on any host.

## Before you start

You need the [Dashlane CLI](https://cli.dashlane.com/install) on any computer, just once, to make a service device key. Sign in to it with the Dashlane account you want to import from, then run:

```bash
dcli devices register "Termix"
```

It prints a line like `DASHLANE_SERVICE_DEVICE_KEYS=dls_...`. Copy the `dls_...` part. Dashlane shows the key once.

The key carries your master password, so treat it like one. Termix stores it encrypted on the server and never shows it again. To revoke it, remove the device in Dashlane (or run `dcli devices remove`), then press Disconnect in Termix.

## Connect

1. Install Dashlane from the Plugins tab.
2. Open the Dashlane tab from the sidebar.
3. Paste the key into Service device key and press Connect.

Termix reads your vault once to check the key and lists your collections.

## Pick collections

Tick the collections to import and press Save. Then press Sync now.

Every login in a chosen collection becomes a credential:

| Termix field | From Dashlane                                      |
| ------------ | -------------------------------------------------- |
| Name         | The login's title, or else the website's host name |
| Username     | Login, or else Email, or else Secondary login      |
| Password     | Password, or a reference to it (see below)         |
| Description  | Website                                            |
| Folder       | The collection's name                              |
| Tags         | `dashlane` and `dashlane:<id>`                     |

`<id>` is the login's Dashlane id, like `dashlane:8A1B2C3D-0000-4000-8000-1234567890AB`. It never changes: not when the login is edited, not when its collection changes, and not when Termix makes the credential again. So other tools can find the credential by that tag. The tab lists the tag under each imported credential, ready to copy. The [NetBox Sync](https://github.com/Tabisch/termix-netbox-import) plugin uses it to give NetBox hosts a credential: tag a device in NetBox with `dashlane:<id>`.

A login in several chosen collections goes in the folder of the first one you ticked. Logins without a password are skipped and counted under skipped.

## Keep passwords in Dashlane

Keep passwords in Dashlane, under the collections, is on to start with. It keeps the passwords out of Termix, the way the Secret Sources plugin does for 1Password: each credential gets a reference instead of the password, like `dashlane://8A1B2C3D-0000-4000-8000-1234567890AB/password`. When a host using the credential connects, Termix asks this plugin for the password, and it reads it from your vault right then.

- No password is written to Termix's database. Passwords are held in memory for about a minute after a connect, so connecting to several hosts at once asks Dashlane only once.
- A changed password in Dashlane works on the next connect, without waiting for a sync.
- Connecting needs Dashlane to be reachable and your device key to work. If it isn't, the connect fails and says why.
- Only logins in the collections you import resolve. Untick a collection, or disconnect, and its references stop working.
- A reference resolves with the vault of the credential's owner, also when the credential is shared.
- Turn it off and press Save to store the passwords in Termix instead: the next sync writes them into the credentials, and connecting no longer needs Dashlane. Accounts connected before version 1.2.0 have it on too, so their next sync swaps the stored passwords for references.

You can also type a reference into a credential or host password yourself, as long as the login is in a collection you import.

## Keeping in sync

Termix syncs every connected account on a schedule, every 60 minutes by default. Admins set the interval in Settings, under Dashlane. 0 turns automatic sync off, and people press Sync now themselves.

On each sync:

- New logins in the chosen collections are added.
- Logins that changed in Dashlane are updated in Termix. Dashlane wins: an edit you make to an imported credential in Termix is overwritten the next time that login changes in Dashlane.
- If you delete an imported credential in Termix, it comes back the next time its login changes in Dashlane.
- With Delete credentials that leave these collections on (the default), a credential whose login left the chosen collections, or was deleted in Dashlane, is deleted from Termix. Only credentials this plugin imported are ever deleted. With it off, they stay and are no longer synced.
- If part of the vault can't be decrypted, nothing is deleted on that run.
- If a chosen collection is gone from Dashlane, its credentials are kept and the tab marks it Not in the vault any more. Untick it and press Save to delete them.

The tab shows when the last sync ran, what it changed, and why it failed if it did.

## Disconnect

Press Disconnect to delete the device key from Termix and keep the imported credentials, or Disconnect and delete imported credentials to remove those too. With Keep passwords in Dashlane on, credentials you keep can't connect any more, since their references no longer resolve.

## What it can't import

- Only your personal vault. Logins other people shared with you, and collections shared with you, are not read yet.
- Only logins. Secure notes, secrets, passkeys and payment items are left out.

## Permissions

Using the tab needs the Use Dashlane permission, which admins and users get by default. Importing also needs Termix's own credentials permissions (create, edit and delete credentials), because the credentials are made as you.

## Troubleshooting

- Not a Dashlane service device key: paste only the part from `dls_` on, or the whole line dcli printed.
- The vault could not be decrypted: the master password changed since the key was made. Register a new device and connect again.
- Dashlane refused the device: it was removed in Dashlane. Register a new one.
- Termix refused to create a credential (403): you don't have the credentials permissions. Ask an admin.
- Connecting fails with "Dashlane login ... is not in a collection you import": the login left your chosen collections, or has no password any more. Tick its collection again, or pick another credential.
