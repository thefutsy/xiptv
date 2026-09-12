<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.png">
    <img src="docs/logo.png" width="320" alt="xiptv">
  </picture>
</p>

<p align="center">
  A beautiful, free IPTV player for Windows, macOS and Linux.
</p>

<p align="center">
  <a href="https://github.com/thefutsy/xiptv/releases">Releases</a> ·
  <a href="https://github.com/thefutsy/xiptv/issues">Issues</a> ·
  <a href="LICENSE">MIT</a>
</p>

![Live TV with now and next on every channel, the guide, the film grid, a series with its episodes, and a channel handed to a Chromecast](docs/demo.gif)

xiptv comes with no channels and no accounts. You bring an Xtream Codes login or an M3U playlist,
and it plays what your provider sends.

## Features

- **Xtream Codes and M3U.** Remote or from a local file, with an optional XMLTV guide.
- **Live TV, Movies and TV Shows**, each using your provider's own categories.
- **A real guide.** Now and next on every channel row, plus a scrollable timeline. Channels your
  provider ships without listings are matched to the guide by name.
- **Better EPG.** Grabs public country guides to cover the channels your provider's EPG doesn't
  have, so you get a much better guide out the box. Tick them on and off in Settings, add any
  XMLTV URL, or pin a channel to a guide entry by hand.
- **Chromecast.** It finds devices on the network and gives you a docked cast bar.
- Favourites, Continue Watching, search, and a command palette on `Ctrl`/`⌘`+`K`.

## Install

Installers for all three platforms are on the
[releases page](https://github.com/thefutsy/xiptv/releases). macOS builds are Apple Silicon only
for now.

None of them are code signed, so each system will object the first time.

**macOS** will say the app is damaged and offer to move it to the Bin. It is not damaged, it just
has no Apple signature. Drag it to Applications, then run:

```bash
xattr -cr /Applications/xiptv.app
```

That clears the quarantine flag macOS adds to anything downloaded from a browser. The app opens
normally from then on.

**Windows** will show a SmartScreen warning. Choose More info, then Run anyway.

On first launch, add a source. An Xtream account needs the server origin (`http://host` or
`http://host:port`, no path), a username and a password. The guide URL is optional and defaults to
`xmltv.php` on the same server.

## Building it

```bash
npm install
npm run dev
```

To build an installer for the machine you are on:

```bash
npm run dist      # or dist:win / dist:mac / dist:linux
```

You get NSIS on Windows, a DMG on macOS, and AppImage + deb on Linux. Pushing a `v*` tag builds
all three on CI and puts them on a release.

## How it works

Most of the design comes from two facts about real IPTV providers: the catalogue is enormous, and
you only get one concurrent connection. As a result, this needs to be handled cleanly.

- **One stream at a time.** Anything that opens a connection closes the previous one and waits for
  it to exit. Providers count refused requests as failed logins.
- **MKV plays through a local remux.** Chromium has no Matroska demuxer, but the streams inside are
  usually H.264 and AAC already, so a local server stream-copies them into fragmented MP4. No
  transcoding, about 0.06s of CPU per 30s of video.
- **MP4 films download ahead.** Chromium's player hangs up on a slow response and asks again every
  few seconds, and a fresh provider connection takes about two seconds to start sending. So a film
  is read over one connection into a temp file, as fast as the provider allows and up to 256 MB
  ahead, and the player is served from that. Seeking back is instant, and only a jump past what has
  downloaded opens a new connection.
- **Chromecast gets its own URL.** Cast devices cannot demux Matroska either, so live channels and
  MKV films are served to them as HLS from that same local server.
- **Search uses a complete local snapshot.** An Xtream refresh reads the provider's full live,
  movie and series lists into the on-disk cache, so search does not depend on which categories you
  have opened. If an older source has no snapshot yet, its first search builds one in the same way.
- **Live connections often drop every 30 to 60 seconds** and the provider replays its buffer from the
  start when you reconnect. The app reconnects itself and throws the repeated packets away, rather
  than letting ffmpeg glue them together and drift the audio. This results in a WAY more stable experience compared to other players
- **A few codecs need a real re-encode.** HEVC on Linux, and MPEG-2 or AC-3 anywhere. The player
  retries through an encoding proxy once and remembers, so it costs one hiccup rather than one per
  play. Encoders are picked by test-encoding six frames, because `ffmpeg -encoders` lists what was
  compiled in, not what the machine can actually do.

## Contributing

Issues and pull requests are welcome. `npm run build` runs the typecheck and the production build,
and CI runs the same thing, so keep it green. There is no linter. Playback and recovery checks are documented below.

Two rules reviews will ask about: close the previous connection before opening another, and never
walk the whole catalogue during a render. Large catalogue reads happen once during source refresh
or first search, then subsequent searches stay local.

## Licence

MIT. See [LICENSE](LICENSE).

### Audio and captions

Open **Audio & captions** in the player to select an audio language or caption track, turn captions
Off, or load a UTF-8 `.srt`/`.vtt` file (up to 10 MB). Settings → Playback stores preferred languages
and the default caption mode. Source audio and captions Off are the initial defaults; Automatic
selects matching forced subtitles. Choices in the player apply to the current playback session.

Text size, white/yellow text, and background opacity are saved automatically. Caption delay runs
from −10 to +10 seconds; positive values display captions later. Delay and imported files reset
for a new title/channel. Track discovery happens before playback and may add startup time. Switching
embedded tracks may briefly restart playback while preserving the movie position and paused state;
ordinary live channels reconnect near the live edge.

Supported captions include HLS WebVTT/IMSC1, CEA-608 through HLS, embedded SRT/SubRip, WebVTT,
ASS/SSA, MP4 timed text, and PGS/DVD/DVB image subtitles. Embedded text is normalized to the player's
appearance; advanced ASS typesetting/animation is not preserved. Image subtitles are drawn into the
video, require video encoding, and keep their original appearance. Their timing changes also restart
playback. Full CEA-708-only decoding and Chromecast track controls are not included. Picture-in-picture
caption display depends on the platform's native text-track support.

Playback checks use generated, original media and a temporary application profile, without contacting
or changing a configured provider:

```sh
npm run build
npm test
npm run test:media
npm run test:player
npm run test:recovery
```

The media tests build the test server bundle used by the player tests. Linux Electron checks require
a display, for example `xvfb-run -a npm run test:player`. CI runs playback checks on macOS, Windows,
and Linux with the FFmpeg build used by packaging.
