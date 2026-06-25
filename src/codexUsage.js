import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_HISTORY_DAYS = 30;
const CODEX_ACTIVE_SESSION_LOOKBACK_DAYS = 30;
const CODEX_LONG_CONTEXT_THRESHOLD = 272_000;
const CODEX_PRICING = {
  'gpt-5': { input: 1.25e-6, cached: 1.25e-7, output: 1e-5 },
  'gpt-5-codex': { input: 1.25e-6, cached: 1.25e-7, output: 1e-5 },
  'gpt-5-mini': { input: 2.5e-7, cached: 2.5e-8, output: 2e-6 },
  'gpt-5-nano': { input: 5e-8, cached: 5e-9, output: 4e-7 },
  'gpt-5-pro': { input: 1.5e-5, cached: null, output: 1.2e-4 },
  'gpt-5.1': { input: 1.25e-6, cached: 1.25e-7, output: 1e-5 },
  'gpt-5.1-codex': { input: 1.25e-6, cached: 1.25e-7, output: 1e-5 },
  'gpt-5.1-codex-max': { input: 1.25e-6, cached: 1.25e-7, output: 1e-5 },
  'gpt-5.1-codex-mini': { input: 2.5e-7, cached: 2.5e-8, output: 2e-6 },
  'gpt-5.2': { input: 1.75e-6, cached: 1.75e-7, output: 1.4e-5 },
  'gpt-5.2-codex': { input: 1.75e-6, cached: 1.75e-7, output: 1.4e-5 },
  'gpt-5.2-pro': { input: 2.1e-5, cached: null, output: 1.68e-4 },
  'gpt-5.3-codex': { input: 1.75e-6, cached: 1.75e-7, output: 1.4e-5 },
  'gpt-5.3-codex-spark': { input: 0, cached: 0, output: 0 },
  'gpt-5.4': {
    input: 2.5e-6,
    cached: 2.5e-7,
    output: 1.5e-5,
    longInput: 5e-6,
    longCached: 5e-7,
    longOutput: 2.25e-5,
  },
  'gpt-5.4-mini': { input: 7.5e-7, cached: 7.5e-8, output: 4.5e-6 },
  'gpt-5.4-nano': { input: 2e-7, cached: 2e-8, output: 1.25e-6 },
  'gpt-5.4-pro': { input: 3e-5, cached: null, output: 1.8e-4 },
  'gpt-5.5': {
    input: 5e-6,
    cached: 5e-7,
    output: 3e-5,
    longInput: 1e-5,
    longCached: 1e-6,
    longOutput: 4.5e-5,
  },
  'gpt-5.5-pro': { input: 3e-5, cached: null, output: 1.8e-4 },
};

export function localDayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function shiftDayKey(dayKey, days) {
  const [year, month, day] = dayKey.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + days);
  return localDayKey(date);
}

export function dayKeyFromTimestamp(timestamp) {
  if (timestamp == null) return null;
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
    return localDayKey(new Date(timestamp * 1000));
  }

  const raw = String(timestamp).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    return localDayKey(new Date(Number(raw) * 1000));
  }

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return localDayKey(date);
}

