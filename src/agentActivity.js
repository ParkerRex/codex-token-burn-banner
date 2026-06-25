import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { localDayKey, shiftDayKey } from './codexUsage.js';

const DEFAULT_BUCKET_MINUTES = 5;
const OPEN_TURN_MAX_HOURS = 6;

export async function loadAgentActivityReport(options = {}) {
  const now = options.now ?? new Date();
  const dayKey = options.dayKey ?? localDayKey(now);
  const bucketMinutes = clampInteger(options.bucketMinutes, 1, 60, DEFAULT_BUCKET_MINUTES);
  const codexHome = resolveCodexHome(options.codexHome);
  const files = await listCandidateSessionFiles(codexHome, dayKey);
  const uniqueFiles = await selectUniqueSessionFiles(files);
  const intervals = [];

  for (const file of uniqueFiles) {
    intervals.push(...await parseActivityIntervals(file, { now, dayKey }));
  }

  const dayStart = dayKeyToDate(dayKey);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const clipped = intervals
    .map((interval) => clipInterval(interval, dayStart, dayEnd))
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);
  const buckets = buildBuckets(clipped, { dayStart, bucketMinutes });
  const coverage = coverageStats(clipped);
  const peak = peakBucket(buckets);
  const activeAgents = new Set(clipped.map((interval) => interval.agentId));
  const turnIds = new Set(clipped.map((interval) => interval.turnId).filter(Boolean));
  const agentMinutes = clipped.reduce((total, interval) => total + ((interval.end - interval.start) / 60_000), 0);

  return {
    source: codexHome,
    dayKey,
    generatedAt: now,
    bucketMinutes,
    filesScanned: uniqueFiles.length,
    intervals: clipped.map((interval) => ({
      agentId: interval.agentId,
      turnId: interval.turnId,
      start: interval.start.toISOString(),
      end: interval.end.toISOString(),
      minutes: (interval.end - interval.start) / 60_000,
      status: interval.status,
    })),
    buckets,
    metrics: {
      activeAgents: activeAgents.size,
      turnCount: turnIds.size || clipped.length,
      intervalCount: clipped.length,
      agentMinutes,
      coverageMinutes: coverage.coverageMinutes,
      longestStreakMinutes: coverage.longestStreakMinutes,
      peakConcurrency: peak.count,
      peakMinute: peak.minute,
      peakTimeLabel: minuteLabel(peak.minute),
    },
  };
}

async function listCandidateSessionFiles(codexHome, dayKey) {
  const roots = [
    path.join(codexHome, 'sessions'),
    path.join(codexHome, 'archived_sessions'),
  ];
  const minDay = shiftDayKey(dayKey, -1);
  const maxDay = shiftDayKey(dayKey, 1);
  const modifiedSince = dayKeyToDate(minDay);
  const files = [];

  for (const root of roots) {
    const stat = await safeStat(root);
    if (!stat?.isDirectory()) continue;

    const stack = [root];
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
        if (dateHint && (dateHint < minDay || dateHint > maxDay)) continue;
        if (!dateHint) {
          const fileStat = await safeStat(fullPath);
          if (fileStat?.mtime && fileStat.mtime < modifiedSince) continue;
        }
        files.push(fullPath);
      }
    }
  }

  return files;
}

async function selectUniqueSessionFiles(files) {
  const byKey = new Map();
  for (const file of files) {
    const [stat, realPath, metadata] = await Promise.all([
      safeStat(file),
      fs.realpath(file).catch(() => file),
      readSessionMetadata(file),
    ]);
    if (!stat?.isFile()) continue;
    const key = metadata.sessionId ? `session:${metadata.sessionId}` : `file:${realPath}`;
    const current = byKey.get(key);
    const candidate = { file, size: stat.size, mtimeMs: stat.mtimeMs };
    if (!current || candidate.size > current.size || candidate.mtimeMs > current.mtimeMs) {
      byKey.set(key, candidate);
    }
  }
  return [...byKey.values()].map((entry) => entry.file);
}

