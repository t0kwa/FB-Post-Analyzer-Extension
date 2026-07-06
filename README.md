FB Page Keyword Analytics — Chrome Extension
Scans the Facebook posts you've already scrolled into view on the current
page/tab, finds ones matching a keyword, and totals up their reactions,
comments, and shares.

How it works (and its limits)
You log into Facebook normally, in your normal browser tab. The extension
never touches your login — it only reads the page after you're
already on it.

Two scan modes:

Quick scan — reads only whatever posts are currently loaded on
screen. Fast, but you need to manually scroll first to load more posts.
Auto-scan — the extension scrolls the page for you, gradually,
with a randomized delay between steps (so it isn't hammering the page),
re-scanning after every scroll and streaming newly found matches into
the popup live. It stops automatically when it reaches the bottom of
what Facebook will load, when you click Stop, when you close the
popup, or after a safety cap of scroll passes (to avoid it running
forever unattended).

Reaction/comment/share counts are read from the numbers Facebook displays
on-screen. Facebook's HTML structure is obfuscated and changes over time,
so counts can occasionally be missed or read as 0 if their markup shifts —
you may need to tweak the selectors in `content.js`.

This reads only what's rendered in your browser; it doesn't call any
private Facebook API and doesn't bypass any login or security barrier.
Heads up: Facebook's Terms of Service restrict automated data
collection from the platform, even when done via a passive DOM reader like
this. This tool is intended for scanning your own view / pages you manage,
at a small, manual scale (not high-volume or continuous scraping). If you
need reliable, ToS-compliant analytics — especially at scale, or for pages
you administer — use Meta's official Graph API / Meta Business Suite
Insights, which expose reactions, comments, and shares directly and
without this kind of DOM guesswork.

Install (unpacked, for development/testing)
Open `chrome://extensions` in Chrome.
Turn on Developer mode (top-right toggle).
Click Load unpacked and select this folder.
Pin the extension from the puzzle-piece icon in the toolbar.

Use
Go to `facebook.com`, log in, and navigate to the page you want to check.
Click the extension icon.

Type a keyword.
Either:
Click ▶ Auto-scan (scroll & collect) and let it run — it will
scroll, collect matches, and update the list live until it finishes or
you click Stop; or

Click Quick scan (visible posts only) to just check what's already
loaded, scrolling manually between scans if you want more coverage.
Matching posts and totals (reactions/comments/shares) appear in the
popup as they're found.

Note: closing the popup while auto-scan is running will stop it (Chrome
tears down the connection between the popup and the page), so keep the
popup open — or open it in its own window/tab if your Chrome version
supports "Open in new window" — while a scan is in progress.

Files

`manifest.json` — extension configuration (Manifest V3)
`popup.html` / `popup.js` — the toolbar popup UI
`content.js` — reads the Facebook page DOM and extracts matching posts + metricss