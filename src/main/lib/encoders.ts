/**
 * Chromium ships no HEVC decoder on Linux and no MPEG-2/AC-3 audio anywhere, so a channel carrying
 * any of those is unplayable in a <video> element no matter which MSE library feeds it. The only
 * fix is to re-encode into H.264 + AAC on the way through.
 *
 * An encoder listed by `ffmpeg -encoders` is COMPILED IN, not usable. A build with NVENC on a
 * machine with no NVIDIA driver still lists h264_nvenc, and only fails when it runs. So the ladder
 * validates every candidate by encoding a few frames before trusting it.
 */

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';

const VALIDATION_FRAMES = 6;
const VALIDATION_TIMEOUT_MS = 8_000;
const CAPABILITY_TIMEOUT_MS = 8_000;

export interface TranscodeProfile {
  id: string;
  label: string;
  software: boolean;
  /** Args placed before `-i`. Hardware decode and device selection live here. */
  inputArgs: string[];
  /** Args placed after `-i` that select and tune the video encoder. */
  videoArgs: string[];
}

interface Candidate extends TranscodeProfile {
  encoder: string;
  platforms?: NodeJS.Platform[];
  resolveDevice?: () => string[] | null;
}

/**
 * Fragmented MP4 cuts a fragment per keyframe, and the renderer cannot start playing until it has
 * one, so a long GOP shows up as startup latency. ~2s at 25-60fps.
 */
const GOP = ['-g', '100', '-keyint_min', '100'];

/**
 * Options are kept to ones NVENC has supported since Maxwell. Anything newer (temporal AQ,
 * b_ref_mode) risks failing validation on an older card and dropping that user all the way to
 * software.
 */
const NVENC = [
  '-preset', 'p5',
  '-tune', 'hq',
  '-profile:v', 'high',
  '-rc', 'vbr',
  '-cq', '23',
  '-b:v', '0',
  // Lookahead is what re-enables adaptive I-frame insertion at scene cuts (`-no-scenecut` is
  // false by default, but only takes effect when lookahead is on).
  '-rc-lookahead', '20',
  '-spatial-aq', '1',
  '-aq-strength', '8',
  '-bf', '3',
];
const CANDIDATES: Candidate[] = [
  {
    id: 'nvenc-gpu',
    label: 'NVIDIA NVENC (GPU decode)',
    software: false,
    encoder: 'h264_nvenc',
    inputArgs: ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'],
    videoArgs: ['-c:v', 'h264_nvenc', ...NVENC, ...GOP],
  },
  {
    id: 'nvenc',
    label: 'NVIDIA NVENC',
    software: false,
    encoder: 'h264_nvenc',
    inputArgs: [],
    videoArgs: ['-c:v', 'h264_nvenc', ...NVENC, ...GOP],
  },
  {
    // Safety net. Both rungs above share one option set, so a card that rejects any part of it
    // rejects both and would otherwise fall past every other vendor's encoder to libx264. This
    // rung asks for nothing beyond baseline NVENC, so hardware encoding survives that.
    id: 'nvenc-basic',
    label: 'NVIDIA NVENC (basic)',
    software: false,
    encoder: 'h264_nvenc',
    inputArgs: [],
    videoArgs: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '23', '-b:v', '0', ...GOP],
  },
  {
    id: 'videotoolbox',
    label: 'Apple VideoToolbox',
    software: false,
    encoder: 'h264_videotoolbox',
    platforms: ['darwin'],
    inputArgs: ['-hwaccel', 'videotoolbox'],
    videoArgs: ['-c:v', 'h264_videotoolbox', '-realtime', '1', '-q:v', '65', ...GOP],
  },
  {
    id: 'qsv',
    label: 'Intel Quick Sync',
    software: false,
    encoder: 'h264_qsv',
    inputArgs: [],
    videoArgs: ['-c:v', 'h264_qsv', '-preset', 'medium', '-global_quality', '23', ...GOP],
  },
  {
    id: 'amf',
    label: 'AMD AMF',
    software: false,
    encoder: 'h264_amf',
    platforms: ['win32'],
    inputArgs: [],
    videoArgs: ['-c:v', 'h264_amf', '-usage', 'transcoding', '-quality', 'balanced', '-rc', 'cqp', '-qp_i', '22', '-qp_p', '24', ...GOP],
  },
  {
    id: 'vaapi',
    label: 'VA-API',
    software: false,
    encoder: 'h264_vaapi',
    platforms: ['linux'],
    inputArgs: [],
    // VAAPI encodes from GPU surfaces only, so software frames have to be uploaded explicitly.
    videoArgs: ['-vf', 'format=nv12,hwupload', '-c:v', 'h264_vaapi', '-qp', '22', ...GOP],
    resolveDevice: () => {
      const node = firstRenderNode();
      return node ? ['-vaapi_device', node] : null;
    },
  },
  {
    id: 'x264',
    label: 'Software (libx264)',
    software: true,
    encoder: 'libx264',
    inputArgs: [],
    videoArgs: ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '21', ...GOP],
  },
];

