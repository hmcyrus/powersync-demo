# Assessing the PowerSync POC

This note is for someone deciding whether a small to-do demo is evidence that PowerSync can carry a SaaS product. The product goal is stated first. The rest explains the machinery in the terms that change that decision.

## Product goal

The platform’s apps must keep working when the network is gone. A customer who already has data on the device can read and edit with no spinner, no error, and no extra tap to sync. When the network returns, their changes reach the server on their own, and other devices catch up on their own.

The same product ships in the browser and as Android and iOS apps.

The POC is a single shared to-do list on the web. It is a probe of that machinery, not a prototype of the product.

## How the system actually moves data

The screen never reads or writes Postgres directly. It reads and writes a SQLite database that lives on the device. The list updates because the app watches that local database.

Two separate pipes keep that local database aligned with the server.

**Server to device.** Postgres is the source of truth. It emits a change log (logical replication). The PowerSync service turns those changes into a feed for each client. The client applies the feed to local SQLite. The screen updates because it is watching SQLite.

**Device to server.** A local write is applied to SQLite immediately, and a copy of the write is placed in an upload queue on the device. The PowerSync client later calls a function the app owns, `uploadData()`. That function sends the queued writes to the application API. The API writes Postgres. PowerSync does not write Postgres for the app.

MongoDB in this POC is scratch space for the PowerSync service (its “bucket” store). It is not the to-do database. The to-dos live in Postgres. If the bucket store is wiped, the service can rebuild it from Postgres. If Postgres is wiped, the to-dos are gone.

```text
screen  →  local SQLite  →  upload queue  →  application API  →  Postgres
                ↑                                                    |
                └──────── sync feed ← PowerSync service ←───────────┘
```

Until a write has traveled the whole loop (API, Postgres, replication, sync feed, back into SQLite), other devices cannot see it. The device that made the write already shows it, because it wrote SQLite first.

## What “no visible interruption” can mean

After the first successful sync, with data already on the device:

- Reading does not use the network.
- An edit appears on screen immediately.
- The edit stays on screen across a reload or an app restart.
- The app does not ask the customer to sync.
- While offline, the edit sits in the upload queue.
- When the network is back, the client reconnects, uploads the queue, and pulls everyone else’s changes.

That is the behavior this architecture can deliver. Several things still show up on screen unless the product is designed around them.

**First launch is empty.** A new install has an empty SQLite file until the first sync finishes. The customer sees an empty list, then rows appear. That wait is real. The offline promise starts after this first fill, not before it.

**The server can change what the customer just saw.** The local screen shows the local write at once. Later the sync feed delivers whatever Postgres actually stored. If the API changes a field, rejects a write, or keeps someone else’s newer write, the row on screen updates to match the server. The customer sees their edit land, then change or disappear, with no error at the moment they tapped. This is the main way an offline app still “interrupts” someone.

**The upload queue is a single file line.** Writes leave the device in order. If one write fails with a server error and the client keeps retrying it, every newer write waits behind it. The author’s screen still looks fine. Other people simply never receive the later edits. A permanent failure has to be settled (accepted, or dropped with a 2xx response) or that customer’s queue stays stuck.

**Another person offline is not a live collaborator.** Two customers can change the same row with no network. Each screen shows its own edit. When both reconnect, Postgres keeps one result. The sync feed then corrects the other screen. Last-write-wins is the POC’s rule. A SaaS product has to choose that rule explicitly. The customer whose edit loses will see it happen late, not at edit time.

**Coming back online is silent only if the app allows it.** The client reconnects by itself. If the screen is wired to local SQLite, the customer keeps working during the catch-up. If the screen waits for “connected” before it shows or saves, the customer feels the network even though the database does not need it.

## What this POC is able to show

Watch the demo in five moments. Each moment maps to one claim.

| Moment | Claim it supports |
| --- | --- |
| Add, toggle, delete, then reload, with no backend | The screen is bound to local SQLite, so a reload is not a fetch. |
| Insert a row in Postgres and see it appear in the browser with no refresh | The server-to-device pipe works: replication, PowerSync, sync feed, local SQLite, screen. |
| Same row appears in a private window or a second browser | A second client gets the feed on its own. Two tabs in one browser window do not count: on the web SDK they share one SQLite file. |
| Turn the in-app switch to Offline, edit, and see Postgres stay unchanged while the list changes | The upload queue holds writes instead of dropping them. The switch only blocks the call to the API. The sync connection stays up so the client keeps trying. |
| Turn the switch back to Online and see Postgres match, then see the other window update with no refresh | The device-to-server pipe and the return path both work, including a retry. |

The in-app Offline switch is not airplane mode. It fails the API call on purpose and leaves the PowerSync connection running. That is the right test for “the queue retries.” It is a weaker test than killing Wi-Fi.

