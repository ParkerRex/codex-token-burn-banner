import { createReadStream } from 'node:fs';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';
import { localDayKey, shiftDayKey } from './codexUsage.js';

const execFileAsync = promisify(execFile);
const DEFAULT_WORKER_REPO = path.join(os.homedir(), 'Developer', 'worker');
const DEFAULT_HIGHLIGHTS = [
  'Flask -> FastAPI cutover',
  'video AI + captions',
  'Premiere React panel',
];

const RULES = [
  {
    label: 'Premiere React panel',
    kind: 'ship',
    weight: 30,
    phrases: [
      'fastapi-era workerpremierepro panel migration',
      'modern panel scaffold',
      'routed react',
      'vite + typescript',
      'tailwind v4',
      'system readiness',
      'typed api/openapi boundaries',
      'replace the legacy cep/uxp ui',
    ],
  },
  {
    label: 'video AI + captions',
    kind: 'ship',
    weight: 28,
    phrases: [
      'migrate remaining video ai routes',
      'migrate video editing routes',
      'migrate video job routes',
      'migrate audio and caption job routes',
      'migrate audio routes',
      'video ai routes',
      'caption job routes',
      'audio routes',
      'video editing routes',
    ],
  },
  {
    label: 'Flask -> FastAPI cutover',
    kind: 'ship',
    weight: 18,
    phrases: [
      'fastapi',
      'fastapi backend canonical',
      'fastapi server canonical',
      'worker-premiere-pro',
      'flask-only routes',
      'legacy flask fallback',
    ],
  },
  {
    label: 'runtime traces + status',
    kind: 'ship',
    weight: 4,
    phrases: [
      'observability',
      'worker run status telemetry',
      'trace metadata',
      'http cassettes',
      'provider span scope',
      'status telemetry',
    ],
  },
  {
    label: 'Adobe workers on Effect',
    kind: 'ship',
    weight: 16,
    phrases: [
      'worker photoshop to effect',
      'workerphotoshop namespace',
      'worker-adobe-illustrator',
      'migrate to effect architecture',
      'migrate worker photoshop',
    ],
  },
  {
    label: 'Worker DB core',
    kind: 'ship',
    weight: 22,
    phrases: ['worker-db', 'extract runtime database core', 'runtime database core'],
  },
  {
    label: 'X banner + feed post',
    kind: 'ship',
    weight: 7,
    phrases: [
      'profile banner',
      'x banner',
      'pet speech-bubble',
      'feed image',
      'posted it',
      'tweet returned',
      'tweet creation',
    ],
  },
  {
    label: 'agent activity poster',
    kind: 'ship',
    weight: 6,
    phrases: ['agent screen time', 'task_started', 'concurrency', 'agent-minutes', 'activity bars'],
  },
  {
    label: 'daily automation',
    kind: 'ship',
    weight: 5,
    phrases: ['launchagent', 'launchd', 'scheduled', 'plist', 'tomorrow at 4'],
  },
  {
    label: 'Python quality stack',
    kind: 'ship',
    weight: 1,
    phrases: ['worker-training', 'storage_roots.py', 'ruff', 'pyright', 'pytest'],
  },
  {
    label: 'integration architecture map',
    kind: 'research',
    weight: 1,
    phrases: ['openclaw', 'hermes', 'worker', 'integration setup', 'adapter system'],
  },
  {
    label: 'flight risk research',
    kind: 'research',
    weight: 1,
    phrases: ['google flights', 'cancellation history', 'bts', 'flight cancellation', 'route'],
  },
];

export async function loadDayHighlights(options = {}) {
  const now = options.now ?? new Date();
  const dayKey = options.dayKey ?? localDayKey(now);
  const codexHome = resolveCodexHome(options.codexHome);
  const workerRepo = options.workerRepo === false
    ? null
    : resolvePath(options.workerRepo ?? DEFAULT_WORKER_REPO);
  const files = await listCandidateFiles(codexHome, dayKey);
  const text = [];
  const commitPromise = workerRepo ? extractWorkerCommitText(workerRepo, dayKey) : Promise.resolve([]);

  for (const file of files) {
    text.push(...await extractCompletionText(file, dayKey));
  }
  text.push(...await commitPromise);

  const scores = new Map();
  for (const item of text) {
    const lower = item.toLowerCase();
    const sourceBoost = lower.startsWith('git commit:') ? 3 : 1;
    for (let index = 0; index < RULES.length; index += 1) {
      const rule = RULES[index];
      const hits = rule.phrases.filter((phrase) => lower.includes(phrase)).length;
      if (hits === 0) continue;

      const current = scores.get(rule.label) ?? {
        label: rule.label,
        kind: rule.kind,
        score: 0,
        order: index,
      };
      current.score += hits * rule.weight * sourceBoost;
      if (rule.kind === 'ship' && /\b(committed|implemented|built|posted|uploaded|installed|changed|added|fixed)\b/.test(lower)) {
        current.score += 2;
      }
      scores.set(rule.label, current);
    }
  }

  const candidates = [...scores.values()]
    .sort((a, b) => b.score - a.score || a.order - b.order);
  const shipped = candidates.filter((item) => item.kind === 'ship');
  const preferred = shipped.length >= 2 ? shipped : candidates;
  const highlights = preferred
    .map((item) => item.label)
    .slice(0, 3);

  return highlights.length ? highlights : DEFAULT_HIGHLIGHTS;
}

export async function loadWorkerCommitCount(options = {}) {
  const now = options.now ?? new Date();
  const dayKey = options.dayKey ?? localDayKey(now);
  const workerRepo = options.workerRepo === false
    ? null
    : resolvePath(options.workerRepo ?? DEFAULT_WORKER_REPO);
  if (!workerRepo) return null;
  const commits = await extractWorkerCommitText(workerRepo, dayKey);
  return commits.length;
}

async function extractWorkerCommitText(workerRepo, dayKey) {
  const stat = await safeStat(path.join(workerRepo, '.git'));
  if (!stat) return [];

  try {
    const { stdout } = await execFileAsync('git', [
      '-C',
      workerRepo,
      'log',
      `--since=${dayKey} 00:00`,
      `--until=${shiftDayKey(dayKey, 1)} 00:00`,
      '--pretty=format:%s',
      '--no-merges',
      '--all',
    ], {
      timeout: 5_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => `git commit: ${line}`);
  } catch {
    return [];
  }
}

async function listCandidateFiles(codexHome, dayKey) {
  const roots = [
    path.join(codexHome, 'sessions'),
    path.join(codexHome, 'archived_sessions'),
  ];
  const minDay = shiftDayKey(dayKey, -1);
  const maxDay = shiftDayKey(dayKey, 1);
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
        files.push(fullPath);
      }
    }
  }

  return files;
}

async function extractCompletionText(file, dayKey) {
  const lines = [];
  const rl = readline.createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.includes('"task_complete"')) continue;
    const obj = safeJsonParse(line);
    if (obj?.type !== 'event_msg') continue;
    if (localDayKey(new Date(obj.timestamp)) !== dayKey) continue;
    const message = obj.payload?.last_agent_message;
    if (message) lines.push(cleanText(message));
  }

  return lines;
}

function cleanText(value) {
  return String(value)
    .replace(/\[[^\]]+\]\([^)]+\)/g, ' ')
    .replace(/`[^`]+`/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveCodexHome(explicitHome) {
  const raw = explicitHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  return resolvePath(raw);
}

function resolvePath(raw) {
  if (raw.startsWith('~')) return path.join(os.homedir(), raw.slice(1));
  return raw;
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
