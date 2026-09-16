'use strict';

require('dotenv').config();
const { App } = require('@slack/bolt');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const TEST_PROJECT_DIR = 'C:\\myWork\\Playwright\\myvu-front-end';           // where playwright.config.ts lives (cwd for npx playwright)
const TEST_SPEC_DIR   = 'C:\\myWork\\Playwright\\myvu-front-end\\playwright-tests'; // where spec files are discovered

// ── Active runs map: runId → { proc, channelId, userId, client } ──────────────
const activeRuns = new Map();
let runCounter = 0;

// ── Slack app ─────────────────────────────────────────────────────────────────

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

// ── /playwright slash command → open modal ────────────────────────────────────

app.command('/playwright', async ({ command, ack, client, logger }) => {
  await ack();

  try {
    const groups = discoverTests(TEST_SPEC_DIR);
    await client.views.open({
      trigger_id: command.trigger_id,
      view: buildModal(groups, command.channel_id),
    });
  } catch (err) {
    logger.error(err);
  }
});

// ── Stop button clicked ───────────────────────────────────────────────────────

app.action('stop_tests', async ({ ack, body, client }) => {
  await ack();

  const runId = body.actions[0].value;
  const run = activeRuns.get(runId);
  if (!run) return;

  run.proc.kill('SIGTERM');
  activeRuns.delete(runId);

  // Update running message to show stopped
  await client.chat.update({
    channel: run.channelId,
    ts: run.msgTs,
    text: run.runningText + '\n🛑 *Stopped*',
    blocks: [],
  });

  await client.chat.postMessage({
    channel: run.channelId,
    text: `<@${run.userId}> 🛑 Test run was stopped.`,
  });
});

// ── Modal submitted → run tests → post results ────────────────────────────────

app.view('run_tests_modal', async ({ ack, view, body, client, logger }) => {
  await ack();

  const channelId = view.private_metadata;
  const userId = body.user.id;
  const selectedTests = extractSelected(view);

  if (!selectedTests.length) return;

  const runId = String(++runCounter);
  const testList = selectedTests.map(t => `• ${t}`).join('\n');
  const runningText = `🔄 <@${userId}> is running ${selectedTests.length} test${selectedTests.length !== 1 ? 's' : ''}:\n${testList}`;

  // Post "running" message with Stop button
  let runMsg;
  try {
    runMsg = await client.chat.postMessage({
      channel: channelId,
      text: runningText,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: runningText },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: '🛑 Stop' },
              style: 'danger',
              action_id: 'stop_tests',
              value: runId,
            },
          ],
        },
      ],
    });
  } catch (err) {
    logger.error('Failed to post running message:', err);
    return;
  }

  // Execute tests
  const startTime = Date.now();
  try {
    const { proc, promise } = runPlaywrightTests(selectedTests);

    activeRuns.set(runId, { proc, channelId, userId, msgTs: runMsg.ts, runningText });

    const { results } = await promise;
    activeRuns.delete(runId);

    const elapsed = Date.now() - startTime;

    // Remove Stop button from running message
    await client.chat.update({
      channel: channelId,
      ts: runMsg.ts,
      text: runningText,
      blocks: [],
    });

    await client.chat.postMessage({
      channel: channelId,
      text: `<@${userId}>\n${formatResults(results, elapsed)}`,
    });
  } catch (err) {
    activeRuns.delete(runId);

    // Remove Stop button on error too
    await client.chat.update({
      channel: channelId,
      ts: runMsg.ts,
      text: runningText,
      blocks: [],
    }).catch(() => {});

    await client.chat.postMessage({
      channel: channelId,
      text: `<@${userId}> ❌ Test run failed\n\`\`\`${String(err.message).substring(0, 500)}\`\`\``,
    });
  }
});

// ── Test discovery ────────────────────────────────────────────────────────────