export function formatHumanDate(dayKey, locale = 'en-US') {
  const [year, month, day] = dayKey.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

export function asciiBar(value, maxValue, width = 34) {
  const safeMax = Math.max(1, Number(maxValue) || 0);
  const safeValue = Math.max(0, Number(value) || 0);
  const filled = Math.max(0, Math.min(width, Math.round((safeValue / safeMax) * width)));
  return `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}]`;
}

export async function loadCodexUsageReport(options = {}) {
  const now = options.now ?? new Date();
  const days = clampInteger(options.days, 1, 365, DEFAULT_HISTORY_DAYS);

  if (options.preferCodexBar !== false) {
    const codexBarReport = await loadFromCodexBarCli({ ...options, days, now });
    if (codexBarReport) return codexBarReport;
  }

  return scanCodexLogs({ ...options, days, now });
}

export function summarizeUsageReport(report, now = new Date()) {
  const todayKey = localDayKey(now);
  const yesterdayKey = shiftDayKey(todayKey, -1);
  const byDate = new Map(report.daily.map((entry) => [entry.date, entry]));
  const today = byDate.get(todayKey) ?? emptyDailyEntry(todayKey);
  const yesterday = byDate.get(yesterdayKey) ?? emptyDailyEntry(yesterdayKey);
  const maxDailyTokens = Math.max(
    1,
    ...report.daily.map((entry) => entry.totalTokens ?? 0),
    today.totalTokens ?? 0,
    yesterday.totalTokens ?? 0,
  );

  const primary = today.totalTokens > 0
    ? { label: 'TODAY', mode: 'today', entry: today }
    : { label: 'YESTERDAY', mode: 'yesterday', entry: yesterday };

  return {
    source: report.source,
    sourceDetail: report.sourceDetail,
    generatedAt: now,
    todayKey,
    yesterdayKey,
    today,
    yesterday,
    primary,
    maxDailyTokens,
    todayBar: asciiBar(today.totalTokens ?? 0, maxDailyTokens),
    yesterdayBar: asciiBar(yesterday.totalTokens ?? 0, maxDailyTokens),
    historyDays: report.historyDays,
    totals: report.totals,
    daily: report.daily,
  };
}

async function loadFromCodexBarCli(options) {
  const bin = await resolveCodexBarBinary(options.codexbarBin);
  if (!bin) return null;

  const args = [
    'cost',
    '--provider',
    'codex',
    '--format',
    'json',
    '--json-only',
    '--days',
    String(options.days),
  ];

  try {
    const { stdout } = await execFileAsync(bin, args, {
      timeout: 45_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const payload = JSON.parse(stdout);
    const item = Array.isArray(payload)
      ? payload.find((entry) => entry.provider === 'codex') ?? payload[0]
      : payload;
    if (!item || item.error) return null;
    const daily = normalizeDailyEntries(item.daily ?? []);
    return {
      source: 'codexbar-cli',
      sourceDetail: bin,
      historyDays: item.historyDays ?? options.days,
      daily,
      totals: computeTotals(daily, item.totals),
      updatedAt: item.updatedAt ? new Date(item.updatedAt) : options.now,
    };
  } catch {
    return null;
  }
}

async function resolveCodexBarBinary(explicitBin) {
  if (explicitBin) return explicitBin;
  if (process.env.CODEXBAR_BIN) return process.env.CODEXBAR_BIN;

  try {
    const { stdout } = await execFileAsync('which', ['codexbar'], { timeout: 3_000 });
    const candidate = stdout.trim();
    return candidate || null;
  } catch {
    return null;
  }
}

async function scanCodexLogs(options) {
  const codexHome = resolveCodexHome(options.codexHome);
  const roots = [
    path.join(codexHome, 'sessions'),
    path.join(codexHome, 'archived_sessions'),
  ];
  const nowKey = localDayKey(options.now);
  const sinceKey = shiftDayKey(nowKey, -(options.days - 1));
  const scanSinceKey = shiftDayKey(sinceKey, -1);
  const scanUntilKey = shiftDayKey(nowKey, 1);
  const files = [];

  for (const root of roots) {
    files.push(...await listCodexJsonlFiles(root, { scanSinceKey, scanUntilKey }));
  }

  const uniqueFiles = await selectUniqueCodexFiles(files);
  const dailyByKey = new Map();
  for (const file of uniqueFiles) {
    const parsed = await parseCodexSessionFile(file, { scanSinceKey, scanUntilKey });
    for (const entry of parsed) {
      if (entry.date < sinceKey || entry.date > nowKey) continue;
      mergeDailyEntry(dailyByKey, entry);
    }
  }

  const daily = [...dailyByKey.values()]
    .map(stripInternalDailyFields)
    .sort((a, b) => a.date.localeCompare(b.date));
  return {
    source: 'builtin-codexbar-style',
    sourceDetail: codexHome,
    historyDays: options.days,
    daily,
    totals: computeTotals(daily),
    updatedAt: options.now,
  };
}

async function selectUniqueCodexFiles(files) {
  const byKey = new Map();
  for (const file of files) {
    const [stat, realPath, metadata] = await Promise.all([
      safeStat(file),
      fs.realpath(file).catch(() => file),
      readCodexSessionMetadata(file),
    ]);
    if (!stat?.isFile()) continue;
    const key = metadata.sessionId ? `session:${metadata.sessionId}` : `file:${realPath}`;
    const candidate = {
      file,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
    const current = byKey.get(key);
    if (!current || candidate.size > current.size || candidate.mtimeMs > current.mtimeMs) {
      byKey.set(key, candidate);
    }
  }
  return [...byKey.values()].map((item) => item.file);
}

async function readCodexSessionMetadata(file) {
  const stream = createReadStream(file, {
    encoding: 'utf8',
    start: 0,
    end: 512 * 1024,
  });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line.includes('"type":"session_meta"')) continue;
      const obj = safeJsonParse(line);
      if (obj?.type !== 'session_meta') continue;
      const payload = obj.payload ?? {};
      return {
        sessionId: payload.session_id ?? payload.sessionId ?? payload.id ?? obj.session_id ?? obj.sessionId ?? obj.id ?? null,
        forkedFromId: payload.forked_from_id ?? payload.forkedFromId ?? payload.parent_session_id ?? payload.parentSessionId ?? null,
      };
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return { sessionId: null, forkedFromId: null };
}

function resolveCodexHome(explicitHome) {
  const raw = explicitHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  if (raw.startsWith('~')) return path.join(os.homedir(), raw.slice(1));
  return raw;
}

async function listCodexJsonlFiles(root, range) {
  const files = [];
  const rootStat = await safeStat(root);
  if (!rootStat?.isDirectory()) return files;

  const stack = [root];
  const modifiedSince = dayKeyToDate(shiftDayKey(range.scanSinceKey, -CODEX_ACTIVE_SESSION_LOOKBACK_DAYS));

  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.jsonl') continue;

      const dateHint = extractDayKey(fullPath);
      if (dateHint && (dateHint < range.scanSinceKey || dateHint > range.scanUntilKey)) {
        continue;
      }
      if (!dateHint) {
        const stat = await safeStat(fullPath);
        if (stat?.mtime && stat.mtime < modifiedSince) continue;
      }
      files.push(fullPath);
    }
  }

  return files;
}

async function parseCodexSessionFile(file, range) {
  const out = new Map();
  let currentModel = null;
  let previousTotals = null;
  let rawTotalsBaseline = null;
  let sawDivergentTotals = false;
  let currentTurnId = null;

  const rl = readline.createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line || line.length > 512 * 1024) {
      const model = extractTurnContextModelPrefix(line);
      if (model) currentModel = model;
      continue;
    }
    if (
      !line.includes('"type":"event_msg"')
      && !line.includes('"type":"turn_context"')
      && !line.includes('"type":"session_meta"')
    ) {
      continue;
    }
    if (
      line.includes('"type":"event_msg"')
      && !line.includes('"token_count"')
      && !line.includes('"task_started"')
    ) {
      continue;
    }

    const obj = safeJsonParse(line);
    if (!obj || typeof obj !== 'object') continue;

    if (obj.type === 'turn_context') {
      const payload = obj.payload ?? {};
      currentModel = payload.model ?? payload.info?.model ?? currentModel;
      continue;
    }

    if (obj.type !== 'event_msg') continue;
    const payload = obj.payload ?? {};
    if (payload.type === 'task_started') {
      currentTurnId = codexTurnId(payload) ?? currentTurnId;
      continue;
    }
    if (payload.type !== 'token_count') continue;

    const dayKey = dayKeyFromTimestamp(obj.timestamp);
    if (!dayKey || dayKey < range.scanSinceKey || dayKey > range.scanUntilKey) continue;

    const info = payload.info ?? {};
    const model = normalizeCodexModel(
      currentModel
      ?? info.model
      ?? info.model_name
      ?? payload.model
      ?? obj.model
      ?? 'gpt-5',
    );
    const total = totalsFromTokenUsage(info.total_token_usage);
    const last = totalsFromTokenUsage(info.last_token_usage);
    let delta = null;

    if (last) {
      delta = last;
      const counted = addTotals(previousTotals ?? zeroTotals(), delta);
      previousTotals = counted;
      if (total) {
        rawTotalsBaseline = total;
        if (!totalsEqual(total, counted)) sawDivergentTotals = true;
      } else {
        rawTotalsBaseline = counted;
      }
    } else if (total) {
      delta = sawDivergentTotals
        ? divergentDelta(rawTotalsBaseline, previousTotals, total)
        : totalDelta(rawTotalsBaseline, total);
      previousTotals = addTotals(previousTotals ?? zeroTotals(), delta);
      rawTotalsBaseline = total;
      if (!totalsEqual(rawTotalsBaseline, previousTotals)) sawDivergentTotals = true;
    }

    if (!delta || (delta.input === 0 && delta.cached === 0 && delta.output === 0)) continue;
    const cached = Math.min(delta.cached, delta.input);
    const cost = codexCostUSD({
      model,
      inputTokens: delta.input,
      cachedInputTokens: cached,
      outputTokens: delta.output,
    });
    mergeDailyEntry(out, {
      date: dayKey,
      inputTokens: delta.input,
      cacheReadTokens: cached,
      outputTokens: delta.output,
      totalTokens: delta.input + cached + delta.output,
      totalCost: cost,
      modelsUsed: [model],
      modelBreakdowns: [{
        modelName: model,
        inputTokens: delta.input,
        cacheReadTokens: cached,
        outputTokens: delta.output,
        totalTokens: delta.input + cached + delta.output,
        totalCost: cost,
      }],
      turnIds: compact([codexTurnId(payload), currentTurnId]),
    });
  }

  return [...out.values()];
}

