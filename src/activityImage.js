import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

export const ACTIVITY_IMAGE_WIDTH = 1600;
export const ACTIVITY_IMAGE_HEIGHT = 900;

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDir, '..');
const DEFAULT_PET_PATH = path.join(projectRoot, 'assets', 'codex-pet.png');

export async function renderAgentActivityImage(activity, usageEntry, options = {}) {
  const outputPath = path.resolve(options.output ?? 'outputs/agent-screen-time.png');
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const base = sharp(Buffer.from(makeAgentActivitySvg(activity, usageEntry, options)));
  const pet = await sharp(path.resolve(options.pet ?? DEFAULT_PET_PATH))
    .resize({ height: 190, kernel: sharp.kernel.nearest })
    .png()
    .toBuffer();

  await base
    .composite([{ input: pet, left: 1360, top: 548 }])
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(outputPath);

  return outputPath;
}

export function makeAgentActivitySvg(activity, usageEntry = {}, options = {}) {
  const metrics = activity.metrics ?? {};
  const peak = metrics.peakConcurrency ?? 0;
  const agentMinutes = metrics.agentMinutes ?? 0;
  const coverageMinutes = metrics.coverageMinutes ?? 0;
  const dayLabel = formatDay(activity.dayKey);
  const cost = usageEntry.totalCost;
  const tokens = usageEntry.totalTokens ?? 0;
  const turns = usageEntry.turnCount ?? metrics.turnCount ?? 0;
  const chart = { x: 92, baseline: 800, width: 1416, height: 210, top: 590 };
  const visualBuckets = compressBuckets(activity.buckets ?? [], 5);
  const linePath = activityLinePath(visualBuckets, peak, chart);
  const areaPath = activityAreaPath(visualBuckets, peak, chart);
  const peakAccent = activityPeakAccent(visualBuckets, peak, chart);
  const spend = cost == null ? 'n/a' : formatMoney(cost);
  const agentHours = formatDecimalHours(agentMinutes);
  const tokenBurn = formatCompactNumber(tokens);
  const proof = [
    `${formatInteger(turns)} turns`,
    `${formatWorkDays(agentMinutes)} dev-days`,
    `${formatDuration(coverageMinutes)} active window`,
    `peak ${formatInteger(peak)}`,
  ].join(' / ');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${ACTIVITY_IMAGE_WIDTH}" height="${ACTIVITY_IMAGE_HEIGHT}" viewBox="0 0 ${ACTIVITY_IMAGE_WIDTH} ${ACTIVITY_IMAGE_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <pattern id="grid" width="96" height="96" patternUnits="userSpaceOnUse">
      <path d="M 96 0 L 0 0 0 96" fill="none" stroke="#ffffff" stroke-opacity="0.018" stroke-width="1"/>
    </pattern>
    <linearGradient id="activityFade" x1="0" y1="${chart.top}" x2="0" y2="${chart.baseline}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.28"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0.02"/>
    </linearGradient>
    <style>
      .type { font-family: "DM Sans", ui-sans-serif, sans-serif; letter-spacing: 0; }
      .display { font-size: 160px; }
      .text { font-size: 26px; }
      .muted { fill: #9a9a9a; font-weight: 760; }
      .heroNumber { fill: #ffffff; font-weight: 1000; paint-order: stroke fill; stroke: #ffffff; stroke-width: 2.4px; }
      .small { fill: #a3a3a3; font-weight: 650; }
      .statValue { fill: #f5f5f5; font-weight: 900; }
    </style>
  </defs>
  <rect width="${ACTIVITY_IMAGE_WIDTH}" height="${ACTIVITY_IMAGE_HEIGHT}" fill="#080808"/>
  <rect width="${ACTIVITY_IMAGE_WIDTH}" height="${ACTIVITY_IMAGE_HEIGHT}" fill="url(#grid)"/>
  <rect x="0" y="0" width="1600" height="900" fill="#050505" opacity="0.74"/>
  <line x1="92" y1="64" x2="1508" y2="64" stroke="#ffffff" stroke-opacity="0.18" stroke-width="1.5"/>
  <line x1="92" y1="830" x2="1508" y2="830" stroke="#ffffff" stroke-opacity="0.18" stroke-width="1.5"/>
  <g transform="translate(92 86)">
    <text class="type text muted" x="0" y="0">${escapeXml(dayLabel)}</text>
    <text class="type display heroNumber" x="0" y="190">${escapeXml(tokenBurn.toUpperCase())}</text>
    <text class="type display heroNumber" x="548" y="190">${escapeXml(agentHours.toUpperCase())}</text>
    <text class="type display heroNumber" x="1052" y="190">${escapeXml(spend.toUpperCase())}</text>
    <text class="type text statValue" x="0" y="250">TOKENS BURNED</text>
    <text class="type text statValue" x="548" y="250">AGENT HOURS</text>
    <text class="type text statValue" x="1052" y="250">API-EQUIV SPEND</text>
  </g>
  <g transform="translate(92 454)">
    <text class="type text statValue" x="0" y="0">${escapeXml(proof.toUpperCase())}</text>
  </g>
  ${workerLogoSvg(1230, 596, 236)}
  <line x1="${chart.x}" y1="${chart.baseline}" x2="${chart.x + chart.width}" y2="${chart.baseline}" stroke="#ffffff" stroke-opacity="0.16" stroke-width="2"/>
  <path d="${areaPath}" fill="url(#activityFade)"/>
  <path d="${linePath}" fill="none" stroke="#ffffff" stroke-width="24" stroke-linecap="round" stroke-linejoin="round" opacity="0.06"/>
  <path d="${linePath}" fill="none" stroke="#ffffff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" opacity="0.98"/>
  ${peakAccent}
</svg>`;
}

function workerLogoSvg(x, y, size = 104) {
  const scale = size / 104;
  return `<g transform="translate(${x} ${y}) scale(${round(scale)})">
    <rect x="0" y="0" width="104" height="104" rx="22" fill="#f5f5f5"/>
    <path d="M0 104 L104 0 V104 Z" fill="#d8d8d8" opacity="0.45"/>
    <rect x="8" y="8" width="88" height="88" rx="16" fill="#080808"/>
    <path d="M23 31 L36 73 L49 44 L62 73 L81 31" fill="none" stroke="#f5f5f5" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M22 82 H82" stroke="#f5f5f5" stroke-opacity="0.22" stroke-width="4" stroke-linecap="round"/>
  </g>`;
}

function compressBuckets(buckets, bucketSpan) {
  if (!buckets.length || bucketSpan <= 1) return buckets;
  const compressed = [];
  for (let index = 0; index < buckets.length; index += bucketSpan) {
    const group = buckets.slice(index, index + bucketSpan);
    compressed.push({
      ...group[0],
      count: Math.max(...group.map((bucket) => bucket.count ?? 0)),
    });
  }
  return compressed;
}

function activityLinePath(buckets, peak, chart) {
  if (!buckets.length || peak <= 0) return `M ${chart.x} ${chart.baseline}`;

  return buckets.map((bucket, index) => {
    const x = chart.x + (index / Math.max(1, buckets.length - 1)) * chart.width;
    const smoothed = smoothCount(buckets, index) / peak;
    const y = chart.baseline - (smoothed * chart.height);
    return `${index === 0 ? 'M' : 'L'} ${round(x)} ${round(y)}`;
  }).join(' ');
}

function activityAreaPath(buckets, peak, chart) {
  const line = activityLinePath(buckets, peak, chart);
  if (!buckets.length || peak <= 0) return `M ${chart.x} ${chart.baseline} L ${chart.x + chart.width} ${chart.baseline} Z`;
  return `${line} L ${chart.x + chart.width} ${chart.baseline} L ${chart.x} ${chart.baseline} Z`;
}

function activityPeakAccent(buckets, peak, chart) {
  if (!buckets.length || peak <= 0) return '';
  const index = buckets.findIndex((bucket) => bucket.count === peak);
  if (index < 0) return '';
  const x = chart.x + (index / Math.max(1, buckets.length - 1)) * chart.width;
  const y = chart.baseline - chart.height;

  return `<g>
    <line x1="${round(x)}" y1="${round(chart.top - 24)}" x2="${round(x)}" y2="${round(chart.baseline)}" stroke="#ffffff" stroke-opacity="0.2" stroke-width="2"/>
    <circle cx="${round(x)}" cy="${round(y)}" r="10" fill="#ffffff" opacity="0.96"/>
    <circle cx="${round(x)}" cy="${round(y)}" r="24" fill="none" stroke="#ffffff" stroke-opacity="0.18" stroke-width="4"/>
  </g>`;
}

function smoothCount(buckets, index) {
  let total = 0;
  let weight = 0;
  for (let offset = -2; offset <= 2; offset += 1) {
    const bucket = buckets[index + offset];
    if (!bucket) continue;
    const w = 3 - Math.abs(offset);
    total += bucket.count * w;
    weight += w;
  }
  return weight ? total / weight : 0;
}

function formatDay(dayKey) {
  if (!dayKey) return 'unknown day';
  const [year, month, day] = dayKey.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(year, month - 1, day));
}

function formatDuration(minutes) {
  const safe = Math.max(0, Number(minutes) || 0);
  if (safe >= 60) {
    return `${trimNumber(safe / 60, safe >= 600 ? 0 : 1)}h`;
  }
  return `${trimNumber(safe, 0)}m`;
}

function formatHoursMinutes(minutes) {
  const safe = Math.max(0, Math.round(Number(minutes) || 0));
  const hours = Math.floor(safe / 60);
  const remainder = safe % 60;
  if (hours <= 0) return `${remainder}m`;
  if (remainder === 0) return `${hours}h`;
  return `${hours}h ${remainder}m`;
}

function formatDecimalHours(minutes) {
  const safe = Math.max(0, Number(minutes) || 0);
  return `${trimNumber(safe / 60, 1)}h`;
}

function formatWorkDays(minutes) {
  const safe = Math.max(0, Number(minutes) || 0);
  return trimNumber(safe / 60 / 8, 1);
}

function formatMoney(value) {
  const safe = Number(value) || 0;
  if (safe >= 1000) return `$${trimNumber(safe / 1000, safe >= 10_000 ? 0 : 1)}K`;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: safe >= 100 ? 0 : 2,
  }).format(safe);
}

function formatCompactNumber(value) {
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(Number(value) || 0);
}

function formatInteger(value) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number(value) || 0);
}

function trimNumber(value, digits) {
  return Number(value).toFixed(digits).replace(/\.0$/, '');
}

function round(value) {
  return Number(value).toFixed(2);
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