/** VAAPI needs a concrete render node; the conventional renderD128 is not guaranteed to exist. */
function firstRenderNode(): string | null {
  try {
    const node = readdirSync('/dev/dri').filter((n) => n.startsWith('renderD')).sort()[0];
    return node ? `/dev/dri/${node}` : null;
  } catch {
    return null;
  }
}

function run(bin: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const settle = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, stdout });
    };
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve({ ok: false, stdout: '' });
      return;
    }
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {}
      settle(false);
    }, timeoutMs);
    proc.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 200_000) stdout += chunk.toString();
    });
    proc.on('error', () => settle(false));
    proc.on('close', (code) => settle(code === 0));
  });
}

async function listEncoders(bin: string): Promise<Set<string>> {
  const { ok, stdout } = await run(bin, ['-hide_banner', '-encoders'], CAPABILITY_TIMEOUT_MS);
  if (!ok) return new Set();
  const names = new Set<string>();
  for (const line of stdout.split('\n')) {
    // ` V....D h264_nvenc  NVIDIA NVENC H.264 encoder`
    const match = /^\s*[A-Z.]{6}\s+(\S+)/.exec(line);
    if (match) names.add(match[1]);
  }
  return names;
}

async function validate(bin: string, candidate: Candidate, device: string[]): Promise<boolean> {
  const { ok } = await run(
    bin,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      ...device,
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1280x720:rate=25',
      '-frames:v',
      String(VALIDATION_FRAMES),
      ...candidate.videoArgs,
      '-f',
      'null',
      '-',
    ],
    VALIDATION_TIMEOUT_MS,
  );
  return ok;
}

function toProfile(candidate: Candidate, inputArgs: string[]): TranscodeProfile {
  return {
    id: candidate.id,
    label: candidate.label,
    software: candidate.software,
    inputArgs,
    videoArgs: candidate.videoArgs,
  };
}

let ladder: Promise<TranscodeProfile[]> | null = null;

/**
 * Usable transcode profiles, best first. Always resolves to at least one entry: if even libx264
 * fails validation it is still returned.
 */
export function transcodeLadder(ffmpegPath: string): Promise<TranscodeProfile[]> {
  ladder ??= (async () => {
    const available = await listEncoders(ffmpegPath);
    const usable: TranscodeProfile[] = [];
    const forced = process.env.XIPTV_ENCODER?.trim();

    for (const candidate of CANDIDATES) {
      if (forced && candidate.id !== forced) continue;
      if (candidate.platforms && !candidate.platforms.includes(process.platform)) continue;
      if (!available.has(candidate.encoder)) continue;
      const device = candidate.resolveDevice?.() ?? [];
      if (candidate.resolveDevice && device.length === 0) continue;
      if (!(await validate(ffmpegPath, candidate, device))) continue;
      usable.push(toProfile(candidate, [...device, ...candidate.inputArgs]));
    }

    if (usable.length === 0) {
      const fallback = CANDIDATES[CANDIDATES.length - 1];
      usable.push(toProfile(fallback, fallback.inputArgs));
    }
    return usable;
  })();
  return ladder;
}
