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
- **Transcripts** — full conversation logs, plus a public log-link a user can be given after their thread closes.
- **Legacy log import** — optional read-only support for importing transcripts from an existing Dragory/modmailbot SQLite database, so old log links keep working if you're migrating from one.
- **Dashboard** — a companion website (`website/`) with Discord OAuth login, letting staff manage servers and read transcripts from a browser instead of Discord itself.
- **Typing relay** — DM-to-thread typing indicators relay live (one-directional by design).

## Commands

- **`/modmail action:<...>`** — server setup: add/rename/remove categories, set guild-wide or per-category staff roles, set the transcript/attachment channel, enable/disable reply pings and reminders, post the intake panel, block/unblock a user, view a user's history, link/unlink a main server, and enable/disable/reset the whole module. Requires Manage Server.
- **`/mail action:<...>`** — thread actions run from inside an open thread (or a category channel for Open/Reopen): reply, real reply, edit a reply, close, open, reopen, move category, claim/unclaim, suspend/unsuspend, pull a transcript, get the log link, view logs, add/remove a staff member on the thread, and the full snippet set (send/add/edit/delete/list/view). Typing `/mail reply <text>` directly as a message also works as a shortcut.
- **`/mail-role role:<...>`** — pick which of your own roles shows as your identity on non-anonymous replies, or "Default".

## Tech Stack

- **Bot:** Node.js, TypeScript, discord.js v14
- **Storage:** MongoDB (primary), better-sqlite3 (legacy log import only)
- **API:** Express, Discord OAuth (for the dashboard)
- **Website:** Vite + React (`website/`), talks to the bot's own API over CORS

## Setup

1. Install dependencies: `npm install`
2. Rename `config.env` to `.env` (or `dev.env` for local development) and fill in the following variables:

   **Core bot** — needed either way:

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

   **Dashboard website** — only needed if you're running the `website/` login/dashboard:

   | Variable | Purpose |
   |---|---|
   | `DISCORD_CLIENT_ID` | Your bot's application ID, used for website login |
   | `DISCORD_CLIENT_SECRET` | Your bot's application secret, used for website login |
   | `DISCORD_REDIRECT_URI` | Where Discord sends people back to after logging into the website |
   | `DASHBOARD_URL` | The web address where the dashboard website is hosted |
   | `SESSION_COOKIE_SECRET` | A random string used to keep website logins secure |

3. Run it:
   - `npm run dev` — local development (uses `dev.env`)
   - `npm run prod` — production (installs deps, builds, and starts)
   - `npm run start:built` — build and start without reinstalling dependencies

## Website

`/mail action:transcript` will technically work with no web server at all — it sends a plain `.txt` file straight to Discord, one raw line per message (timestamp, direction, author ID, body). It's not a real formatted transcript view though, just a bare text dump.

For an actual properly displayed transcript, you need the web side up: `/mail action:log-link` hands back a `${DASHBOARD_URL}/logs/...` link, served by the bot's own built-in API (always running as part of this bot's process). That's what shows transcripts correctly, so in practice the webpage isn't really optional if you want transcripts to look right — set `DASHBOARD_URL` to wherever you're actually hosting it.

The separate login/staff dashboard in `website/` is its own thing on top of that — `cd website && npm install && npm run dev` to run it locally. It talks to this bot's API (`/api/auth`, `/api`) over CORS, configured for your `DASHBOARD_URL` and `http://localhost:5173`.

## License

ISC