async function parseActivityIntervals(file, options) {
  const metadata = await readSessionMetadata(file);
  const fallbackId = path.basename(file, '.jsonl');
  let agentId = metadata.sessionId ?? fallbackId;
  let open = null;
  let lastTimestamp = null;
  const intervals = [];
  const selectedDay = options.dayKey;

  const rl = readline.createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (
      !line.includes('"type":"session_meta"')
      && !line.includes('"type":"event_msg"')
    ) {
      continue;
    }
    if (
      line.includes('"type":"event_msg"')
      && !line.includes('"task_started"')
      && !line.includes('"task_complete"')
      && !line.includes('"turn_aborted"')
    ) {
      continue;
    }

    const obj = safeJsonParse(line);
    if (!obj || typeof obj !== 'object') continue;

    if (obj.type === 'session_meta') {
      const payload = obj.payload ?? {};
      agentId = payload.session_id ?? payload.sessionId ?? payload.id ?? agentId;
      continue;
    }

    const timestamp = parseTimestamp(obj.timestamp);
    if (timestamp) lastTimestamp = timestamp;
    const payload = obj.payload ?? {};
    const eventType = payload.type;
    if (!timestamp || !eventType) continue;

    if (eventType === 'task_started') {
      if (open) {
        intervals.push({ ...open, end: timestamp, status: 'superseded' });
      }
      open = {
        agentId,
        turnId: codexTurnId(payload),
        start: timestamp,
      };
      continue;
    }

    if ((eventType === 'task_complete' || eventType === 'turn_aborted') && open) {
      intervals.push({
        ...open,
        end: timestamp,
        status: eventType === 'task_complete' ? 'complete' : 'aborted',
      });
      open = null;
    }
  }

  if (open) {
    const sameDayAsNow = selectedDay === localDayKey(options.now);
    const maxOpenEnd = new Date(open.start.getTime() + OPEN_TURN_MAX_HOURS * 60 * 60 * 1000);
    const inferredEnd = sameDayAsNow ? options.now : lastTimestamp ?? maxOpenEnd;
    intervals.push({
      ...open,
      end: new Date(Math.min(inferredEnd.getTime(), maxOpenEnd.getTime())),
      status: 'open',
    });
  }

  return intervals.filter((interval) => interval.end > interval.start);
}

async function readSessionMetadata(file) {
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
      const payload = obj?.payload ?? {};
      return {
        sessionId: payload.session_id ?? payload.sessionId ?? payload.id ?? obj?.session_id ?? obj?.sessionId ?? obj?.id ?? null,
      };
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return { sessionId: null };
}

function buildBuckets(intervals, { dayStart, bucketMinutes }) {
  const bucketMs = bucketMinutes * 60_000;
  const bucketCount = Math.ceil((24 * 60) / bucketMinutes);
  const bucketSets = Array.from({ length: bucketCount }, () => new Set());

  for (const interval of intervals) {
    const startIndex = Math.max(0, Math.floor((interval.start - dayStart) / bucketMs));
    const endIndex = Math.min(bucketCount - 1, Math.ceil((interval.end - dayStart) / bucketMs) - 1);
    for (let index = startIndex; index <= endIndex; index += 1) {
      bucketSets[index].add(interval.agentId);
    }
  }

  return bucketSets.map((set, index) => ({
    minute: index * bucketMinutes,
    timeLabel: minuteLabel(index * bucketMinutes),
    count: set.size,
  }));
}

function coverageStats(intervals) {
  if (!intervals.length) return { coverageMinutes: 0, longestStreakMinutes: 0 };

  const merged = [];
  for (const interval of intervals) {
    const last = merged.at(-1);
    if (!last || interval.start > last.end) {
      merged.push({ start: interval.start, end: interval.end });
    } else if (interval.end > last.end) {
      last.end = interval.end;
    }
  }

  let coverageMinutes = 0;
  let longestStreakMinutes = 0;
  for (const interval of merged) {
    const minutes = (interval.end - interval.start) / 60_000;
    coverageMinutes += minutes;
    longestStreakMinutes = Math.max(longestStreakMinutes, minutes);
  }
  return { coverageMinutes, longestStreakMinutes };
}

function clipInterval(interval, dayStart, dayEnd) {
  const start = new Date(Math.max(interval.start.getTime(), dayStart.getTime()));
  const end = new Date(Math.min(interval.end.getTime(), dayEnd.getTime()));
  if (end <= start) return null;
  return { ...interval, start, end };
}

function peakBucket(buckets) {
  return buckets.reduce((peak, bucket) => (bucket.count > peak.count ? bucket : peak), {
    minute: 0,
    count: 0,
  });
}

function resolveCodexHome(explicitHome) {
  const raw = explicitHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  if (raw.startsWith('~')) return path.join(os.homedir(), raw.slice(1));
  return raw;
}

function dayKeyToDate(dayKey) {
  const [year, month, day] = dayKey.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function parseTimestamp(value) {
  if (value == null) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function minuteLabel(minute) {
  const hours = Math.floor(minute / 60);
  const minutes = minute % 60;
  const date = new Date(2000, 0, 1, hours, minutes);
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: minutes === 0 ? undefined : '2-digit',
  }).format(date).toLowerCase().replace(/\s/g, '');
}

function codexTurnId(payload) {
  return payload.turn_id ?? payload.turnId ?? payload.id ?? payload.info?.turn_id ?? payload.info?.turnId ?? payload.info?.id ?? null;
}

function extractDayKey(value) {
  const match = String(value).match(/\d{4}-\d{2}-\d{2}|\/(\d{4})\/(\d{2})\/(\d{2})(?:\/|$)/);
  if (!match) return null;
  if (match[1]) return `${match[1]}-${match[2]}-${match[3]}`;
  return match[0];
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

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}
