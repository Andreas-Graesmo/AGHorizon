# Sync server (Supabase)

"AG Horizon cloud" in Settings › Sync stores each computer's encrypted blob in a Supabase project. The project never sees anything readable: the app encrypts on the computer with a key made from the person's sync code, and the code never leaves their computers. Without a project set up, the app offers only syncing through a folder (Dropbox, iCloud Drive, OneDrive, Google Drive, Syncthing…).

## Setting it up

1. Create a project at [supabase.com](https://supabase.com). Choose a region in the EU (for example Frankfurt).
2. Open **SQL Editor**, paste all of [`sync.sql`](sync.sql) and run it. It's safe to run again after changes.
3. Optional but recommended: **Database › Extensions**, turn on `pg_cron`, then run the `cron.schedule(…)` line at the bottom of `sync.sql`. It deletes vaults nobody has used for 12 months.
4. In **Project Settings › API**, copy the project URL and the publishable (anon) key into [`public/js/sync-config.js`](../public/js/sync-config.js). Both are meant to be public: the key only lets the app call the three sync functions.
5. Build a release. Settings › Sync now offers "AG Horizon cloud" next to "A synced folder".

## What's stored

| Table | Columns | Readable by the project? |
|---|---|---|
| `sync_vault` | random vault id, SHA-256 of the access token, created, last used | Only the random ids and times |
| `sync_blob` | vault id, random device id, updated, encrypted blob (≤ 256 KB) | No: AES-256-GCM with a key that never leaves the computers |

The public key can't read or write the tables (row level security, no policies). Everything goes through `sync_put`, `sync_get` and `sync_delete`, which check the token. A vault holds at most 10 computers. The public key is in the app, so to keep a script from filling the database, at most 10 new vaults are made an hour, and at most 5 a day from one network (its IP address, or the /64 for IPv6). For that, `sync_new_vault` keeps a SHA-256 of the address of whoever made a vault, for a day. A hash of an IPv4 address can be reversed by trying them all, so treat it as the address itself: it is personal data, kept briefly.

Supabase still sees IP addresses in its logs, and when each vault was used. The database keeps a hash of the address that made a vault for one day. Say so in the privacy text, together with the 12-month clean-up.

## Privacy (GDPR)

With people other than you using it, you are the controller of what's stored and Supabase is the processor:

- Accept Supabase's data processing agreement (DPA) in the dashboard, and check how it covers transfers to the US.
- Publish a short privacy text: what is stored (encrypted history, progress, favorites; random ids; IP addresses in logs), why (the person turned sync on), how long (until they delete it, or 12 months unused), and how to delete it (Settings › Sync › Delete synced data).
- Deleting is built in: "Delete synced data" removes the whole vault, "Turn off" removes this computer's copy.

This is general information, not legal advice.

## Testing without a project

For a local test, a page can point at another server: `localStorage.setItem('tuner.syncCloud', JSON.stringify({ url, key }))`. The server must answer `POST /rest/v1/rpc/sync_get|sync_put|sync_delete` like Supabase's REST API.