A full offline test, after the list has already synced once: turn the device network off, edit, confirm the screen stays responsive and shows no error, turn the network on, confirm the other client receives the edit without anyone pressing sync. The POC is built so that this can work, because local writes do not wait for the API. Treat that test as part of the assessment even though the scripted switch is narrower.

## Internal details that decide a go or no-go

These are the facts that make a green demo still a weak signal for the SaaS, or a strong one.

**Reads and writes are authorized in different places.** The sync feed decides which rows are copied onto the device. The application API decides which uploads Postgres accepts. A customer who passed the sync rule still has a full copy of those rows in a local database file, including while offline. Removing a column from the API response does nothing if that column is in the sync query: it is already on the device. Logout on a shared device has to delete that local database, or the next person can read it.

**This POC copies every to-do to every client.** The sync query is “all rows in `todos`,” and the API does not check who is calling. That is correct for the demo. It is the wrong shape for a multi-tenant SaaS. The production shape is: the token identifies the user, the sync query returns only that tenant’s rows, and the API refuses uploads that fall outside the same boundary. The POC does not exercise either check. Copying the demo’s sync query into production would publish one customer’s data to all customers.

**The API must tolerate retries.** The queue sends the same write again when a response is lost. The POC does that with a client-generated id and an insert that means “create this id, or replace it if it is already there.” Production writes need the same idea. A create that allocates a new server id on every retry will duplicate rows.

**An update does not send the whole row.** The queue sends the columns that changed. The API has to update those columns and leave the others alone. Replacing the whole row will wipe title, owner, or timestamps the client did not touch. This is a common way to “pass” a demo and corrupt data later.

**Validation has a visible cost.** If the API answers “rejected” with an error status, the client retries forever and the queue stalls behind that write. If the API answers success and ignores the write, the local screen keeps the invalid edit until a later sync feed overwrites it. Either path is visible to someone. The POC avoids the choice by accepting almost every write. The product cannot.

**A token for the sync connection is not the app’s login session, and it cannot be long-lived.** The service refuses a token whose lifetime is over 24 hours. The client asks the app for a fresh token when it connects and when the current one is near expiry. The POC signs that token inside the web page with a shared secret. That proves the connection handshake only. A production app gets the token from its own backend after a real login. Offline, an expired sync token is refreshed on the next connect; it must not block local reading and editing.

**Postgres must keep a replication slot healthy.** The PowerSync service reads Postgres’s change log. If the service is down for a long time, Postgres retains log data for it and disk use grows. Tables need a primary key so updates and deletes can be replicated. The POC turns this log on and creates one table. It does not show monitoring, failover, or schema change.

**Schema changes ship to every installed app.** Adding a column means changing Postgres, the sync query, and the SQLite schema in every client build. Phones run old builds for a long time. The POC has one schema and one web client, so it never shows a mixed-version fleet.

**Files do not ride along in the row.** The sync feed moves table rows. Photos, PDFs, and other blobs need a separate path. Nothing in this POC covers them.

## Browser, Android, and iOS

The pipes above are the same on every platform. The sync service, the Postgres log, the sync query, and the upload API are shared. A second client in a private window is evidence that the feed is per client, which is the same idea as a second phone.

The on-device library is not shared.

- The POC uses the web library: SQLite compiled to WebAssembly, plus a shared worker. All tabs of one browser profile are one database. That quirk does not exist on phones.
- Android and iOS use their own PowerSync libraries (Kotlin, Swift, or a React Native / Capacitor shell around a client). They persist SQLite in app storage. The same two functions exist on each: fetch a sync token, and upload the queue.
- A store app built by wrapping this web page still has the browser’s storage and background limits. A Kotlin or Swift client does not. The POC does not choose or prove which of those the product will ship.
- On phones the operating system suspends the app. Catch-up runs when the app is in use again. The customer should still see their last local data immediately on open, then see remote changes arrive. The POC never goes to the background, so it does not show this.

What transfers from a web POC to the native apps: the Postgres schema, the sync query, the upload API contract (client ids, partial updates, idempotent writes, queue-friendly status codes), and the rule that the screen reads only local SQLite.

What does not transfer: the web build, the shared-secret token, the in-app Offline switch, and any assumption that two tabs are two users.

## How to score it

Count the POC as positive evidence if all five moments in the table above happen, plus a real network-off edit that stays on screen and later reaches the other client by itself.

Count it as evidence of the following, and no further:

- Local SQLite can be the only database the screen uses.
- The server-to-device feed works on the web, including a second client profile.
- The device-to-server queue survives a failed API and flushes when the API is available again.
- The application API, not PowerSync, is what writes Postgres, and that API must be idempotent and must apply partial updates.

Do not count it as evidence for tenant isolation, login, rejected-write behavior, conflict policy, file sync, schema evolution, replication operations, or Android / iOS packaging. Those decide whether the SaaS feels uninterrupted in production. They are still open after a fully green demo.
