import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  asciiBar,
  loadCodexUsageReport,
  summarizeUsageReport,
} from '../src/codexUsage.js';

test('scans Codex last_token_usage rows by local day', async () => {
  const codexHome = await makeCodexHome();
  await writeSession(codexHome, '2026', '05', '19', 'session-1.jsonl', [
    sessionMeta('s1'),
    turnContext('gpt-5.1-codex'),
    tokenCount('2026-05-19T14:00:00-04:00', {
      last_token_usage: {
        input_tokens: 120,
        cached_input_tokens: 40,
        output_tokens: 20,
      },
    }),
  ]);

  const report = await loadCodexUsageReport({
    codexHome,
    preferCodexBar: false,
    days: 2,
    now: new Date('2026-05-19T15:00:00-04:00'),
  });

  assert.equal(report.daily.length, 1);
  assert.equal(report.daily[0].date, '2026-05-19');
  assert.equal(report.daily[0].inputTokens, 120);
  assert.equal(report.daily[0].cacheReadTokens, 40);
  assert.equal(report.daily[0].outputTokens, 20);
  assert.equal(report.daily[0].totalTokens, 180);
  assert.ok(Math.abs(report.daily[0].totalCost - 0.000305) < 1e-12);
  assert.deepEqual(report.daily[0].modelsUsed, ['gpt-5.1-codex']);
});

test('uses positive deltas for cumulative total_token_usage rows', async () => {
  const codexHome = await makeCodexHome();
  await writeSession(codexHome, '2026', '05', '19', 'session-2.jsonl', [
    sessionMeta('s2'),
    tokenCount('2026-05-19T12:00:00-04:00', {
      total_token_usage: {
        input_tokens: 100,
        cached_input_tokens: 10,
        output_tokens: 30,
      },
    }),
    tokenCount('2026-05-19T12:05:00-04:00', {
      total_token_usage: {
        input_tokens: 150,
        cached_input_tokens: 15,
        output_tokens: 50,
      },
    }),
  ]);

  const report = await loadCodexUsageReport({
    codexHome,
    preferCodexBar: false,
    days: 2,
    now: new Date('2026-05-19T15:00:00-04:00'),
  });

  assert.equal(report.daily[0].inputTokens, 150);
  assert.equal(report.daily[0].cacheReadTokens, 15);
  assert.equal(report.daily[0].outputTokens, 50);
  assert.equal(report.daily[0].totalTokens, 215);
  assert.ok(Math.abs(report.daily[0].totalCost - 0.000670625) < 1e-12);
});

test('summary promotes yesterday when today has no burn', async () => {
  const codexHome = await makeCodexHome();
  await writeSession(codexHome, '2026', '05', '18', 'session-3.jsonl', [
    sessionMeta('s3'),
    tokenCount('2026-05-18T16:00:00-04:00', {
      last_token_usage: {
        input_tokens: 500,
        cached_input_tokens: 100,
        output_tokens: 200,
      },
    }),
  ]);

  const now = new Date('2026-05-19T00:03:00-04:00');
  const report = await loadCodexUsageReport({
    codexHome,
    preferCodexBar: false,
    days: 3,
    now,
  });
  const summary = summarizeUsageReport(report, now);

  assert.equal(summary.primary.mode, 'yesterday');
  assert.equal(summary.yesterday.totalTokens, 800);
  assert.match(summary.yesterdayBar, /^\[#+\]$/);
});

test('ascii bars are bounded', () => {
  assert.equal(asciiBar(50, 100, 10), '[#####-----]');
  assert.equal(asciiBar(200, 100, 10), '[##########]');
  assert.equal(asciiBar(0, 0, 4), '[----]');
});

async function makeCodexHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'token-burn-codex-home-'));
}

async function writeSession(codexHome, year, month, day, fileName, rows) {
  const dir = path.join(codexHome, 'sessions', year, month, day);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, fileName), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

function sessionMeta(id) {
  return {
    type: 'session_meta',
    payload: {
      session_id: id,
    },
  };
}

function turnContext(model) {
  return {
    type: 'turn_context',
    timestamp: '2026-05-19T13:59:00-04:00',
    payload: {
      model,
    },
  };
}

function tokenCount(timestamp, info) {
  return {
    type: 'event_msg',
    timestamp,
    payload: {
      type: 'token_count',
      info,
    },
  };
}
