#!/usr/bin/env node
/**
 * Vendors a hardware-capable ffmpeg for packaging.
 *
 * Why this exists: `ffmpeg-static` ships a build with libx264 and nothing else. No NVENC, QSV,
 * VAAPI, AMF or VideoToolbox. A channel Chromium cannot decode has to be re-encoded, and on a
 * software-only encoder that costs roughly 4x more CPU:
 *
 *   MEASURED, 1080p50 HEVC -> H.264:  libx264 ultrafast 1.2x realtime | h264_nvenc 4.9x
 *
 * The same ffmpeg-static build also SEGFAULTS on the MPEG-TS demuxer, which is the container every
 * live channel uses, so it cannot feed the transcoder at all. Both problems are properties of that
 * particular build, and both go away with a full-featured one.
 *
 * Pinned to an immutable BtbN autobuild tag, not the mutable `latest`:
 * MEASURED, the `latest` master build's NVENC requires driver 610.00+ and refuses to open on a
 * driver that the n8.1 release build drives happily. Tracking master would silently demote a large
 * share of NVIDIA users to software.
 *
 * Usage:
 *   node scripts/fetch-ffmpeg.mjs            # host platform only
 *   node scripts/fetch-ffmpeg.mjs --all      # every platform, for a release build
 */

import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, chmodSync, renameSync, copyFileSync } from 'node:fs';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TAG = 'autobuild-2026-08-28-17-08';
const VER = 'ffmpeg-n8.1.2-50-g1a748fe2cd';
const BASE = `https://github.com/BtbN/FFmpeg-Builds/releases/download/${TAG}`;

/**
 * sha256 covers the downloaded archive, so a compromised or swapped release asset fails closed
 * rather than being baked into an installer.
 *
 * darwin is absent on purpose: BtbN publishes no macOS build, and vendoring one from a source I
 * could not verify would be worse than the fallback. macOS keeps ffmpeg-static, whose VideoToolbox
 * rung the encoder ladder validates at runtime like any other.
 */
const MANIFEST = {
  'linux-x64': {
    url: `${BASE}/${VER}-linux64-gpl-8.1.tar.xz`,
    sha256: 'af69c6a006cf3768826586362fec3426a25544c69fb3d50a95bda08020d5425c',
    kind: 'tar.xz',
  },
  'linux-arm64': {
    url: `${BASE}/${VER}-linuxarm64-gpl-8.1.tar.xz`,
    sha256: 'a5a40579cfa99b4c025c033cf28332299dd22f6ced9cd8ed4b109fa24a01f977',
    kind: 'tar.xz',
  },
  'win32-x64': {
    url: `${BASE}/${VER}-win64-gpl-8.1.zip`,
    sha256: 'a10afcfce01b34872c49f3d8b0d7755351375a57fcfba27932666692302397a6',
    kind: 'zip',
  },
};

function target(key) {
  return join(ROOT, 'vendor', 'ffmpeg', key, key.startsWith('win32') ? 'ffmpeg.exe' : 'ffmpeg');
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function extract(archive, kind, dir) {
  const out = join(dir, 'unpacked');
  mkdirSync(out, { recursive: true });
  if (kind === 'tar.xz') execFileSync('tar', ['-xJf', archive, '-C', out], { stdio: 'inherit' });
  else execFileSync('unzip', ['-q', archive, '-d', out], { stdio: 'inherit' });
  const binary = kind === 'zip' ? 'ffmpeg.exe' : 'ffmpeg';
  for (const root of await readdir(out)) {
    const exe = join(out, root, 'bin', binary);
    if (existsSync(exe)) return exe;
  }
  throw new Error(`no ffmpeg binary inside ${archive}`);
}

async function fetchOne(key) {
  const entry = MANIFEST[key];
  if (!entry) {
    console.log(`[ffmpeg] ${key}: no vendored build, falling back to ffmpeg-static at runtime`);
    return;
  }
  const dest = target(key);
  if (existsSync(dest)) {
    console.log(`[ffmpeg] ${key}: already vendored`);
    return;
  }
  const work = await mkdtemp(join(tmpdir(), 'xiptv-ffmpeg-'));
  try {
    const archive = join(work, 'archive');
    console.log(`[ffmpeg] ${key}: downloading ${entry.url}`);
    await download(entry.url, archive);
    const got = sha256(archive);
    if (got !== entry.sha256) throw new Error(`checksum mismatch for ${key}\n  expected ${entry.sha256}\n  got      ${got}`);
    const exe = await extract(archive, entry.kind, work);
    mkdirSync(dirname(dest), { recursive: true });
    try {
      renameSync(exe, dest);
    } catch (err) {
      // A rename cannot cross volumes. Windows CI puts the temp directory on C: and the checkout
      // on D:, so it lands here every time; a copy is the only move that works across the two.
      if (err.code !== 'EXDEV') throw err;
      copyFileSync(exe, dest);
    }
    chmodSync(dest, 0o755);
    console.log(`[ffmpeg] ${key}: vendored -> ${dest}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const keys = process.argv.includes('--all')
  ? Object.keys(MANIFEST)
  : [`${process.platform}-${process.arch}`];
for (const key of keys) await fetchOne(key);
