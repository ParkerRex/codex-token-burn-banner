import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { asciiBar } from './codexUsage.js';

export const BANNER_WIDTH = 1500;
export const BANNER_HEIGHT = 500;
export const TWEET_IMAGE_WIDTH = 1600;
export const TWEET_IMAGE_HEIGHT = 900;

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDir, '..');
const DEFAULT_PET_PATH = path.join(projectRoot, 'assets', 'codex-pet.png');

export async function renderBanner(summary, options = {}) {
  const outputPath = path.resolve(options.output ?? 'outputs/codex-token-burn-banner.png');
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const banner = await makeBannerBuffer(summary, options);
  await sharp(banner)
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(outputPath);

  return outputPath;
}

export async function renderTweetImage(summary, options = {}) {
  const outputPath = path.resolve(options.output ?? 'outputs/codex-token-burn-tweet.png');
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const banner = await makeBannerBuffer(summary, options);
  const bannerPreview = await sharp(banner)
    .resize(1400, 467, { fit: 'cover' })
    .png()
    .toBuffer();

  await sharp(Buffer.from(makeTweetImageSvg(summary)))
    .composite([{ input: bannerPreview, left: 100, top: 80 }])
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(outputPath);

  return outputPath;
}

async function makeBannerBuffer(summary, options = {}) {
  const petPath = path.resolve(options.pet ?? DEFAULT_PET_PATH);
  const base = sharp(Buffer.from(makeBannerSvg(summary)));
  const pet = await sharp(petPath)
    .resize({ height: 214, kernel: sharp.kernel.nearest })
    .png()
    .toBuffer();

  return base
    .composite([{ input: pet, left: 84, top: 28 }])
    .png()
    .toBuffer();
}

