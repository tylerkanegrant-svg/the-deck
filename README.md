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

## Notes

- If you forget to set up your `.env` keys, or eBay's API has a hiccup,
  the server just replies with `{ "error": "ebay_unavailable" }`. Your
  frontend is already built to fall back to demo data when that
  happens, so nothing breaks.
- The prices you get back are from **active eBay listings** (asking
  prices), not confirmed sold prices — eBay restricts sold data to
  approved partners. That's why the response includes
  `"isListings": true`.
