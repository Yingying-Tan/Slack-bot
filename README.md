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

## Creating a Slack App

Follow these steps to create and configure a Slack app that works with this bot.

### 1. Create the app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App**
2. Choose **From scratch**
3. Enter an app name (e.g. `Playwright Test Runner`) and select your workspace
4. Click **Create App**

---

### 2. Enable Socket Mode

Socket Mode lets the bot connect without a public URL — required for this bot.

1. In the left sidebar, go to **Socket Mode**
2. Toggle **Enable Socket Mode** on
3. You'll be prompted to create an **App-Level Token**:
   - Name it anything (e.g. `socket-token`)
   - Add the scope: `connections:write`
   - Click **Generate**
4. Copy the token — it starts with `xapp-` — and paste it as `SLACK_APP_TOKEN` in your `.env`

---

### 3. Add OAuth scopes

1. In the left sidebar, go to **OAuth & Permissions**
2. Scroll down to **Scopes → Bot Token Scopes**
3. Click **Add an OAuth Scope** and add both:
   - `chat:write` — so the bot can post messages and results
   - `commands` — so the bot can receive the `/playwright` slash command

---

### 4. Create the slash command

1. In the left sidebar, go to **Slash Commands**
2. Click **Create New Command**
3. Fill in:
   - **Command**: `/playwright`
   - **Request URL**: enter any placeholder URL (e.g. `https://example.com`) — Socket Mode ignores this
   - **Short Description**: `Run Playwright tests`
4. Click **Save**

---

### 5. Enable Interactivity

The bot uses a modal with checkboxes and a Stop button — these require Interactivity to be on.

1. In the left sidebar, go to **Interactivity & Shortcuts**
2. Toggle **Interactivity** on
3. Enter any placeholder URL (e.g. `https://example.com`) in the Request URL field — Socket Mode ignores this
4. Click **Save Changes**

---

### 6. Install the app to your workspace

1. In the left sidebar, go to **OAuth & Permissions**
2. Click **Install to Workspace** (or **Reinstall** if you've done this before)
3. Review the permissions and click **Allow**
4. Copy the **Bot User OAuth Token** — it starts with `xoxb-` — and paste it as `SLACK_BOT_TOKEN` in your `.env`

---

### 7. Invite the bot to a channel

The bot can only post in channels it has been invited to.

In Slack, open the channel you want to use and type:
```
/invite @YourBotName
```

Then type `/playwright` to open the test selection modal.

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