function mergeDailyEntry(map, entry) {
  const existing = map.get(entry.date) ?? emptyDailyEntry(entry.date);
  const models = new Set([...(existing.modelsUsed ?? []), ...(entry.modelsUsed ?? [])]);
  const turnIds = new Set([...(existing.turnIds ?? []), ...(entry.turnIds ?? [])]);
  const breakdowns = mergeModelBreakdowns(existing.modelBreakdowns ?? [], entry.modelBreakdowns ?? []);

  map.set(entry.date, {
    date: entry.date,
    inputTokens: (existing.inputTokens ?? 0) + (entry.inputTokens ?? 0),
    cacheReadTokens: (existing.cacheReadTokens ?? 0) + (entry.cacheReadTokens ?? 0),
    cacheCreationTokens: (existing.cacheCreationTokens ?? 0) + (entry.cacheCreationTokens ?? 0),
    outputTokens: (existing.outputTokens ?? 0) + (entry.outputTokens ?? 0),
    totalTokens: (existing.totalTokens ?? 0) + (entry.totalTokens ?? 0),
    totalCost: addOptional(existing.totalCost, entry.totalCost),
    modelsUsed: [...models].sort(),
    modelBreakdowns: breakdowns,
    turnIds: [...turnIds].sort(),
    turnCount: turnIds.size,
  });
}