export function makeBannerSvg(summary) {
  const lines = makeBurnTextLines(summary);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${BANNER_WIDTH}" height="${BANNER_HEIGHT}" viewBox="0 0 ${BANNER_WIDTH} ${BANNER_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="#f9fcff"/>
      <stop offset="52%" stop-color="#eef7ff"/>
      <stop offset="100%" stop-color="#fbfdff"/>
    </linearGradient>
    <pattern id="grid" width="64" height="64" patternUnits="userSpaceOnUse">
      <path d="M 64 0 L 0 0 0 64" fill="none" stroke="#8ec5ff" stroke-opacity="0.22" stroke-width="2"/>
    </pattern>
    <filter id="textLift" x="-10%" y="-20%" width="120%" height="140%">
      <feDropShadow dx="0" dy="2" stdDeviation="1.3" flood-color="#ffffff" flood-opacity="0.8"/>
    </filter>
    <style>
      .mono {
        font-family: "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
        letter-spacing: 0;
      }
      .headline {
        fill: #111827;
        font-size: 43px;
        font-weight: 800;
      }
      .bar {
        fill: #172033;
        font-size: 37px;
        font-weight: 760;
      }
      .note {
        fill: #44546a;
        font-size: 29px;
        font-weight: 650;
      }
    </style>
  </defs>
  <rect width="${BANNER_WIDTH}" height="${BANNER_HEIGHT}" fill="url(#bg)"/>
  <rect width="${BANNER_WIDTH}" height="${BANNER_HEIGHT}" fill="url(#grid)" opacity="0.74"/>
  <g fill="#63a9ff" opacity="0.42">
    <rect x="69" y="145" width="13" height="13"/>
    <rect x="96" y="171" width="13" height="13"/>
    <rect x="122" y="145" width="13" height="13"/>
    <rect x="96" y="119" width="13" height="13"/>
    <rect x="216" y="53" width="13" height="13"/>
    <rect x="242" y="79" width="13" height="13"/>
    <rect x="268" y="53" width="13" height="13"/>
    <rect x="242" y="27" width="13" height="13"/>
    <rect x="1276" y="398" width="14" height="14"/>
    <rect x="1304" y="426" width="14" height="14"/>
    <rect x="1332" y="398" width="14" height="14"/>
    <rect x="1304" y="370" width="14" height="14"/>
    <rect x="1396" y="102" width="16" height="16" opacity="0.35"/>
    <rect x="1438" y="134" width="12" height="12" opacity="0.35"/>
  </g>
  <path d="M451 59 H1334 C1387 59 1427 99 1427 152 V290 C1427 343 1387 383 1334 383 H452 C407 383 374 362 359 327 V228 L272 189 L359 151 C360 99 399 59 451 59 Z"
    fill="#ffffff" fill-opacity="0.88" stroke="#7fa9f5" stroke-width="5"/>
  <path d="M451 76 H1328 C1371 76 1410 108 1410 153 V287 C1410 332 1371 365 1328 365 H456"
    fill="none" stroke="#c7dcff" stroke-width="3" opacity="0.82"/>
  <g filter="url(#textLift)">
    <text x="428" y="172" class="mono headline">${escapeXml(lines[0])}</text>
    <text x="428" y="232" class="mono bar">${escapeXml(lines[1])}</text>
    <text x="428" y="287" class="mono bar">${escapeXml(lines[2])}</text>
    <text x="428" y="347" class="mono note">${escapeXml(lines[3])}</text>
  </g>
</svg>`;
}

export function makeTweetImageSvg(summary) {
  const today = summary.today?.totalTokens ?? 0;
  const yesterday = summary.yesterday?.totalTokens ?? 0;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${TWEET_IMAGE_WIDTH}" height="${TWEET_IMAGE_HEIGHT}" viewBox="0 0 ${TWEET_IMAGE_WIDTH} ${TWEET_IMAGE_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="#f8fbff"/>
      <stop offset="58%" stop-color="#eef6ff"/>
      <stop offset="100%" stop-color="#f7fbff"/>
    </linearGradient>
    <pattern id="grid" width="64" height="64" patternUnits="userSpaceOnUse">
      <path d="M 64 0 L 0 0 0 64" fill="none" stroke="#7bb7ff" stroke-opacity="0.16" stroke-width="2"/>
    </pattern>
    <filter id="shadow" x="-12%" y="-16%" width="124%" height="132%">
      <feDropShadow dx="0" dy="20" stdDeviation="20" flood-color="#3264b7" flood-opacity="0.18"/>
    </filter>
    <style>
      .sans { font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; letter-spacing: 0; }
      .mono { font-family: "SF Mono", Menlo, Consolas, "Liberation Mono", monospace; letter-spacing: 0; }
      .headline { fill: #0f172a; font-size: 78px; font-weight: 860; }
      .sub { fill: #31445f; font-size: 36px; font-weight: 680; }
      .tiny { fill: #5d718e; font-size: 29px; font-weight: 620; }
    </style>
  </defs>
  <rect width="${TWEET_IMAGE_WIDTH}" height="${TWEET_IMAGE_HEIGHT}" fill="url(#bg)"/>
  <rect width="${TWEET_IMAGE_WIDTH}" height="${TWEET_IMAGE_HEIGHT}" fill="url(#grid)"/>
  <circle cx="1490" cy="790" r="145" fill="#9fd0ff" fill-opacity="0.16"/>
  <circle cx="95" cy="790" r="110" fill="#6ba7ff" fill-opacity="0.12"/>
  <rect x="82" y="62" width="1436" height="503" rx="34" fill="#dcecff" fill-opacity="0.72" filter="url(#shadow)"/>
  <text x="100" y="672" class="sans headline">made my X banner track</text>
  <text x="100" y="760" class="sans headline">my daily Codex burn</text>
  <text x="100" y="828" class="mono sub">today ${escapeXml(formatCompactNumber(today))} tokens / yesterday ${escapeXml(formatCompactNumber(yesterday))}</text>
  <text x="1010" y="828" class="sans tiny">local cache-inclusive estimate</text>
</svg>`;
}

export function makeBurnTextLines(summary) {
  const today = summary.today?.totalTokens ?? 0;
  const yesterday = summary.yesterday?.totalTokens ?? 0;
  const max = Math.max(1, summary.maxDailyTokens ?? 0, today, yesterday);
  const headlineDay = today > 0 ? 'today' : 'yesterday';
  const headlineTokens = today > 0 ? today : yesterday;

  return [
    `codex burn ${headlineDay}: ${formatCompactNumber(headlineTokens)} tokens`,
    `TOD ${asciiBar(today, max, 24)}`,
    `YDY ${asciiBar(yesterday, max, 24)}`,
    'local cache-inclusive estimate',
  ];
}

function formatCompactNumber(value) {
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(Number(value) || 0);
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
