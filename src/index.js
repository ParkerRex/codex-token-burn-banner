#!/usr/bin/env node
import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  asciiBar,
  loadCodexUsageReport,
  summarizeUsageReport,
} from './codexUsage.js';
import { loadAgentActivityReport } from './agentActivity.js';
import { renderAgentActivityImage } from './activityImage.js';
import { renderBanner, renderTweetImage } from './banner.js';
import {
  createTweet,
  missingXCredentials,
  uploadTweetImage,
  updateProfileBanner,
  verifyCredentials,
} from './xClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(rootDir, '.env'), quiet: true });

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const [command = 'once', ...rest] = process.argv.slice(2);
  const options = parseOptions(rest);

  switch (command) {
    case 'once':
      await runOnce(options);
      break;
    case 'render':
      await runOnce({ ...options, noUpload: true, dryRun: true });
      break;
    case 'scan':
      await runScan(options);
      break;
    case 'activity':
      await runActivity(options);
      break;
    case 'daily-image':
      await runDailyImage(options);
      break;
    case 'verify-x':
      await runVerifyX(options);
      break;
    case 'watch':
      await runWatch(options);
      break;
    case 'install-launch-agent':
      await installLaunchAgent(options);
      break;
    case 'install-daily-image-agent':
      await installDailyImageAgent(options);
      break;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

async function runOnce(options) {
  const now = options.now ? new Date(options.now) : new Date();
  const report = await loadCodexUsageReport({
    now,
    days: options.days,
    codexHome: options.codexHome,
    codexbarBin: options.codexbarBin,
    preferCodexBar: options.preferCodexBar,
  });
  const summary = summarizeUsageReport(report, now);
  const imagePath = await renderBanner(summary, {
    output: options.output ?? path.join(rootDir, 'outputs', 'codex-token-burn-banner.png'),
  });
  let tweetImagePath = null;
  if (options.tweetImage) {
    tweetImagePath = await renderTweetImage(summary, {
      output: options.tweetImageOutput ?? path.join(rootDir, 'outputs', 'codex-token-burn-tweet.png'),
    });
  }

  const missing = missingXCredentials();
  const shouldUpload = !options.noUpload && !options.dryRun && (options.upload || missing.length === 0);
  let tweetResult = null;
  let mediaResult = null;
  if (shouldUpload) {
    if (missing.length) {
      throw new Error(`Upload requested but credentials are missing: ${missing.join(', ')}`);
    }
    await updateProfileBanner(imagePath);
  }
  if (options.tweet && !options.dryRun) {
    if (missing.length) {
      throw new Error(`Tweet requested but credentials are missing: ${missing.join(', ')}`);
    }
    const tweetText = options.tweetText ?? (options.tweetImage ? buildPromoTweetText(summary) : buildTweetText(summary));
    if (tweetImagePath) {
      mediaResult = await uploadTweetImage(tweetImagePath);
    }
    const mediaId = mediaResult?.media_id_string ?? mediaResult?.media_id;
    tweetResult = await createTweet(tweetText, {
      mediaIds: mediaId ? [mediaId] : [],
    });
  }

  if (options.json) {
    console.log(JSON.stringify({
      imagePath,
      tweetImagePath,
      uploaded: shouldUpload,
      media: mediaResult,
      tweet: tweetResult,
      tweetText: options.tweet
        ? (options.tweetText ?? (options.tweetImage ? buildPromoTweetText(summary) : buildTweetText(summary)))
        : null,
      missingCredentials: missing,
      summary,
    }, null, 2));
    return;
  }

  printSummary(summary, imagePath, {
    tweetImagePath,
    uploaded: shouldUpload,
    mediaResult,
    tweetResult,
    tweetText: options.tweet
      ? (options.tweetText ?? (options.tweetImage ? buildPromoTweetText(summary) : buildTweetText(summary)))
      : null,
    missingCredentials: missing,
    dryRun: options.dryRun || options.noUpload,
  });
}

async function runScan(options) {
  const now = options.now ? new Date(options.now) : new Date();
  const report = await loadCodexUsageReport({
    now,
    days: options.days,
    codexHome: options.codexHome,
    codexbarBin: options.codexbarBin,
    preferCodexBar: options.preferCodexBar,
  });
  const summary = summarizeUsageReport(report, now);

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  printSummary(summary, null, { scanOnly: true });
}

async function runActivity(options) {
  const now = options.now ? new Date(options.now) : new Date();
  const dayKey = options.day ?? (options.yesterday ? localDayKeyFromDate(shiftLocalDate(now, -1)) : localDayKeyFromDate(now));
  const [activity, report] = await Promise.all([
    loadAgentActivityReport({
      now,
      dayKey,
      codexHome: options.codexHome,
      bucketMinutes: options.bucketMinutes,
    }),
    loadCodexUsageReport({
      now,
      days: options.days,
      codexHome: options.codexHome,
      codexbarBin: options.codexbarBin,
      preferCodexBar: options.preferCodexBar,
    }),
  ]);
  const usageEntry = report.daily.find((entry) => entry.date === dayKey) ?? {
    date: dayKey,
    totalTokens: 0,
    totalCost: 0,
  };
  const imagePath = await renderAgentActivityImage(activity, usageEntry, {
    output: options.activityOutput ?? path.join(rootDir, 'outputs', 'agent-screen-time.png'),
  });
  const missing = missingXCredentials();
  let mediaResult = null;
  let tweetResult = null;
  const tweetText = options.tweetText ?? buildActivityTweetText(activity, usageEntry);
  const shouldPostTweet = options.tweet && !options.dryRun && !options.noUpload;
  if (shouldPostTweet) {
    if (missing.length) {
      throw new Error(`Tweet requested but credentials are missing: ${missing.join(', ')}`);
    }
    mediaResult = await uploadTweetImage(imagePath);
    const mediaId = mediaResult?.media_id_string ?? mediaResult?.media_id;
    tweetResult = await createTweet(tweetText, {
      mediaIds: mediaId ? [mediaId] : [],
    });
  }

  if (options.json) {
    console.log(JSON.stringify({
      imagePath,
      activity,
      usageEntry,
      media: mediaResult,
      tweet: tweetResult,
      tweetText: options.tweet ? tweetText : null,
      missingCredentials: missing,
    }, null, 2));
    return;
  }

  console.log(`activity image: ${imagePath}`);
  console.log(`day: ${activity.dayKey}`);
  console.log(`peak: ${activity.metrics.peakConcurrency} agents at ${activity.metrics.peakTimeLabel}`);
  console.log(`agent-time: ${formatHoursMinutes(activity.metrics.agentMinutes)}`);
  console.log(`coverage: ${formatDuration(activity.metrics.coverageMinutes)}`);
  if (usageEntry.totalCost != null) console.log(`api-equivalent: ${formatCurrency(usageEntry.totalCost)}`);
  if (tweetResult?.data?.id) {
    console.log(`tweet: posted ${tweetResult.data.id}`);
  } else if (options.tweet && (options.dryRun || options.noUpload)) {
    console.log('tweet: skipped by dry-run/no-upload');
    console.log(tweetText);
  } else if (options.tweet && missing.length) {
    console.log(`tweet: skipped, missing ${missing.join(', ')}`);
  }
}

async function runDailyImage(options) {
  await runActivity({
    ...options,
    yesterday: options.day ? options.yesterday : true,
  });
}

async function runVerifyX(options) {
  const missing = missingXCredentials();
  if (missing.length) {
    throw new Error(`X credentials are missing: ${missing.join(', ')}`);
  }
  const user = await verifyCredentials();
  if (options.json) {
    console.log(JSON.stringify({
      ok: true,
      id: user.id_str ?? user.id,
      screenName: user.screen_name,
      name: user.name,
    }, null, 2));
    return;
  }
  console.log(`x: authenticated as @${user.screen_name} (${user.name})`);
}

async function runWatch(options) {
  const minutes = clampInteger(options.intervalMinutes, 1, 1440, 60);
  while (true) {
    await runOnce(options);
    await new Promise((resolve) => setTimeout(resolve, minutes * 60_000));
  }
}

async function installLaunchAgent(options) {
  const intervalSeconds = clampInteger(options.intervalSeconds, 60, 86_400, 1800);
  const scheduledAt = options.at ? parseScheduledDate(options.at) : null;
  const label = options.label ?? (
    scheduledAt
      ? `com.codex-token-burn-banner.once.${formatLabelTimestamp(scheduledAt)}`
      : 'com.codex-token-burn-banner'
  );
  const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const plistPath = path.join(launchAgentsDir, `${label}.plist`);
  const nodePath = await resolveNodePath();
  const logPath = path.join(os.homedir(), 'Library', 'Logs', 'codex-token-burn-banner.log');
  const programArgs = buildLaunchAgentProgramArgs(nodePath, options);

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapePlist(label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs.map((arg) => `    <string>${escapePlist(arg)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapePlist(rootDir)}</string>
${scheduledAt ? calendarIntervalPlist(scheduledAt) : intervalPlist(intervalSeconds)}
  <key>StandardOutPath</key>
  <string>${escapePlist(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapePlist(logPath)}</string>
</dict>
</plist>
`;

  await fs.mkdir(launchAgentsDir, { recursive: true });
  await fs.writeFile(plistPath, plist, { mode: 0o644 });
  console.log(`wrote: ${plistPath}`);
  console.log(`load: launchctl bootstrap gui/$(id -u) ${plistPath}`);
  if (!scheduledAt) {
    console.log(`kick: launchctl kickstart -k gui/$(id -u)/${label}`);
  }
}

async function installDailyImageAgent(options) {
  const hour = clampInteger(options.hour, 0, 23, 8);
  const minute = clampInteger(options.minute, 0, 59, 5);
  const label = options.label ?? 'com.codex-token-burn-banner.daily-x-image';
  const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const plistPath = path.join(launchAgentsDir, `${label}.plist`);
  const nodePath = await resolveNodePath();
  const logPath = path.join(os.homedir(), 'Library', 'Logs', 'codex-daily-x-image.log');
  const programArgs = buildDailyImageAgentProgramArgs(nodePath, options);

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapePlist(label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs.map((arg) => `    <string>${escapePlist(arg)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapePlist(rootDir)}</string>
${dailyCalendarPlist(hour, minute, options.runAtLoad)}
  <key>StandardOutPath</key>
  <string>${escapePlist(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapePlist(logPath)}</string>
</dict>
</plist>
`;

  await fs.mkdir(launchAgentsDir, { recursive: true });
  await fs.writeFile(plistPath, plist, { mode: 0o644 });
  console.log(`wrote: ${plistPath}`);
  console.log(`daily: ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} local`);
  console.log(`load: launchctl bootstrap gui/$(id -u) ${plistPath}`);
  console.log(`kick: launchctl kickstart -k gui/$(id -u)/${label}`);
}

function buildLaunchAgentProgramArgs(nodePath, options) {
  const args = [
    nodePath,
    __filename,
    'once',
    '--upload',
  ];

  if (options.preferCodexBar === false) args.push('--no-codexbar');
  if (options.tweet) args.push('--tweet');
  if (options.tweetImage) args.push('--tweet-image');
  if (options.tweetText) args.push('--tweet-text', options.tweetText);
  if (options.days !== 30) args.push('--days', String(options.days));
  if (options.codexHome) args.push('--codex-home', options.codexHome);
  if (options.codexbarBin) args.push('--codexbar-bin', options.codexbarBin);
  if (options.output) args.push('--output', options.output);
  if (options.tweetImageOutput) args.push('--tweet-image-output', options.tweetImageOutput);

  return args;
}

async function resolveNodePath() {
  for (const candidate of ['/opt/homebrew/bin/node', '/usr/local/bin/node', process.execPath]) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {}
  }
  return process.execPath;
}

function buildDailyImageAgentProgramArgs(nodePath, options) {
  const args = [
    nodePath,
    __filename,
    'daily-image',
  ];

  if (!options.noTweet) args.push('--tweet');
  if (options.dryRun) args.push('--dry-run');
  if (options.noUpload) args.push('--no-upload');
  if (options.preferCodexBar === false) args.push('--no-codexbar');
  if (options.tweetText) args.push('--tweet-text', options.tweetText);
  if (options.days !== 30) args.push('--days', String(options.days));
  if (options.codexHome) args.push('--codex-home', options.codexHome);
  if (options.codexbarBin) args.push('--codexbar-bin', options.codexbarBin);
  if (options.activityOutput) args.push('--activity-output', options.activityOutput);

  return args;
}

function intervalPlist(intervalSeconds) {
  return `  <key>StartInterval</key>
  <integer>${intervalSeconds}</integer>
  <key>RunAtLoad</key>
  <true/>`;
}

function dailyCalendarPlist(hour, minute, runAtLoad) {
  return `  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${hour}</integer>
    <key>Minute</key>
    <integer>${minute}</integer>
  </dict>${runAtLoad ? `
  <key>RunAtLoad</key>
  <true/>` : ''}`;
}

function calendarIntervalPlist(date) {
  return `  <key>StartCalendarInterval</key>
  <dict>
    <key>Month</key>
    <integer>${date.getMonth() + 1}</integer>
    <key>Day</key>
    <integer>${date.getDate()}</integer>
    <key>Hour</key>
    <integer>${date.getHours()}</integer>
    <key>Minute</key>
    <integer>${date.getMinutes()}</integer>
  </dict>
  <key>LaunchOnlyOnce</key>
  <true/>`;
}

function printSummary(summary, imagePath, status) {
  if (imagePath) console.log(`image: ${imagePath}`);
  if (status?.tweetImagePath) console.log(`tweet image: ${status.tweetImagePath}`);
  console.log(`source: ${summary.source} (${summary.sourceDetail ?? 'default'})`);
  console.log(`today: ${formatNumber(summary.today.totalTokens)} tokens ${asciiBar(summary.today.totalTokens, summary.maxDailyTokens, 24)}`);
  console.log(`yesterday: ${formatNumber(summary.yesterday.totalTokens)} tokens ${asciiBar(summary.yesterday.totalTokens, summary.maxDailyTokens, 24)}`);
  if (summary.today.totalCost != null) console.log(`today api-equivalent: ${formatCurrency(summary.today.totalCost)}`);
  if (summary.yesterday.totalCost != null) console.log(`yesterday api-equivalent: ${formatCurrency(summary.yesterday.totalCost)}`);
  console.log(`history: ${formatNumber(summary.totals.totalTokens)} tokens over ${summary.historyDays}d`);
  if (summary.totals.totalCost != null) console.log(`history api-equivalent: ${formatCurrency(summary.totals.totalCost)}`);
  if (status?.scanOnly) return;
  if (status?.uploaded) {
    console.log('x: uploaded');
  } else if (status?.missingCredentials?.length) {
    console.log(`x: skipped, missing ${status.missingCredentials.join(', ')}`);
  } else if (status?.dryRun) {
    console.log('x: skipped by dry-run/no-upload');
  }
  if (status?.tweetResult?.data?.id) {
    console.log(`tweet: posted ${status.tweetResult.data.id}`);
  } else if (status?.tweetText && status?.dryRun) {
    console.log(`tweet: skipped by dry-run/no-upload`);
    console.log(status.tweetText);
  }
}

function parseOptions(argv) {
  const options = {
    days: 30,
    output: null,
    dryRun: false,
    upload: false,
    noUpload: false,
    tweet: false,
    tweetImage: false,
    tweetImageOutput: null,
    tweetText: null,
    json: false,
    codexHome: null,
    codexbarBin: null,
    preferCodexBar: true,
    intervalMinutes: 60,
    intervalSeconds: 1800,
    hour: 8,
    minute: 5,
    runAtLoad: false,
    now: null,
    at: null,
    label: null,
    day: null,
    yesterday: false,
    bucketMinutes: 5,
    activityOutput: null,
    highlights: [],
    noHighlights: false,
    noTweet: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[index];
    };

    switch (arg) {
      case '--days':
        options.days = Number.parseInt(next(), 10);
        break;
      case '--output':
        options.output = next();
        break;
      case '--codex-home':
        options.codexHome = next();
        break;
      case '--codexbar-bin':
        options.codexbarBin = next();
        break;
      case '--no-codexbar':
        options.preferCodexBar = false;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--upload':
        options.upload = true;
        break;
      case '--tweet':
        options.tweet = true;
        break;
      case '--no-tweet':
        options.noTweet = true;
        break;
      case '--tweet-image':
        options.tweetImage = true;
        break;
      case '--tweet-image-output':
        options.tweetImage = true;
        options.tweetImageOutput = next();
        break;
      case '--tweet-text':
        options.tweet = true;
        options.tweetText = next();
        break;
      case '--no-upload':
        options.noUpload = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--interval-minutes':
        options.intervalMinutes = Number.parseInt(next(), 10);
        break;
      case '--interval-seconds':
        options.intervalSeconds = Number.parseInt(next(), 10);
        break;
      case '--hour':
        options.hour = Number.parseInt(next(), 10);
        break;
      case '--minute':
        options.minute = Number.parseInt(next(), 10);
        break;
      case '--run-at-load':
        options.runAtLoad = true;
        break;
      case '--now':
        options.now = next();
        break;
      case '--at':
        options.at = next();
        break;
      case '--label':
        options.label = next();
        break;
      case '--day':
        options.day = next();
        break;
      case '--yesterday':
        options.yesterday = true;
        break;
      case '--bucket-minutes':
        options.bucketMinutes = Number.parseInt(next(), 10);
        break;
      case '--activity-output':
        options.activityOutput = next();
        break;
      case '--highlight':
        options.highlights.push(next());
        break;
      case '--no-highlights':
        options.noHighlights = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage:
  token-burn-banner once [--upload|--dry-run|--no-upload] [--tweet] [--output <png>]
  token-burn-banner render [--output <png>]
  token-burn-banner scan [--json]
  token-burn-banner activity [--day <yyyy-mm-dd>|--yesterday] [--activity-output <png>] [--tweet]
  token-burn-banner daily-image [--tweet]
  token-burn-banner verify-x [--json]
  token-burn-banner watch [--interval-minutes <n>]
  token-burn-banner install-launch-agent [--interval-seconds <n>|--at <iso-local>]
  token-burn-banner install-daily-image-agent [--hour <0-23>] [--minute <0-59>] [--no-tweet]

Options:
  --days <n>             History window, default 30
  --codex-home <path>    Codex home, default CODEX_HOME or ~/.codex
  --codexbar-bin <path>  Prefer this codexbar CLI binary when present
  --no-codexbar          Force built-in local JSONL scanner
  --now <iso>            Test with a fixed timestamp
  --at <iso-local>       Install a one-shot LaunchAgent for a local date/time
  --tweet                Post a default daily token-burn tweet
  --no-tweet             Install daily image agent without posting to X
  --tweet-image          Attach a feed-optimized token-burn image to the tweet
  --tweet-text <text>    Post custom tweet text
  --day <yyyy-mm-dd>     Day for agent activity image
  --yesterday            Use previous local day for agent activity image
  --highlight <text>     Add shipped highlight; repeat up to 3
  --run-at-load          Run an installed daily LaunchAgent once when loaded
  --json                 Print JSON
`);
}

function buildTweetText(summary) {
  const today = summary.today.totalTokens;
  const yesterday = summary.yesterday.totalTokens;
  const max = summary.maxDailyTokens;
  const headlineDay = today > 0 ? 'today' : 'yesterday';
  const headlineTokens = today > 0 ? today : yesterday;

  return [
    `codex burn ${headlineDay}: ${formatCompactNumber(headlineTokens)} tokens`,
    `TOD ${asciiBar(today, max, 24)}`,
    `YDY ${asciiBar(yesterday, max, 24)}`,
    'local cache-inclusive estimate',
  ].join('\n');
}

function buildPromoTweetText(summary) {
  const today = summary.today.totalTokens;
  const yesterday = summary.yesterday.totalTokens;

  return [
    'made my X banner auto-update with my daily Codex burn',
    '',
    `today: ${formatCompactNumber(today)} tokens`,
    `yesterday: ${formatCompactNumber(yesterday)} tokens`,
    '',
    'tiny pet included because apparently the machine needs a scoreboard',
  ].join('\n');
}

function buildActivityTweetText(activity, usageEntry) {
  return [
    `codex agent burn - ${formatDayLabel(activity.dayKey)}`,
    `${formatCurrency(usageEntry.totalCost)} API-equiv spend`,
    `${formatHoursDecimal(activity.metrics.agentMinutes)} agent hours`,
    `${formatCompactNumber(usageEntry.totalTokens)} tokens burned`,
  ].join('\n');
}

function formatCompactNumber(value) {
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(Number(value) || 0);
}

function formatNumber(value) {
  return new Intl.NumberFormat('en-US').format(Number(value) || 0);
}

function formatCurrency(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: Number(value) >= 100 ? 0 : 2,
  }).format(Number(value) || 0);
}

function formatDuration(minutes) {
  const safe = Math.max(0, Number(minutes) || 0);
  if (safe >= 60) return `${(safe / 60).toFixed(safe >= 600 ? 0 : 1).replace(/\.0$/, '')}h`;
  return `${Math.round(safe)}m`;
}

function formatHoursDecimal(minutes) {
  const safe = Math.max(0, Number(minutes) || 0);
  return `${(safe / 60).toFixed(1).replace(/\.0$/, '')}h`;
}

function formatHoursMinutes(minutes) {
  const safe = Math.max(0, Math.round(Number(minutes) || 0));
  const hours = Math.floor(safe / 60);
  const remainder = safe % 60;
  if (hours <= 0) return `${remainder}m`;
  if (remainder === 0) return `${hours}h`;
  return `${hours}h ${remainder}m`;
}

function localDayKeyFromDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function shiftLocalDate(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
}

function formatDayLabel(dayKey) {
  if (!dayKey) return 'unknown day';
  const [year, month, day] = dayKey.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(year, month - 1, day));
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function parseScheduledDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid --at date: ${value}`);
  }
  return date;
}

function formatLabelTimestamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    'T',
    pad(date.getHours()),
    pad(date.getMinutes()),
  ].join('');
}

function escapePlist(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