function stripInternalDailyFields(entry) {
  const { turnIds, ...publicEntry } = entry;
  return {
    ...publicEntry,
    turnCount: entry.turnCount ?? turnIds?.length ?? 0,
  };
}

function mergeModelBreakdowns(left, right) {
  const map = new Map();
  for (const item of [...left, ...right]) {
    const key = item.modelName ?? 'unknown';
    const current = map.get(key) ?? {
      modelName: key,
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      totalCost: undefined,
    };
    current.inputTokens += item.inputTokens ?? 0;
    current.cacheReadTokens += item.cacheReadTokens ?? 0;
    current.outputTokens += item.outputTokens ?? 0;
    current.totalTokens += item.totalTokens ?? 0;
    current.totalCost = addOptional(current.totalCost, item.totalCost ?? item.cost);
    map.set(key, current);
  }
  return [...map.values()].sort((a, b) => (b.totalTokens ?? 0) - (a.totalTokens ?? 0));
}

function normalizeDailyEntries(entries) {
  const map = new Map();
  for (const entry of entries) {
    mergeDailyEntry(map, {
      date: entry.date,
      inputTokens: entry.inputTokens ?? 0,
      cacheReadTokens: entry.cacheReadTokens ?? 0,
      cacheCreationTokens: entry.cacheCreationTokens ?? 0,
      outputTokens: entry.outputTokens ?? 0,
      totalTokens: entry.totalTokens
        ?? sumNumbers(entry.inputTokens, entry.cacheReadTokens, entry.cacheCreationTokens, entry.outputTokens),
      totalCost: entry.totalCost ?? entry.costUSD ?? entry.cost,
      modelsUsed: entry.modelsUsed ?? entry.models ?? [],
      modelBreakdowns: (entry.modelBreakdowns ?? []).map((breakdown) => ({
        modelName: breakdown.modelName,
        totalTokens: breakdown.totalTokens ?? 0,
        totalCost: breakdown.cost ?? breakdown.costUSD,
      })),
    });
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function computeTotals(daily, fallback = null) {
  if (!daily.length && fallback) return fallback;
  return {
    inputTokens: sum(daily, 'inputTokens'),
    cacheReadTokens: sum(daily, 'cacheReadTokens'),
    cacheCreationTokens: sum(daily, 'cacheCreationTokens'),
    outputTokens: sum(daily, 'outputTokens'),
    totalTokens: sum(daily, 'totalTokens'),
    totalCost: daily.some((entry) => entry.totalCost != null) ? sum(daily, 'totalCost') : fallback?.totalCost,
  };
}

function emptyDailyEntry(date) {
  return {
    date,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    modelsUsed: [],
    modelBreakdowns: [],
    turnIds: [],
  };
}

function totalsFromTokenUsage(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    input: Math.max(0, toInt(value.input_tokens)),
    cached: Math.max(0, toInt(value.cached_input_tokens ?? value.cache_read_input_tokens)),
    output: Math.max(0, toInt(value.output_tokens)),
  };
}

function totalDelta(baseline, current) {
  const base = baseline ?? zeroTotals();
  return {
    input: Math.max(0, current.input - base.input),
    cached: Math.max(0, current.cached - base.cached),
    output: Math.max(0, current.output - base.output),
  };
}

function divergentDelta(rawBaseline, countedBaseline, current) {
  const raw = rawBaseline ?? zeroTotals();
  const counted = countedBaseline ?? zeroTotals();
  const delta = (rawValue, countedValue, currentValue) => (
    currentValue >= rawValue
      ? Math.max(0, currentValue - rawValue)
      : Math.max(0, currentValue - countedValue)
  );
  return {
    input: delta(raw.input, counted.input, current.input),
    cached: delta(raw.cached, counted.cached, current.cached),
    output: delta(raw.output, counted.output, current.output),
  };
}

function addTotals(left, right) {
  return {
    input: left.input + right.input,
    cached: left.cached + right.cached,
    output: left.output + right.output,
  };
}

function zeroTotals() {
  return { input: 0, cached: 0, output: 0 };
}

function totalsEqual(left, right) {
  if (!left || !right) return false;
  return left.input === right.input && left.cached === right.cached && left.output === right.output;
}

function codexTurnId(payload) {
  return payload.turn_id ?? payload.turnId ?? payload.id ?? payload.info?.turn_id ?? payload.info?.turnId ?? payload.info?.id ?? null;
}

export function normalizeCodexModel(model) {
  let normalized = String(model || 'gpt-5').trim().toLowerCase();
  if (normalized.startsWith('openai/')) normalized = normalized.slice('openai/'.length);
  if (CODEX_PRICING[normalized]) return normalized;

  const dated = normalized.match(/^(.*)-\d{4}-\d{2}-\d{2}$/);
  if (dated && CODEX_PRICING[dated[1]]) return dated[1];
  return normalized;
}

export function codexCostUSD({ model, inputTokens = 0, cachedInputTokens = 0, outputTokens = 0 }) {
  const pricing = CODEX_PRICING[normalizeCodexModel(model)];
  if (!pricing) return undefined;

  const input = Math.max(0, Number(inputTokens) || 0);
  const cached = Math.min(Math.max(0, Number(cachedInputTokens) || 0), input);
  const output = Math.max(0, Number(outputTokens) || 0);
  const nonCached = input - cached;
  const longContext = input > CODEX_LONG_CONTEXT_THRESHOLD;
  const inputRate = longContext ? pricing.longInput ?? pricing.input : pricing.input;
  const cachedRate = longContext
    ? pricing.longCached ?? pricing.cached ?? pricing.input
    : pricing.cached ?? pricing.input;
  const outputRate = longContext ? pricing.longOutput ?? pricing.output : pricing.output;

  return (nonCached * inputRate) + (cached * cachedRate) + (output * outputRate);
}

function extractTurnContextModelPrefix(line) {
  if (!line || !line.includes('"type":"turn_context"')) return null;
  const match = line.match(/"model"\s*:\s*"([^"]+)"/);
  return match?.[1] ?? null;
}

function extractDayKey(value) {
  const match = String(value).match(/\d{4}-\d{2}-\d{2}|\/(\d{4})\/(\d{2})\/(\d{2})(?:\/|$)/);
  if (!match) return null;
  if (match[1]) return `${match[1]}-${match[2]}-${match[3]}`;
  return match[0];
}

function dayKeyToDate(dayKey) {
  const [year, month, day] = dayKey.split('-').map(Number);
  return new Date(year, month - 1, day);
}

async function safeStat(file) {
  try {
    return await fs.stat(file);
  } catch {
    return null;
  }
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function toInt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim() !== '') return Math.trunc(Number(value)) || 0;
  return 0;
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function sum(entries, key) {
  return entries.reduce((total, entry) => total + (Number(entry[key]) || 0), 0);
}

function sumNumbers(...values) {
  return values.reduce((total, value) => total + (Number(value) || 0), 0);
}

function addOptional(left, right) {
  if (left == null && right == null) return undefined;
  return (Number(left) || 0) + (Number(right) || 0);
}

function compact(values) {
  return values.filter((value) => value != null && value !== '');
}
