# Slack Playwright Test Runner

A Slack bot that lets your team trigger Playwright tests directly from a Slack channel — no terminal required.

Type `/playwright` in any channel, pick tests from a modal, and get results posted back when they finish.

---

## How it works

1. Type `/playwright` in a Slack channel
2. A modal opens listing all discovered `.spec.ts` tests grouped by describe block
3. Check the tests you want to run and click **Run Selected**
4. The bot posts a "running" message with a **Stop** button
5. When tests finish, results are posted with pass/fail status and duration per test

---

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- A Slack app with the permissions below
- A local Playwright project with `.spec.ts` test files

---

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/Yingying-Tan/Slack-bot.git
cd Slack-bot
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

Copy the example file and fill in your values:

```bash
cp .env.example .env
```

Edit `.env`:

```env
# Bot User OAuth Token — from "Install App" page (starts with xoxb-)
SLACK_BOT_TOKEN=xoxb-your-token-here

# App-Level Token — from "Socket Mode" page (starts with xapp-)
SLACK_APP_TOKEN=xapp-your-token-here

# Path to your local Playwright project (where playwright.config.ts lives)
TEST_PROJECT_DIR=C:\path\to\your\playwright-project

# Path to the folder containing your spec files
TEST_SPEC_DIR=C:\path\to\your\playwright-project\playwright-tests
```

### 4. Run the bot

```bash
npm start
```

You should see:
```
Ping Test Bot is running (Socket Mode)
Listening for /playwright command...
```

---

## Slack App Configuration

If you're setting up your own Slack app, you'll need:

**OAuth Scopes (Bot Token)**
- `chat:write` — post messages
- `commands` — receive slash commands

**Slash Command**
- Command: `/playwright`
- Request URL: *(not needed — uses Socket Mode)*

**Socket Mode**
- Enable Socket Mode in your app settings
- Generate an App-Level Token with the `connections:write` scope

**Event Subscriptions**
- Enable and subscribe to `app_mention` (optional, for future use)

---

## Project Structure

```
Slack-bot/
├── bot.js          # Main bot logic
├── package.json
├── .env            # Your local tokens and paths (not committed)
└── .env.example    # Template for .env
```

---

## Stopping a test run

While tests are running, click the **🛑 Stop** button in the Slack message to kill the process immediately.

---

## Notes

- Tests are discovered automatically from `TEST_SPEC_DIR/tests/**/*.spec.ts`
- Each spec file runs in its own process to avoid test name conflicts across files
- The Slack modal supports up to 49 test groups (Slack's 100-block limit)
- Tests run with `--workers=1` and `--project=vuhl-uat-chrome` by default — edit `bot.js` line 313 to change the Playwright flags
