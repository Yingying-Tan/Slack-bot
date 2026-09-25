'use strict';

require('dotenv').config();
const { App } = require('@slack/bolt');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Registry maps numeric string ID → { relPath, title?, titles?, describe, isSerial }
// Rebuilt each time discoverTests() is called (i.e. each /playwright invocation).
const testRegistry = new Map();
let testIdCounter = 0;

const TEST_PROJECT_DIR = process.env.TEST_PROJECT_DIR;
const TEST_SPEC_DIR   = process.env.TEST_SPEC_DIR;
const RUN_TIMEOUT_MS  = 10 * 60 * 1000;

// ── Active runs map: runId → { proc, channelId, userId, msgTs, runningText, testKeys } ──
const activeRuns = new Map();
let runCounter = 0;

// ── Shared helpers ────────────────────────────────────────────────────────────

// Expand any test entry to a flat list of { relPath, title } pairs.
function expandEntry(entry) {
  if (entry.relPaths) return entry.relPaths.map(({ relPath, title }) => ({ relPath, title }));
  if (entry.isSerial) return entry.titles.map(title => ({ relPath: entry.relPath, title }));
  return [{ relPath: entry.relPath, title: entry.title }];
}

function getTestKeys(selectedTests) {
  return new Set(
    selectedTests.flatMap(expandEntry).map(({ relPath, title }) => `${relPath}::${title}`)
  );
}

function loadTestGroups() {
  const filePath = path.join(TEST_SPEC_DIR, 'test-groups.json');
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return {};
  }
}

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
    const testGroups = loadTestGroups();
    await client.views.open({
      trigger_id: command.trigger_id,
      view: buildModal(groups, command.channel_id, testGroups),
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

  await updateMessage(client, run.channelId, run.msgTs,
    `<@${run.userId}> 🛑 Test run was stopped.\n\n${run.testList}`);
});

// ── Modal submitted → run tests → post results ────────────────────────────────

app.view('run_tests_modal', async ({ ack, view, body, client, logger }) => {
  await ack();

  const channelId = view.private_metadata;
  const userId = body.user.id;
  const testGroups = loadTestGroups();
  const selectedTests = extractSelected(view, testGroups);

  if (!selectedTests.length) return;

  const incomingKeys = getTestKeys(selectedTests);
  for (const run of activeRuns.values()) {
    if ([...incomingKeys].some(k => run.testKeys.has(k))) {
      await client.chat.postMessage({
        channel: channelId,
        text: `<@${userId}> ⏳ Some of those tests are already running by <@${run.userId}>. Please wait for them to finish.`,
      });
      return;
    }
  }

  const prodChecked = (view.state.values['env_select']?.['env']?.selected_options || []).some(o => o.value === 'vuhl-prod-chrome');
  const project = prodChecked ? 'vuhl-prod-chrome' : 'vuhl-uat-chrome';
  const envLabel = project === 'vuhl-prod-chrome' ? 'Prod' : 'UAT';

  const runId = String(++runCounter);
  const totalTests = selectedTests.flatMap(expandEntry).length;
  const testList = buildGroupedList(selectedTests);
  const runningText = `🔄 <@${userId}> is running ${totalTests} test${totalTests !== 1 ? 's' : ''} on *${envLabel}*:\n\n${testList}`;

  let runMsg;
  try {
    runMsg = await postRunningMessage(client, channelId, runId, runningText);
  } catch (err) {
    logger.error('Failed to post running message:', err);
    return;
  }

  const startTime = Date.now();
  try {
    const { proc, promise } = runPlaywrightTests(selectedTests, project);
    activeRuns.set(runId, { proc, channelId, userId, msgTs: runMsg.ts, runningText, testList, testKeys: incomingKeys });

    const { results } = await promise;
    activeRuns.delete(runId);

    await updateMessage(client, channelId, runMsg.ts,
      `<@${userId}>\n${formatResults(results, Date.now() - startTime, envLabel, selectedTests)}`);
  } catch (err) {
    const stoppedManually = !activeRuns.has(runId);
    activeRuns.delete(runId);
    if (!stoppedManually) {
      await updateMessage(client, channelId, runMsg.ts,
        `<@${userId}> ❌ Test run failed\n\`\`\`${String(err.message).substring(0, 500)}\`\`\``
      ).catch(() => {});
    }
  }
});

