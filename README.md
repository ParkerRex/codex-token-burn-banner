# Codex Token Burn Banner

Generate local Codex usage graphics and optionally post them to X.

The app reads local Codex session JSONL files, aggregates token usage by local
calendar day, renders PNG summaries, and can publish those images with
user-owned X API credentials. It can also install macOS LaunchAgents for
scheduled posting.

## What It Does

- Scans `~/.codex/sessions` and `~/.codex/archived_sessions`.
- Parses Codex `event_msg` rows with `token_count` payloads.
- Aggregates input, cached input, and output tokens by day.
- Estimates API-equivalent spend from the model pricing table in
  `src/codexUsage.js`.
- Renders:
  - `outputs/codex-token-burn-banner.png` for an X profile banner.
  - `outputs/agent-screen-time.png` for a daily activity/feed image.
- Optionally posts to X using OAuth 1.0a user-context credentials.

If `codexbar` is installed, the app tries `codexbar cost --provider codex`
first for banner usage. If that fails, it falls back to the built-in local
scanner.

## Requirements

- macOS for LaunchAgent scheduling.
- Bun for install and scripts.
- Node.js 20 or newer for the CLI runtime.
- Local Codex logs in `~/.codex`, or a custom path passed with `--codex-home`.
- X developer credentials with write permission.

The X client uses:

- `POST /2/tweets` for posting.
- `POST /1.1/media/upload.json` for image uploads.
- `POST /1.1/account/update_profile_banner.json` for banner updates.

## Setup

```sh
git clone https://github.com/ParkerRex/codex-token-burn-banner.git
cd codex-token-burn-banner
bun install
cp .env.example .env
```

Fill `.env` with your own X OAuth 1.0a user-context credentials:

```sh
X_API_KEY=
X_API_SECRET=
X_ACCESS_TOKEN=
X_ACCESS_TOKEN_SECRET=
```

Then verify credentials:

```sh
bun run verify-x
```

## Commands

```sh
bun run scan
bun run render
bun run daily
bun run daily:tweet -- --dry-run
bun run once -- --dry-run
bun run once -- --upload
bun run once -- --upload --tweet --tweet-image
bun run test
```

Useful direct CLI calls:

```sh
node src/index.js scan --json
node src/index.js once --no-codexbar
node src/index.js once --codex-home ~/.codex
node src/index.js render --output outputs/today.png
node src/index.js activity --day 2026-05-19
node src/index.js activity --yesterday --tweet --dry-run
node src/index.js activity --day 2026-05-19 --highlight "shipped feature"
```

## Daily X Image

Install the daily LaunchAgent:

```sh
bun run install:daily -- --hour 8 --minute 5
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.codex-token-burn-banner.daily-x-image.plist
launchctl kickstart -k gui/$(id -u)/com.codex-token-burn-banner.daily-x-image
```

By default, the daily agent renders yesterday's activity image and posts it to
X. To only render the PNG locally:

```sh
bun run install:daily -- --hour 8 --minute 5 --no-tweet
```

Daily logs go to:

```text
~/Library/Logs/codex-daily-x-image.log
```

Unload the daily agent:

```sh
launchctl bootout gui/$(id -u)/com.codex-token-burn-banner.daily-x-image
```

Remove the generated plist:

```sh
rm ~/Library/LaunchAgents/com.codex-token-burn-banner.daily-x-image.plist
```

## Banner Updater

Create a LaunchAgent that updates the X profile banner every 30 minutes:

```sh
node src/index.js install-launch-agent --interval-seconds 1800
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.codex-token-burn-banner.plist
launchctl kickstart -k gui/$(id -u)/com.codex-token-burn-banner
```

Create a one-shot scheduled banner update plus feed tweet:

```sh
node src/index.js install-launch-agent --at 2026-05-20T16:00:00-04:00 --tweet --tweet-image --no-codexbar
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.codex-token-burn-banner.once.20260520T1600.plist
```

Use `--label <launchd-label>` with either install command if you want a custom
LaunchAgent name.

## Configuration

`.env.example` lists all supported variables. The main credential names are:

```sh
X_API_KEY=
X_API_SECRET=
X_ACCESS_TOKEN=
X_ACCESS_TOKEN_SECRET=
```

Compatibility aliases are also accepted:

```sh
X_POSTING_API_KEY=
X_POSTING_API_SECRET=
X_POSTING_ACCESS_TOKEN=
X_POSTING_ACCESS_TOKEN_SECRET=
TWITTER_API_KEY=
TWITTER_API_SECRET=
TWITTER_ACCESS_TOKEN=
TWITTER_ACCESS_TOKEN_SECRET=
```

Optional overrides:

```sh
CODEX_HOME=/Users/you/.codex
CODEXBAR_BIN=/opt/homebrew/bin/codexbar
X_API_BASE_URL=https://api.x.com
X_UPLOAD_BASE_URL=https://upload.twitter.com
```

## Security

- Do not commit `.env`.
- Do not share your X access token or token secret.
- Posts are made from the X account that owns the credentials in `.env`.
- Dry-run before posting: `bun run daily:tweet -- --dry-run`.
- This app reads local Codex logs. Review generated images before posting if
  your usage patterns are sensitive.

## Troubleshooting

Credential check fails:

```sh
bun run verify-x
```

Confirm the X app has write permission and that access tokens were generated
after write permission was enabled.

LaunchAgent did not run:

```sh
launchctl print gui/$(id -u)/com.codex-token-burn-banner.daily-x-image
tail -n 100 ~/Library/Logs/codex-daily-x-image.log
```

Wrong Codex directory:

```sh
node src/index.js scan --codex-home /path/to/.codex
```

No tweets while testing:

```sh
bun run daily:tweet -- --dry-run
```

## Development

This repository is Bun-first for package management and scripts, while the CLI
runtime remains Node.js 20+ for compatibility with generated LaunchAgents.

```sh
bun install
bun run test
bun run scan
```

The committed lockfile should be `bun.lock`. Do not add `package-lock.json`,
`pnpm-lock.yaml`, or `yarn.lock`.

## References

- [CodexBar](https://github.com/steipete/CodexBar)
- [X API authentication overview](https://docs.x.com/fundamentals/authentication/overview)
- [X API post tweet endpoint](https://docs.x.com/x-api/posts/creation-of-a-post)
- [X API media upload overview](https://developer.x.com/en/docs/x-api/v1/media/upload-media/overview)
