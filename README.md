# 🐇 Rabbit Hole

A Firefox extension that turns any highlighted text into an AI-generated rabbit hole — a quick gist, a few surprising facts, follow-up questions, and related topics to dive into. Powered by Google Gemini 2.5 Flash Lite.

## How it works

- Select text on any page → pink "🐇 Down the Rabbit Hole" button appears next to the selection (or right-click → "Down the Rabbit Hole 🐇").
- Firefox's native sidebar fills with a 1-sentence gist, 3 surprising facts, 3 follow-up questions, and 3 related topic chips.
- Click any question, chip, or breadcrumb to dive a layer deeper. A depth badge evolves with emoji + label as you descend.
- Back/forward navigation with `Alt+←` / `Alt+←` — same model as a browser history, with dashed forward-history breadcrumbs.
- Type anything into the ask bar at the bottom for a free-form follow-up.

## Features

- Select-to-explore floating button and right-click context menu
- Sidebar with gist, facts, follow-up questions, and related-topic chips
- "Layers deep" depth badge that evolves as you explore
- Browser-style back/forward with keyboard shortcuts
- In-memory response cache — revisiting a node costs zero API calls
- Client-side rate limiter tuned to the Gemini 2.5 Flash Lite free tier (10 RPM / 250K TPM / 20 RPD), persisted across restarts
- Auto-retry with countdown when the minute cap is hit; friendly "comes back at HH:MM" message when the daily cap is hit
- API key stored locally in `browser.storage.sync` — no third-party server, no telemetry

## Install

1. Clone this repo
2. Open Firefox and go to `about:debugging#/runtime/this-firefox`
3. Click "Load Temporary Add-on"
4. Select `manifest.json` from the cloned folder
5. Open `about:addons` → **Rabbit Hole** → **Preferences** and paste your Gemini API key (grab a free one at https://aistudio.google.com/app/apikey)
6. Click the Rabbit Hole toolbar icon to open the sidebar, then highlight text anywhere to start

## Configuration

Open the extension's **Preferences** page to:

- Set or update your Gemini API key

All other behaviour (rate limits, depth tiers, cache) is tuned in-code and needs no user config.

## Privacy

Rabbit Hole runs entirely in your browser. Your API key is stored in `browser.storage.sync` on your Firefox profile. Requests go directly from your browser to Google's Gemini API. No third-party server sees your traffic, no telemetry, no analytics.

## License

MIT
