# The Deck — Backend

This is a small server that looks up trading card prices on eBay for
your frontend (`the-deck-v4.html`) to use.

## 1. Get your eBay API keys

1. Go to https://developer.ebay.com and sign up / log in with your
   regular eBay account.
2. Click **"Get an API key"** (or go to **My Account > Application
   Keys**).
3. Click **Create a keyset**, and choose **Production** (not
   Sandbox — Sandbox has fake test data, Production has real listings).
4. You'll get a page with several values. You only need two of them:
   - **App ID (Client ID)**
   - **Cert ID (Client Secret)**

Keep this page open — you'll copy these two values in the next step.

## 2. Set up your `.env` file

In this folder, there's a file called `.env.example`. Make a copy of it
named `.env`:

```bash
cp .env.example .env
```

Open `.env` in a text editor and paste in your keys so it looks like
this:

```
EBAY_CLIENT_ID=YourAppIdGoesHere
EBAY_CLIENT_SECRET=YourCertIdGoesHere
JWT_SECRET=SomeLongRandomStringGoesHere
```

`JWT_SECRET` is used to sign login sessions for accounts (see below) —
it can be any long random string. Generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Save the file. `.env` is already listed in `.gitignore`, so it will
never get committed to git or uploaded anywhere — your keys stay
private.

## 3. Install and run

Open a terminal in this folder and run:

```bash
npm install
npm start
```

You should see:

```
The Deck backend running on http://localhost:3001
```

Leave that terminal window open while you use the app — that's your
server running.

## 4. Try it out

With the server running, open this in your browser:

```
http://localhost:3001/api/price?q=LaMelo+Ball+Prizm
```

You should get back JSON with card prices. Then open your
`the-deck-v4.html` file like normal — it will call this server
automatically.

## Accounts, usage limits, and the admin dashboard

The backend now has real accounts, stored in a local file called
`data.db` (a SQLite database — it's created automatically the first
time you run the server). It's in `.gitignore`, so it never gets
committed.

**Important:** if you deploy this to a free host like Render, that
host's disk is usually wiped every time it restarts or redeploys —
which means everyone's accounts would get deleted too. This is fine
for testing, but before you rely on this for real users, ask about
adding a persistent disk (or a hosted database) so accounts don't
disappear.

**Endpoints:**
- `POST /api/signup` — `{ email, password, ref? }` → creates an
  account (starts on a 30-day free trial) and returns a login token.
- `POST /api/login` — `{ email, password }` → returns a login token.
- `GET /api/me` — with `Authorization: Bearer <token>` → your account
  info and this week's usage.
- `POST /api/use` — `{ feature }` (one of `grading`, `valuing`,
  `auction`, `search`) → checks whether you're allowed to use that
  feature right now, and records it if so.

**Admin dashboard:** open `http://localhost:3001/admin.html` and sign
in with an account whose email is exactly `admin@thedeck.com` (sign
one up via `/api/signup` first). Every other account gets "Access
Denied." There's currently no way to upgrade a real account's plan
from `trial`/`free` to `pro` yet (no payments are wired up) — that's
intentionally left for later.

## Notes

- If you forget to set up your `.env` keys, or eBay's API has a hiccup,
  the server just replies with `{ "error": "ebay_unavailable" }`. Your
  frontend is already built to fall back to demo data when that
  happens, so nothing breaks.
- The prices you get back are from **active eBay listings** (asking
  prices), not confirmed sold prices — eBay restricts sold data to
  approved partners. That's why the response includes
  `"isListings": true`.