// ── Slack message helpers ─────────────────────────────────────────────────────

async function postRunningMessage(client, channelId, runId, text) {
  return client.chat.postMessage({
    channel: channelId,
    text,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text } },
      {
        type: 'actions',
        elements: [{
          type: 'button',
          text: { type: 'plain_text', text: '🛑 Stop' },
          style: 'danger',
          action_id: 'stop_tests',
          value: runId,
        }],
      },
    ],
  });
}

async function updateMessage(client, channelId, ts, text) {
  return client.chat.update({ channel: channelId, ts, text, blocks: [] });
}

// ── Test discovery ────────────────────────────────────────────────────────────

function discoverTests(specDir) {
  testRegistry.clear();
  testIdCounter = 0;

  const testDir = path.join(specDir, 'tests');
  const files = findSpecFiles(testDir).sort();

  return files.flatMap(file => {
    const fullPath = path.join(testDir, file);
    const relPath = path.relative(TEST_PROJECT_DIR, fullPath).replace(/\\/g, '/');
    const content = fs.readFileSync(fullPath, 'utf8');

    const describeRegex = /test\.describe(\.serial)?\s*\(\s*['"`]([^'"`]+)['"`]/g;
    const describes = [];
    let m;
    while ((m = describeRegex.exec(content)) !== null) {
      describes.push({ isSerial: !!m[1], name: m[2].replace(/^(\w+):\s*(?=\1)/i, ''), pos: m.index, tests: [] });
    }

    if (describes.length === 0) {
      describes.push({ isSerial: false, name: file, pos: 0, tests: [] });
    }

    const testRegex = /^\s*test\s*\(\s*['"`]([^'"`]+)['"`]/gm;
    while ((m = testRegex.exec(content)) !== null) {
      let parent = null;
      for (const d of describes) {
        if (d.pos <= m.index && (!parent || d.pos > parent.pos)) parent = d;
      }
      if (parent) parent.tests.push(m[1]);
    }

    return describes
      .filter(d => d.tests.length > 0)
      .map(d => {
        if (d.isSerial) {
          const id = String(testIdCounter++);
          testRegistry.set(id, { relPath, titles: d.tests, describe: d.name, isSerial: true });
          return { file, describe: d.name, isSerial: true, id, tests: d.tests };
        } else {
          const tests = d.tests.map(title => {
            const id = String(testIdCounter++);
            testRegistry.set(id, { relPath, title, describe: d.name, isSerial: false });
            return { id, title };
          });
          return { file, describe: d.name, isSerial: false, tests };
        }
      });
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

function buildModal(groups, channelId, testGroups = {}) {
  const groupNames = Object.keys(testGroups);
  const blocks = [
    ...buildEnvBlock(),
    ...buildPredefinedGroupBlocks(testGroups, groupNames),
  ];

  let blockCounter = 0;
  const MAX_GROUPS = 48 - groupNames.length;
  const visible = groups.slice(0, MAX_GROUPS);
  const hidden = groups.length - visible.length;

  for (const group of visible) {
    blocks.push(...buildDiscoveredGroupBlock(group, blockCounter++));
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
    title: { type: 'plain_text', text: 'Playwright Test Runner' },
    submit: { type: 'plain_text', text: 'Run Selected' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks,
  };
}

function buildEnvBlock() {
  return [
    {
      type: 'actions',
      block_id: 'env_select',
      elements: [{
        type: 'checkboxes',
        action_id: 'env',
        options: [{ text: { type: 'mrkdwn', text: 'Run against *Prod* (unchecked = UAT)' }, value: 'vuhl-prod-chrome' }],
      }],
    },
    { type: 'divider' },
  ];
}

function getGroupConfig(testGroups, groupName) {
  const val = testGroups[groupName];
  if (Array.isArray(val)) return { tests: val };
  return { tests: val?.tests || [] };
}

function buildPredefinedGroupBlocks(testGroups, groupNames) {
  if (groupNames.length === 0) return [];
  const blocks = [];
  for (const groupName of groupNames) {
    const { tests } = getGroupConfig(testGroups, groupName);
    const anyParallel = tests.some(t => t.parallel);
    const allParallel = tests.length > 0 && tests.every(t => t.parallel);
    const runLabel = allParallel ? 'runs in parallel' : anyParallel ? 'mixed parallelism' : 'runs serially';
    blocks.push({
      type: 'actions',
      block_id: `group_${groupName}`,
      elements: [{
        type: 'checkboxes',
        action_id: 'chk',
        options: [{
          text: { type: 'mrkdwn', text: `*${groupName}* _(${tests.length} tests, ${runLabel})_`.substring(0, 150) },
          value: `group::${groupName}`,
        }],
      }],
    });
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: tests.map(t => `• ${t.description || t.test}`).join('\n').substring(0, 3000) }],
    });
  }
  blocks.push({ type: 'divider' });
  return blocks;
}

function buildDiscoveredGroupBlock(group, counter) {
  const blockId = `blk_${counter}`;
  if (group.isSerial) {
    return [
      {
        type: 'actions',
        block_id: blockId,
        elements: [{
          type: 'checkboxes',
          action_id: 'chk',
          options: [{ text: { type: 'mrkdwn', text: `*${group.describe}*`.substring(0, 150) }, value: group.id }],
        }],
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: group.tests.map(t => `• ${t}`).join('\n').substring(0, 3000) }],
      },
    ];
  }
  if (group.tests.length === 1) {
    return [{
      type: 'actions',
      block_id: blockId,
      elements: [{
        type: 'checkboxes',
        action_id: 'chk',
        options: [{ text: { type: 'mrkdwn', text: `*${group.describe}*`.substring(0, 150) }, value: group.tests[0].id }],
      }],
    }];
  }
  return [
    { type: 'context', elements: [{ type: 'mrkdwn', text: `*${group.describe}*` }] },
    {
      type: 'actions',
      block_id: blockId,
      elements: [{
        type: 'checkboxes',
        action_id: 'chk',
        options: group.tests.map(({ id, title }) => ({
          text: { type: 'mrkdwn', text: title.substring(0, 150) },
          value: id,
        })),
      }],
    },
  ];
}

// ── Extract selected tests from modal submission ──────────────────────────────

function extractSelected(view, testGroups = {}) {
  const selected = [];
  for (const blockValues of Object.values(view.state.values)) {
    for (const actionValue of Object.values(blockValues)) {
      for (const opt of (actionValue.selected_options || [])) {
        if (opt.value.startsWith('group::')) {
          const groupName = opt.value.slice(7);
          const { tests: entries } = getGroupConfig(testGroups, groupName);
          if (entries.length > 0) {
            selected.push({
              isGroup: true,
              describe: groupName,
              relPaths: entries.map(e => ({
                relPath: e.file.replace(/\\/g, '/'),
                title: e.test,
                display: e.description || e.test,
                parallel: !!e.parallel,
              })),
            });
          }
        } else {
          const entry = testRegistry.get(opt.value);
          if (entry) selected.push(entry);
        }
      }
    }
  }
  return selected;
}

// ── Playwright execution ──────────────────────────────────────────────────────

// Runs each file's tests in its own process so same-named tests in different
// files don't bleed into each other.
// For predefined groups: entries marked parallel:true all run concurrently;
// the remaining serial entries run one by one. Both batches start at the same time.
function runPlaywrightTests(tests, project = 'vuhl-uat-chrome') {
  const procs = new Set();
  let stopped = false;

  const proc = {
    kill(sig) {
      stopped = true;
      for (const p of procs) p.kill(sig);
    },
  };

  const spawnTracked = (relPath, titles) => {
    const { proc: fileProc, promise: fp } = spawnFileTests(relPath, titles, project);
    procs.add(fileProc);
    return fp.finally(() => procs.delete(fileProc));
  };

  const promise = (async () => {
    const allResults = [];

    for (const item of tests) {
      if (stopped) break;

      if (item.relPaths) {
        // Predefined group: split into serial and parallel batches, run both at once
        const serialEntries = item.relPaths.filter(e => !e.parallel);
        const parallelEntries = item.relPaths.filter(e => e.parallel);

        const runSerialBatch = async () => {
          const results = [];
          for (const e of serialEntries) {
            if (stopped) break;
            const { results: r } = await spawnTracked(e.relPath, [e.title]);
            results.push(...r);
          }
          return results;
        };

        const runParallelBatch = async () => {
          const settled = await Promise.all(
            parallelEntries.map(e => spawnTracked(e.relPath, [e.title]))
          );
          return settled.flatMap(r => r.results);
        };

        const [sResults, pResults] = await Promise.all([
          serialEntries.length ? runSerialBatch() : Promise.resolve([]),
          parallelEntries.length ? runParallelBatch() : Promise.resolve([]),
        ]);
        allResults.push(...sResults, ...pResults);

      } else {
        // Individual test from registry — run file by file sequentially
        const byFile = new Map();
        for (const { relPath, title } of expandEntry(item)) {
          if (!byFile.has(relPath)) byFile.set(relPath, []);
          byFile.get(relPath).push(title);
        }
        for (const [relPath, titles] of byFile.entries()) {
          if (stopped) break;
          const { results } = await spawnTracked(relPath, titles);
          allResults.push(...results);
        }
      }
    }

    return { results: allResults };
  })();

  return { proc, promise };
}

function spawnFileTests(relPath, titles, project = 'vuhl-uat-chrome') {
  const grepPattern = titles
    .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const grepEscaped = grepPattern.replace(/'/g, "''");
  const pathEscaped = relPath.replace(/'/g, "''");

  const proc = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `npx playwright test '${pathEscaped}' '--grep=${grepEscaped}' '--reporter=json' --workers=1 --project=${project}`,
  ], { cwd: TEST_PROJECT_DIR, shell: false });

  const promise = new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', err => { console.error('[SPAWN ERROR]', err.message); reject(err); });

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`Test timed out after 10 minutes: ${relPath}`));
    }, RUN_TIMEOUT_MS);

    proc.on('close', (code, signal) => {
      clearTimeout(timer);
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
          describe: suite.title,
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

// ── Slack message formatters ──────────────────────────────────────────────────

function buildGroupedList(tests) {
  const groups = new Map();
  for (const t of tests) {
    const key = t.describe || '';
    if (!groups.has(key)) groups.set(key, []);
    if (t.relPaths) {
      if (t.relPaths.length > 1) groups.get(key).push(...t.relPaths.map(r => r.display || r.title));
    } else if (t.isSerial) {
      groups.get(key).push(...t.titles);
    } else {
      groups.get(key).push(t.title);
    }
  }
  const lines = [];
  for (const [describe, titles] of groups.entries()) {
    if (describe) lines.push(`*${describe}*`);
    for (const title of titles) lines.push(`• ${title}`);
  }
  return lines.join('\n');
}

function formatResults(results, elapsedMs, envLabel = 'UAT', selectedTests = []) {
  const singleTestGroups = new Map();
  for (const t of selectedTests) {
    if (t.relPaths && t.relPaths.length === 1) {
      singleTestGroups.set(t.relPaths[0].title, t.describe);
    }
  }

  const passed = results.filter(r => r.status === 'passed').length;
  const failed = results.length - passed;
  const sec = (elapsedMs / 1000).toFixed(1);

  let text = `*Playwright Test Results* — ${results.length} test${results.length !== 1 ? 's' : ''} · ${sec}s · *${envLabel}*\n\n`;

  const groups = new Map();
  for (const r of results) {
    const key = singleTestGroups.has(r.title)
      ? `__group__${singleTestGroups.get(r.title)}`
      : (r.describe || '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  for (const [key, groupResults] of groups.entries()) {
    const isSingleGroup = key.startsWith('__group__');
    if (!isSingleGroup && key) text += `*${key}*\n`;
    for (const r of groupResults) {
      const icon = r.status === 'passed' ? '✅' : '❌';
      const dur = (r.duration / 1000).toFixed(1);
      text += isSingleGroup
        ? `${icon}  *${key.slice(9)}* _(${dur}s)_\n`
        : `${icon}  ${r.title} _(${dur}s)_\n`;
      if (r.error) {
        text += `      \`${r.error.split('\n')[0].substring(0, 120)}\`\n`;
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
