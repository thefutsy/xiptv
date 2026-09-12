import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
/** Tiny original PGS display sets: a white rectangle at (40,130), shown at 1s, cleared at 3s. */
export async function createPgsFixture(dir) {
  const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
  const u24 = n => Buffer.from([n >> 16, n >> 8 & 255, n & 255]);
  const segment = (time, type, data) => {
    const header = Buffer.alloc(13); header.write('PG'); header.writeUInt32BE(time * 90000, 2); header.writeUInt32BE(time * 90000, 6); header[10] = type; header.writeUInt16BE(data.length, 11);
    return Buffer.concat([header, data]);
  };
  const pcs = (number, count) => Buffer.concat([u16(320), u16(180), Buffer.from([0x10]), u16(number), Buffer.from([number ? 0 : 0x80, 0, 0, count]), ...(count ? [u16(0), Buffer.from([0, 0]), u16(40), u16(130)] : [])]);
  const rle = Buffer.concat(Array.from({ length: 20 }, () => Buffer.concat([Buffer.alloc(80, 1), Buffer.from([0, 0])])));
  const objects = Buffer.concat([u16(0), Buffer.from([0, 0xc0]), u24(rle.length + 4), u16(80), u16(20), rle]);
  const window = Buffer.concat([Buffer.from([1, 0]), u16(40), u16(130), u16(80), u16(20)]);
  const palette = Buffer.from([0, 0, 0, 16, 128, 128, 0, 1, 235, 128, 128, 255]);
  const bytes = Buffer.concat([segment(1, 0x16, pcs(0, 1)), segment(1, 0x17, window), segment(1, 0x14, palette), segment(1, 0x15, objects), segment(1, 0x80, Buffer.alloc(0)), segment(3, 0x16, pcs(1, 0)), segment(3, 0x80, Buffer.alloc(0))]);
  const path = join(dir, 'image.sup'); await writeFile(path, bytes); return path;
}

export async function createHlsFixture(dir, run, source) {
  const { mkdir } = await import('node:fs/promises');
  const root = join(dir, 'hls'); await mkdir(root, { recursive: true });
  run(['-i', source, '-map', '0:v', '-c', 'copy', '-hls_time', '2', '-hls_list_size', '0', '-hls_segment_filename', join(root, 'v%02d.ts'), join(root, 'video.m3u8')]);
  for (const [name, index] of [['en', 0], ['fr', 1]]) run(['-i', source, '-map', `0:a:${index}`, '-c:a', 'aac', '-hls_time', '2', '-hls_list_size', '0', '-hls_segment_filename', join(root, `${name}%02d.ts`), join(root, `${name}.m3u8`)]);
  await writeFile(join(root, 'sub.vtt'), 'WEBVTT\n\n00:00:00.000 --> 00:00:19.000\nHLS caption\n\n');
  await writeFile(join(root, 'sub.m3u8'), '#EXTM3U\n#EXT-X-TARGETDURATION:20\n#EXT-X-VERSION:3\n#EXTINF:20,\nsub.vtt\n#EXT-X-ENDLIST\n');
  await writeFile(join(root, 'master.m3u8'), '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="en.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="French",LANGUAGE="fr",DEFAULT=NO,AUTOSELECT=YES,URI="fr.m3u8"\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="English",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,URI="sub.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=800000,CODECS="avc1.42c01e,mp4a.40.2",AUDIO="a",SUBTITLES="s"\nvideo.m3u8\n');
  return root;
}

export async function createCea608Fixture(dir, run) {
  const { readFile } = await import('node:fs/promises');
  const raw = join(dir, 'original.h264');
  run(['-f', 'lavfi', '-i', 'color=black:size=640x360:rate=25:duration=20', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-x264-params', 'aud=1', '-f', 'h264', raw]);
  const data = await readFile(raw);
  const units = [];
  const starts = [];
  for (let i = 0; i < data.length - 4; i++) {
    if (data[i] === 0 && data[i+1] === 0 && data[i+2] === 1) { starts.push({ at: i > 0 && data[i-1] === 0 ? i-1 : i, payload: i+3 }); i += 2; }
  }
  const parity = x => { let bits = 0; for (let y = x; y; y >>= 1) bits += y & 1; return x | (bits % 2 ? 0 : 128); };
  const sei = pairs => {
    const payload = Buffer.from([181, 0, 49, 71, 65, 57, 52, 3, 0x40 | pairs.length, 255, ...pairs.flatMap(([a,b]) => [0xfc, parity(a), parity(b)]), 255]);
    return Buffer.concat([Buffer.from([0,0,0,1,6,4,payload.length]), payload, Buffer.from([0x80])]);
  };
  let frame = -1;
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]; const nal = data[start.payload] & 31;
    units.push(data.subarray(start.at, starts[i+1]?.at ?? data.length));
    if (nal === 9) {
      frame++;
      if (frame % 100 === 25) units.push(sei([[0x14,0x20],[0x14,0x2e],[0x48,0x49],[0x14,0x2f]]));
      if (frame % 100 === 75) units.push(sei([[0x14,0x2c]]));
    }
  }
  const cc = join(dir, 'captions.h264'); await writeFile(cc, Buffer.concat(units));
  const out = join(dir, 'captions.ts');
  run(['-fflags', '+genpts', '-r', '25', '-i', cc, '-c:v', 'copy', '-f', 'mpegts', out]);
  return out;
}
