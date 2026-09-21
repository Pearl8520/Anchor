# Anchor

A standalone Modmail Discord bot. Lets server members message staff privately through the bot's DMs, with each conversation turning into its own thread on the server.

## Features

- **Categories** — a server can run multiple Modmail categories (e.g. Support, Reports), each with its own parent channel, staff role, and transcript channel.
- **Threads** — every DM to the bot opens a thread; staff reply from inside it and the message relays back to the user's DMs, and vice versa.
- **Reply / Real Reply** — normal replies show the responding staff member's identity (or a role picked via `/mail-role`); Real Reply sends anonymously as the server itself.
- **Claim / Unclaim** — staff can claim a thread so it's clear who's handling it.
- **Snippets** — saved canned responses staff can send, add, edit, delete, or list per server.
- **Suspend / Unsuspend** — pause a thread without closing it.
- **Blocking** — block/unblock a user from opening new threads, with a reason staff can see but the user never does.
- **Reminders** — optional pings for threads that have gone quiet past a configurable hour threshold.
- **Transcripts** — full conversation logs, plus a public log-link a user can be given after their thread closes. `/mail action:transcript` sends a plain `.txt` file straight to Discord; `/mail action:log-link` gives a proper formatted web page instead, served by the bot's own built-in API.
- **Legacy log import** — optional read-only support for importing transcripts from an existing Dragory/modmailbot SQLite database, so old log links keep working if you're migrating from one.
- **Typing relay** — DM-to-thread typing indicators relay live (one-directional by design).

## Commands

- **`/modmail action:<...>`** — server setup: add/rename/remove categories, set guild-wide or per-category staff roles, set the transcript/attachment channel, enable/disable reply pings and reminders, post the intake panel, block/unblock a user, view a user's history, link/unlink a main server, and enable/disable/reset the whole module. Requires Manage Server.
- **`/mail action:<...>`** — thread actions run from inside an open thread (or a category channel for Open/Reopen): reply, real reply, edit a reply, close, open, reopen, move category, claim/unclaim, suspend/unsuspend, pull a transcript, get the log link, view logs, add/remove a staff member on the thread, and the full snippet set (send/add/edit/delete/list/view). Typing `/mail reply <text>` directly as a message also works as a shortcut.
- **`/mail-role role:<...>`** — pick which of your own roles shows as your identity on non-anonymous replies, or "Default".

## Tech Stack

- **Bot:** Node.js, TypeScript, discord.js v14
- **Storage:** MongoDB (primary), better-sqlite3 (legacy log import only)
- **API:** Express, Discord OAuth — powers the log-link viewer and staff authentication

## Setup

1. Install dependencies: `npm install`
2. Rename `config.env` to `.env` (or `dev.env` for local development) and fill in the following variables:

   | Variable | Purpose |
   |---|---|
   | `CLIENT_TOKEN` | Your bot's login key from Discord's Developer Portal |
   | `MONGO_URI` | The address of your MongoDB database |
   | `MONGO_DB` | The name of the database to use |
   | `LEGACY_LOG_DB_PATH` | File path to an old modmailbot-based bot's saved conversation logs, if migrating from one, so old log links keep working |
   | `PORT` | Which port the bot's web server runs on |
   | `OWNER_ID` | Your own Discord account ID (the bot owner) |
   | `DEV_ID` | The developer's Discord account ID |
   | `ALERT_CHANNEL_ID` | The Discord channel ID where the bot posts error alerts |
   | `DISCORD_CLIENT_ID` | Your bot's application ID, used for the log-link viewer's login |
   | `DISCORD_CLIENT_SECRET` | Your bot's application secret, used for the log-link viewer's login |
   | `DISCORD_REDIRECT_URI` | Where Discord sends people back to after logging in |
   | `DASHBOARD_URL` | The web address this bot's own API is reachable at — used to build `/mail action:log-link` links |
   | `SESSION_COOKIE_SECRET` | A random string used to keep sessions secure |

3. Run it:
   - `npm run dev` — local development (uses `dev.env`)
   - `npm run prod` — production (installs deps, builds, and starts)
   - `npm run start:built` — build and start without reinstalling dependencies

## License

ISC