function discoverTests(specDir) {
  const testDir = path.join(specDir, 'tests');
  const files = findSpecFiles(testDir).sort();

  return files.map(file => {
    const fullPath = path.join(testDir, file);
    const content = fs.readFileSync(fullPath, 'utf8');
    const descMatch = content.match(/test\.describe(?:\.\w+)?\(\s*['"`]([^'"`]+)['"`]/);
    const testRegex = /^\s*test\(\s*['"`]([^'"`]+)['"`]/gm;
    const tests = [];
    let m;
    while ((m = testRegex.exec(content)) !== null) tests.push(m[1]);
    return { file, describe: descMatch ? descMatch[1] : file, tests };
  });
}

function findSpecFiles(dir, base = '') {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...findSpecFiles(path.join(dir, entry.name), rel));
    } else if (entry.name.endsWith('.spec.ts')) {
      results.push(rel);
    }
  }
  return results;
}

// ── Slack modal builder ───────────────────────────────────────────────────────

function buildModal(groups, channelId) {
  const blocks = [];
  let blockCounter = 0;

  // Slack modal limit is 100 blocks; each group = 2 blocks (header + checkboxes)
  const MAX_GROUPS = 49;
  const visible = groups.slice(0, MAX_GROUPS);
  const hidden = groups.length - visible.length;

  for (const group of visible) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${group.describe}*` },
    });

    blocks.push({
      type: 'actions',
      block_id: `blk_${blockCounter++}`,
      elements: [
        {
          type: 'checkboxes',
          action_id: 'chk',
          options: group.tests.map(title => ({
            text: { type: 'mrkdwn', text: title.substring(0, 150) },
            value: title.substring(0, 150),
          })),
        },
      ],
    });
  }

  if (hidden > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `_…and ${hidden} more group${hidden !== 1 ? 's' : ''} not shown (Slack modal limit)_` },
    });
  }

  return {
    type: 'modal',
    callback_id: 'run_tests_modal',
    private_metadata: channelId,
    title: { type: 'plain_text', text: 'Ping Test Runner' },
    submit: { type: 'plain_text', text: 'Run Selected' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks,
  };
}

// ── Extract selected tests from modal submission ───────────────────────────────

function extractSelected(view) {
  const selected = [];
  for (const blockValues of Object.values(view.state.values)) {
    for (const actionValue of Object.values(blockValues)) {
      for (const opt of (actionValue.selected_options || [])) {
        selected.push(opt.value);
      }
    }
  }
  return selected;
}

// ── Playwright execution ──────────────────────────────────────────────────────

function runPlaywrightTests(tests) {
  const grepPattern = tests
    .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const grepEscaped = grepPattern.replace(/'/g, "''");

  const proc = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `npx playwright test '--grep=${grepEscaped}' '--reporter=json' --workers=1 --project=vuhl-uat-chrome`,
  ], { cwd: TEST_PROJECT_DIR, shell: false });

  const promise = new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', err => { console.error('[SPAWN ERROR]', err.message); reject(err); });

    proc.on('close', (code, signal) => {
      if (signal) {
        reject(new Error(`Process killed (${signal})`));
        return;
      }
      try {
        const json = JSON.parse(stdout);
        resolve({ results: parsePlaywrightJson(json), code });
      } catch (_) {
        reject(new Error(stderr || stdout || `Playwright exited with code ${code}`));
      }
    });
  });

  return { proc, promise };
}

function parsePlaywrightJson(json) {
  const results = [];
  function walk(suites) {
    for (const suite of (suites || [])) {
      for (const spec of (suite.specs || [])) {
        const r = spec.tests?.[0]?.results?.[0];
        results.push({
          title: spec.title,
          status: r?.status || (spec.ok ? 'passed' : 'failed'),
          duration: r?.duration || 0,
          error: r?.errors?.[0]?.message || null,
        });
      }
      walk(suite.suites);
    }
  }
  walk(json.suites);
  return results;
}

// ── Format results for Slack ──────────────────────────────────────────────────

function formatResults(results, elapsedMs) {
  const passed = results.filter(r => r.status === 'passed').length;
  const failed = results.length - passed;
  const sec = (elapsedMs / 1000).toFixed(1);

  let text = `*Playwright Test Results* — ${results.length} test${results.length !== 1 ? 's' : ''} · ${sec}s\n`;

  for (const r of results) {
    const icon = r.status === 'passed' ? '✅' : '❌';
    const dur = (r.duration / 1000).toFixed(1);
    text += `${icon}  ${r.title} _(${dur}s)_\n`;
    if (r.error) {
      const firstLine = r.error.split('\n')[0].substring(0, 120);
      text += `      \`${firstLine}\`\n`;
    }
  }

  text += `\n*${passed} passed · ${failed} failed*`;
  return text;
}

// ── Start ─────────────────────────────────────────────────────────────────────

(async () => {
  app.use(async ({ payload, next }) => {
    console.log('[EVENT]', JSON.stringify(payload).substring(0, 200));
    await next();
  });

  await app.start();
  console.log('Ping Test Bot is running (Socket Mode)');
  console.log('Listening for /playwright command...');
})();
