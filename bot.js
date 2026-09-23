'use strict';

require('dotenv').config();
const { App } = require('@slack/bolt');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Registry maps numeric string ID → { relPath, title }
// Rebuilt each time discoverTests() is called (i.e. each /playwright invocation).
const testRegistry = new Map();
let testIdCounter = 0;

const TEST_PROJECT_DIR = process.env.TEST_PROJECT_DIR;
const TEST_SPEC_DIR   = process.env.TEST_SPEC_DIR;

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
  const testList = buildGroupedList(selectedTests);
  const runningText = `🔄 <@${userId}> is running ${selectedTests.length} test${selectedTests.length !== 1 ? 's' : ''}:\n\n${testList}`;

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
  testRegistry.clear();
  testIdCounter = 0;

  const testDir = path.join(specDir, 'tests');
  const files = findSpecFiles(testDir).sort();

  return files.map(file => {
    const fullPath = path.join(testDir, file);
    // Relative to TEST_PROJECT_DIR so it works as a playwright file arg
    const relPath = path.relative(TEST_PROJECT_DIR, fullPath).replace(/\\/g, '/');
    const content = fs.readFileSync(fullPath, 'utf8');
    const descMatch = content.match(/test\.describe(?:\.\w+)?\(\s*['"`]([^'"`]+)['"`]/);
    const testRegex = /^\s*test\(\s*['"`]([^'"`]+)['"`]/gm;
    const tests = [];
    let m;
    const describeName = descMatch ? descMatch[1] : file;
    while ((m = testRegex.exec(content)) !== null) {
      const id = String(testIdCounter++);
      testRegistry.set(id, { relPath, title: m[1], describe: describeName });
      tests.push({ id, title: m[1] });
    }
    return { file, describe: describeName, tests };
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
          options: group.tests.map(({ id, title }) => ({
            text: { type: 'mrkdwn', text: title.substring(0, 150) },
            value: id, // numeric ID — registry lookup prevents cross-file title collisions
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

// Returns [{ relPath, title }] — looked up by ID so titles are scoped to their file.
function extractSelected(view) {
  const selected = [];
  for (const blockValues of Object.values(view.state.values)) {
    for (const actionValue of Object.values(blockValues)) {
      for (const opt of (actionValue.selected_options || [])) {
        const entry = testRegistry.get(opt.value);
        if (entry) selected.push(entry);
      }
    }
  }
  return selected;
}

// ── Playwright execution ──────────────────────────────────────────────────────

// Runs each file's tests in its own process so same-named tests in different
// files don't bleed into each other.  Returns the same { proc, promise } shape.
function runPlaywrightTests(tests) {
  // Group by file path
  const byFile = new Map();
  for (const { relPath, title } of tests) {
    if (!byFile.has(relPath)) byFile.set(relPath, []);
    byFile.get(relPath).push(title);
  }

  let currentProc = null;
  let stopped = false;

  // Proxy so the stop button can kill whichever process is currently running
  const proc = {
    kill(sig) {
      stopped = true;
      currentProc?.kill(sig);
    },
  };

  const promise = (async () => {
    const allResults = [];
    for (const [relPath, titles] of byFile.entries()) {
      if (stopped) break;
      const { proc: fileProc, promise: fp } = spawnFileTests(relPath, titles);
      currentProc = fileProc;
      const { results } = await fp;
      allResults.push(...results);
    }
    return { results: allResults };
  })();

  return { proc, promise };
}

function spawnFileTests(relPath, titles) {
  const grepPattern = titles
    .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const grepEscaped = grepPattern.replace(/'/g, "''");
  const pathEscaped = relPath.replace(/'/g, "''");

  const proc = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `npx playwright test '${pathEscaped}' '--grep=${grepEscaped}' '--reporter=json' --workers=1 --project=vuhl-uat-chrome`,
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
          describe: suite.title, // the suite that directly contains the spec is the describe block
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

// ── Shared grouping helper ────────────────────────────────────────────────────

function buildGroupedList(tests) {
  const groups = new Map();
  for (const t of tests) {
    const key = t.describe || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t.title);
  }
  const lines = [];
  for (const [describe, titles] of groups.entries()) {
    if (describe) lines.push(`*${describe}*`);
    for (const title of titles) lines.push(`• ${title}`);
  }
  return lines.join('\n');
}

// ── Format results for Slack ──────────────────────────────────────────────────

function formatResults(results, elapsedMs) {
  const passed = results.filter(r => r.status === 'passed').length;
  const failed = results.length - passed;
  const sec = (elapsedMs / 1000).toFixed(1);

  let text = `*Playwright Test Results* — ${results.length} test${results.length !== 1 ? 's' : ''} · ${sec}s\n\n`;

  // Group by describe block, preserving order of first appearance
  const groups = new Map();
  for (const r of results) {
    const key = r.describe || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  for (const [describe, groupResults] of groups.entries()) {
    if (describe) text += `*${describe}*\n`;
    for (const r of groupResults) {
      const icon = r.status === 'passed' ? '✅' : '❌';
      const dur = (r.duration / 1000).toFixed(1);
      text += `${icon}  ${r.title} _(${dur}s)_\n`;
      if (r.error) {
        const firstLine = r.error.split('\n')[0].substring(0, 120);
        text += `      \`${firstLine}\`\n`;
      }
    }
    text += '\n';
  }

  text += `*${passed} passed · ${failed} failed*`;
  return text;
}

// ── Start ─────────────────────────────────────────────────────────────────────

(async () => {
  app.use(async ({ payload, next }) => {
    console.log('[EVENT]', JSON.stringify(payload).substring(0, 200));
    await next();
  });

  await app.start();
  console.log('Slack Test Bot is running (Socket Mode)');
  console.log('Listening for /playwright command...');
})();
