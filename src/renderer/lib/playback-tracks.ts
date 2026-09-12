import Hls, { type MediaPlaylist } from 'hls.js';
import type { ResolvedStream } from '@shared/types';
import { chooseTracks, DEFAULT_PLAYBACK, type CaptionCue, type PlaybackPreferences, type TrackState, type MediaTrack } from '@shared/tracks';

export interface TrackPlaybackOptions {
  startAt?: number;
  preferences?: PlaybackPreferences;
  onTracks?: (state: TrackState) => void;
  onClock?: (stream: ResolvedStream, offset: number) => void;
  onError?: (message: string) => void;
  onRecovering?: () => void;
  onUnsupported?: () => void;
  onHls?: (hls: Hls) => void;
}
interface Memory {
  url: string; audioLanguage?: string; subtitleLanguage?: string; audioId?: string; subtitleId?: string | null; delay: number;
  local?: { name: string; cues: CaptionCue[] }; localSelected?: boolean;
}
let memory: Memory | undefined;
export function resetPlaybackMemory(): void { memory = undefined; }
let nextGeneration = 0;
const ownedTracks = new WeakMap<HTMLVideoElement, TextTrack>();
type EngineAttach = (video: HTMLVideoElement, stream: ResolvedStream, opts: TrackPlaybackOptions) => () => void;
const hlsId = (kind: string, t: MediaPlaylist) => `${kind}:${t.groupId ?? ''}:${t.name}:${t.lang ?? ''}`;

export class TrackPlayback {
  state: TrackState;
  effective: ResolvedStream;
  offset = 0;
  private generation = 0;
  private disposed = false;
  private detachEngine?: () => void;
  private hls?: Hls;
  private cues: CaptionCue[] = [];
  private captionTrack: TextTrack;
  private stopEvents: (() => void)[] = [];
  private memo: Memory;
  private ccTracks: MediaTrack[] = [];
  private hlsCues = new Map<string, CaptionCue[]>();
  private cancelledLoad?: () => void;
  private prefs: PlaybackPreferences;
  private localHls = false;
  private changing = false;
  private transitionPosition = 0;
  private transitionPaused = false;
  private delayTimer?: ReturnType<typeof setTimeout>;
  private pendingSelection?: { kind: 'audio' | 'subtitle'; previous: Memory; previousId?: string; timer: ReturnType<typeof setTimeout> };

  constructor(private video: HTMLVideoElement, private original: ResolvedStream, private options: TrackPlaybackOptions, private attach: EngineAttach) {
    if (!memory || memory.url !== original.directUrl) memory = { url: original.directUrl, delay: 0 };
    this.memo = memory;
    this.effective = original;
    this.prefs = options.preferences ?? DEFAULT_PLAYBACK;
    this.state = { sessionId: original.sessionId ?? '', generation: 0, tracks: [], status: 'discovering' };
    this.captionTrack = ownedTracks.get(video) ?? video.addTextTrack('captions', 'XiPTV captions');
    ownedTracks.set(video, this.captionTrack);
    this.captionTrack.mode = 'disabled';
    this.stopEvents.push(window.iptv.on('player-cues', event => {
      if (!this.valid(event.generation) || event.sessionId !== this.original.sessionId) return;
      if (event.reset) this.clearCues();
      if (!this.memo.localSelected) this.addCues(event.cues);
    }));
    let renderedAt = -Infinity;
    const prune = () => {
      if (Math.abs(video.currentTime - renderedAt) < 5) return;
      renderedAt = video.currentTime;
      if (!this.memo.localSelected) this.cues = this.cues.filter(c => c.end >= video.currentTime - 60);
      this.renderCues();
    };
    video.addEventListener('timeupdate', prune);
    this.stopEvents.push(() => video.removeEventListener('timeupdate', prune));
  }
  private valid(generation: number): boolean { return !this.disposed && generation === this.generation; }
  private emit(patch: Partial<TrackState> = {}): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    if (this.memo.local) this.state.tracks = [...this.state.tracks.filter(t => t.id !== 'local'), {
      id: 'local', kind: 'subtitle', label: this.memo.local.name, codec: 'webvtt', default: false, forced: false, roles: [], supported: true,
    }];
    this.options.onTracks?.(this.state);
  }
  async start(): Promise<void> { await this.restart(this.options.startAt ?? 0, false); }
  private clearCues(): void { this.cues = []; this.renderCues(); }
  private addCues(cues: CaptionCue[]): void {
    const existing = new Set(this.cues.map(c => `${c.start}/${c.end}/${c.text}`));
    this.cues.push(...cues.filter(c => !existing.has(`${c.start}/${c.end}/${c.text}`)));
    // Retain the upcoming window and prune elapsed captions rather than dropping early captions
    // when a short VOD is delivered faster than playback.
    if (this.cues.length > 100_000) this.cues = this.cues.filter(c => c.end >= this.video.currentTime - 60).slice(0, 100_000);
    this.renderCues();
  }
  private renderCues(): void {
    const track = this.captionTrack;
    // Disabled tracks expose a null cue list. Hidden keeps it accessible for removal while
    // clearing the previous rendered caption, including when playback is paused.
    track.mode = 'hidden';
    while (track.cues?.length) track.removeCue(track.cues[0]);
    const visibleWindow = this.cues.filter(c => c.end + this.memo.delay >= this.video.currentTime - 10 && c.start + this.memo.delay <= this.video.currentTime + 120).slice(0, 4000);
    for (const cue of visibleWindow) {
      const start = Math.max(0, cue.start + this.memo.delay), end = cue.end + this.memo.delay;
      if (end > start) {
        const rendered = new VTTCue(start, end, cue.text);
        rendered.line = -7; // Keep captions above the custom transport controls and their gradient.
        track.addCue(rendered);
      }
    }
    track.mode = this.state.subtitleId || this.memo.localSelected ? 'showing' : 'disabled';
    // Chromium leaves a cue starting at zero inactive after loading a new source while paused.
    // A buffered one-millisecond seek runs its cue activation step without starting playback.
    if (track.mode === 'showing' && this.video.paused && !this.video.seeking && this.video.readyState >= 2 && this.video.currentTime === 0
      && visibleWindow.some(c => c.start + this.memo.delay <= 0 && c.end + this.memo.delay > 0)) {
      this.video.currentTime = 0.001;
    }
  }
  private importLocalCues(): void {
    if (!this.memo.localSelected || !this.memo.local) return;
    this.clearCues();
    this.addCues(this.memo.local.cues.map(c => ({ ...c, start: c.start - this.offset, end: c.end - this.offset })).filter(c => c.end > 0));
  }
  private async restart(position: number, paused: boolean, retry = false, rollback = false): Promise<void> {
    const generation = ++nextGeneration;
    this.generation = generation;
    this.cancelledLoad?.();
    this.changing = true;
    this.transitionPosition = position; this.transitionPaused = paused;
    this.emit({ generation, switching: true, error: undefined });
    this.clearPendingSelection();
    this.detachEngine?.(); this.detachEngine = undefined; this.hls = undefined;
    this.clearCues(); this.ccTracks = []; this.hlsCues.clear();
    this.options.onRecovering?.();
    try {
      let effective = this.original;
      const remoteHls = this.original.engine === 'hls' && !this.original.localHls;
      if (this.original.sessionId) {
        const prepared = await window.iptv.player.prepareTracks({
          sessionId: this.original.sessionId, generation, offset: position, captionDelay: this.memo.delay, retry,
          audioId: !remoteHls && this.memo.audioId?.startsWith('stream:') ? this.memo.audioId : undefined,
          audioLanguage: this.memo.audioId && !this.memo.audioId.startsWith('stream:') ? this.memo.audioLanguage : undefined,
          subtitleLanguage: this.memo.subtitleId && !this.memo.subtitleId.startsWith('stream:') ? this.memo.subtitleLanguage : undefined,
          subtitleId: remoteHls || this.memo.localSelected || this.memo.subtitleId === null ? null : this.memo.subtitleId?.startsWith('stream:') ? this.memo.subtitleId : undefined,
        });
        if (!this.valid(generation)) return;
        effective = { ...this.original, url: prepared.url, engine: prepared.engine, localHls: prepared.localHls, duration: prepared.duration ?? this.original.duration };
        this.localHls = prepared.localHls;
        this.emit({ ...prepared.state, switching: true });
      }
      if (!this.valid(generation)) return;
      this.effective = effective;
      const piped = effective.engine === 'remux' || effective.engine === 'transcode' || effective.localHls;
      this.offset = piped ? position : 0;
      this.options.onClock?.(effective, this.offset);
      this.memo.localSelected && this.emit({ subtitleId: 'local' });
      this.importLocalCues();
      const ready = new Promise<void>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timeout); this.video.removeEventListener('canplay', loaded); this.video.removeEventListener('error', failed); };
        const loaded = () => { cleanup(); resolve(); };
        const failed = () => { cleanup(); reject(new Error('The selected track could not be played.')); };
        const timeout = setTimeout(() => { cleanup(); reject(new Error('Playback did not become ready.')); }, 45_000);
        this.cancelledLoad = () => { cleanup(); resolve(); };
        this.video.addEventListener('canplay', loaded, { once: true });
        this.video.addEventListener('error', failed, { once: true });
        const fail = (message: string) => { cleanup(); reject(new Error(message)); };
        this.detachEngine = this.attach(this.video, effective, {
          ...this.options, startAt: position,
          onHls: hls => this.wireHls(hls, generation),
          onError: message => { if (!this.valid(generation)) return; if (this.pendingSelection) { this.failHlsSelection(message); return; } if (this.changing) fail(message); else this.options.onError?.(message); },
          onUnsupported: () => { if (!this.valid(generation)) return; if (this.pendingSelection) { this.failHlsSelection('The selected track could not be decoded.'); return; } fail('This track needs video conversion.'); if (!rollback) this.options.onUnsupported?.(); },
        });
        if (!piped && position > 0 && effective.kind !== 'live') {
          const seek = () => { if (this.valid(generation)) this.video.currentTime = position; };
          this.video.addEventListener('loadedmetadata', seek, { once: true });
          this.stopEvents.push(() => this.video.removeEventListener('loadedmetadata', seek));
        }
        if (!paused) void this.video.play().catch(() => undefined);
      });
      await ready;
      if (!this.valid(generation)) return;
      this.changing = false;
      if (paused) this.video.pause();
      this.emit({ switching: false });
      this.renderCues();
    } catch (err) {
      if (!this.valid(generation)) return;
      this.changing = false;
      this.emit({ switching: false, error: err instanceof Error ? err.message : 'Track selection failed.' });
      if (rollback) throw err;
      this.options.onError?.(err instanceof Error ? err.message : 'Playback failed.');
    }
  }
  private wireHls(hls: Hls, generation: number): void {
    this.hls = hls;
    const mediaTrack = (t: MediaPlaylist, kind: 'audio' | 'subtitle'): MediaTrack => ({
      id: hlsId(kind, t), kind, language: t.lang, label: t.name || t.lang || kind,
      codec: kind === 'subtitle' ? t.textCodec || 'webvtt' : t.audioCodec,
      default: !!t.default, forced: !!t.forced,
      roles: t.characteristics?.split(',').filter(Boolean) ?? [], supported: true,
    });
    const refresh = () => {
      if (!this.valid(generation)) return;
      const backend = this.state.tracks.filter(t => t.id.startsWith('stream:'));
      const tracks = [...backend, ...(!this.localHls ? hls.audioTracks.map(t => mediaTrack(t, 'audio')) : []), ...hls.subtitleTracks.map(t => mediaTrack(t, 'subtitle')), ...this.ccTracks];
      const defaults = chooseTracks(tracks, this.prefs);
      const audioId = tracks.some(t => t.id === this.memo.audioId) ? this.memo.audioId : this.localHls ? this.state.audioId : defaults.audioId;
      const subtitleId = this.memo.localSelected ? 'local' : this.memo.subtitleId === null ? undefined : tracks.some(t => t.id === this.memo.subtitleId) ? this.memo.subtitleId! : this.localHls && this.state.subtitleId?.startsWith('stream:') ? this.state.subtitleId : defaults.subtitleId;
      this.emit({ tracks, audioId, subtitleId, status: 'ready' });
      const audio = hls.audioTracks.findIndex(t => hlsId('audio', t) === audioId);
      if (audio >= 0 && hls.audioTrack !== audio) hls.audioTrack = audio;
      const sub = hls.subtitleTracks.findIndex(t => hlsId('subtitle', t) === subtitleId);
      if (hls.subtitleTrack !== sub) hls.subtitleTrack = sub;
      hls.subtitleDisplay = sub >= 0;
      this.renderCues();
    };
    hls.on(Hls.Events.MANIFEST_LOADED, (_, data) => {
      if (!this.valid(generation)) return;
      for (const caption of data.captions ?? []) {
        const service = caption.instreamId ?? '';
        const digital = service.startsWith('SERVICE');
        const n = /(?:CC|SERVICE)([1-4])$/.exec(service)?.[1];
        const id = `cc:${n ? `textTrack${n}` : service}`;
        this.ccTracks = [...this.ccTracks.filter(t => t.id !== id), {
          id, kind: 'subtitle', language: caption.lang, label: caption.name || service,
          codec: digital ? 'cea708' : 'cea608', default: !!caption.default, forced: false, roles: ['CC'],
          supported: !digital, reason: digital ? 'CEA-708-only captions are not supported yet.' : undefined,
        }];
      }
      refresh();
    });
    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, refresh);
    hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, refresh);
    hls.on(Hls.Events.MANIFEST_PARSED, refresh);
    hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_, data) => {
      if (!this.valid(generation) || this.localHls) return;
      const track = hls.audioTracks[data.id];
      if (track) {
        if (this.pendingSelection?.kind === 'audio' && hlsId('audio', track) !== this.memo.audioId) return;
        if (this.pendingSelection?.kind === 'audio') this.clearPendingSelection();
        this.emit({ audioId: hlsId('audio', track), switching: false });
      }
    });
    hls.on(Hls.Events.NON_NATIVE_TEXT_TRACKS_FOUND, (_, data) => {
      if (!this.valid(generation)) return;
      for (const t of data.tracks) {
        if (t.kind !== 'captions' || !t._id) continue;
        const digital = /^SERVICE/.test(t.closedCaptions?.instreamId ?? '');
        const track: MediaTrack = { id: `cc:${t._id}`, kind: 'subtitle', label: t.label, language: t.closedCaptions?.lang,
          codec: digital ? 'cea708' : 'cea608', default: t.default, forced: false, roles: ['CC'],
          supported: !digital, reason: digital ? 'CEA-708-only captions are not supported yet.' : undefined };
        this.ccTracks = [...this.ccTracks.filter(c => c.id !== track.id), track];
      }
      refresh();
    });
    hls.on(Hls.Events.SUBTITLE_TRACK_LOADED, (_, data) => {
      if (this.valid(generation) && data.id === hls.subtitleTrack && this.pendingSelection?.kind === 'subtitle') { this.clearPendingSelection(); this.emit({ switching: false }); }
    });
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (!this.valid(generation) || !this.pendingSelection) return;
      if (data.fatal || data.details.toLowerCase().includes(this.pendingSelection.kind)) this.failHlsSelection('That track could not be loaded.');
    });
    hls.on(Hls.Events.CUES_PARSED, (_, data) => {
      if (!this.valid(generation)) return;
      const id = data.type === 'captions' ? `cc:${data.track}` : data.subtitleTrack ? hlsId('subtitle', data.subtitleTrack) : undefined;
      if (!id) return;
      const cues = Array.from(data.cues as VTTCue[]).map(c => ({ start: c.startTime, end: c.endTime, text: c.text }));
      const cached = [...(this.hlsCues.get(id) ?? []), ...cues].filter(c => c.end > this.video.currentTime - 60).slice(-4000);
      this.hlsCues.set(id, cached);
      if (id === this.state.subtitleId && !this.memo.localSelected) {
        if (this.pendingSelection?.kind === 'subtitle') { this.clearPendingSelection(); this.emit({ switching: false }); }
        this.addCues(cues);
      }
    });
  }
  async select(kind: 'audio' | 'subtitle', id?: string): Promise<void> {
    if (this.disposed) return;
    const selected = id ? this.state.tracks.find(t => t.id === id && t.kind === kind) : undefined;
    if (id && (!selected || !selected.supported)) return;
    this.clearPendingSelection();
    const previous = { ...this.memo };
    const previousId = kind === 'audio' ? this.state.audioId : this.state.subtitleId;
    const position = this.changing ? this.transitionPosition : this.position();
    const paused = this.changing ? this.transitionPaused : this.video.paused;
    if (kind === 'audio') { this.memo.audioId = id; this.memo.audioLanguage = selected?.language; }
    else { this.memo.subtitleLanguage = selected?.language; this.memo.subtitleId = id === 'local' ? null : id ?? null; this.memo.localSelected = id === 'local'; }
    const oldEmbedded = this.state.subtitleId?.startsWith('stream:');
    const mustRestart = id?.startsWith('stream:') || (kind === 'subtitle' && oldEmbedded) || (!this.hls && kind === 'audio');
    if (!mustRestart) {
      if (kind === 'audio' && this.hls) {
        const t = this.hls.audioTracks.find(t => hlsId('audio', t) === id);
        if (t) { this.pendingSelection = { kind, previous, previousId, timer: setTimeout(() => this.failHlsSelection('Audio switching timed out.'), 15_000) }; this.emit({ switching: true, error: undefined }); this.hls.setAudioOption(t); }
      } else {
        this.clearCues();
        this.emit({ subtitleId: id });
        if (this.hls) {
          const sub = this.hls.subtitleTracks.findIndex(t => hlsId('subtitle', t) === id);
          if (sub >= 0) { this.pendingSelection = { kind, previous, previousId, timer: setTimeout(() => this.failHlsSelection('Caption loading timed out.'), 15_000) }; this.emit({ switching: true, error: undefined }); }
          this.hls.subtitleTrack = sub; this.hls.subtitleDisplay = sub >= 0;
        }
        if (id) this.addCues(this.hlsCues.get(id) ?? []);
        this.importLocalCues(); this.renderCues();
      }
      return;
    }
    try { await this.restart(this.original.kind === 'live' && !this.options.startAt ? 0 : position, paused, false, true); }
    catch {
      if (this.disposed) return;
      this.memo.audioId = previous.audioId; this.memo.subtitleId = previous.subtitleId; this.memo.localSelected = previous.localSelected; this.memo.delay = previous.delay; this.memo.audioLanguage = previous.audioLanguage; this.memo.subtitleLanguage = previous.subtitleLanguage;
      await this.restart(position, paused);
      this.emit({ error: 'That track could not be played. The previous selection was restored.' });
    }
  }
  private clearPendingSelection(): void {
    if (this.pendingSelection) clearTimeout(this.pendingSelection.timer);
    this.pendingSelection = undefined;
  }
  private failHlsSelection(message: string): void {
    const pending = this.pendingSelection;
    if (!pending || this.disposed) return;
    this.clearPendingSelection();
    this.memo.audioLanguage = pending.previous.audioLanguage; this.memo.subtitleLanguage = pending.previous.subtitleLanguage;
    this.memo.audioId = pending.previous.audioId;
    this.memo.subtitleId = pending.previous.subtitleId;
    this.memo.localSelected = pending.previous.localSelected;
    if (pending.kind === 'audio') {
      const audio = this.hls?.audioTracks.find(t => hlsId('audio', t) === pending.previousId);
      if (audio) this.hls?.setAudioOption(audio);
      this.emit({ audioId: pending.previousId });
    } else {
      if (this.hls) { this.hls.subtitleTrack = this.hls.subtitleTracks.findIndex(t => hlsId('subtitle', t) === pending.previousId); this.hls.subtitleDisplay = this.hls.subtitleTrack >= 0; }
      this.emit({ subtitleId: pending.previousId });
      this.clearCues(); if (pending.previousId) this.addCues(this.hlsCues.get(pending.previousId) ?? []);
      this.importLocalCues();
    }
    this.hls?.startLoad();
    this.emit({ switching: false, error: `${message} The previous selection was restored.` });
  }
  position(): number { return this.offset + this.video.currentTime; }
  seek(seconds: number): void {
    if (this.effective.engine === 'remux' || this.effective.engine === 'transcode' || this.effective.localHls) void this.restart(seconds, this.changing ? this.transitionPaused : this.video.paused);
    else this.video.currentTime = seconds;
  }
  get delay(): number { return this.memo.delay; }
  async setDelay(seconds: number): Promise<void> {
    if (!Number.isFinite(seconds)) return;
    this.memo.delay = Math.max(-10, Math.min(10, seconds));
    const selected = this.state.tracks.find(t => t.id === this.state.subtitleId);
    if (selected?.image) {
      clearTimeout(this.delayTimer);
      this.delayTimer = setTimeout(() => { if (!this.disposed) void this.restart(this.original.kind === 'live' ? 0 : this.position(), this.video.paused); }, 250);
    }
    else this.renderCues();
  }
  async importSubtitles(): Promise<void> {
    try {
      const file = await window.iptv.player.importSubtitles();
      if (!file || this.disposed) return;
      this.memo.local = file;
      this.emit();
      await this.select('subtitle', 'local');
    } catch (error) { this.emit({ error: error instanceof Error ? error.message : 'Could not load subtitles.' }); }
  }
  async retry(): Promise<void> { await this.restart(this.position(), this.video.paused, true); }
  dispose(): void {
    this.disposed = true; this.clearPendingSelection(); clearTimeout(this.delayTimer); this.cancelledLoad?.(); this.detachEngine?.();
    for (const stop of this.stopEvents) stop();
    this.clearCues(); this.captionTrack.mode = 'disabled';
    if (this.original.sessionId) void window.iptv.player.cancelTracks(this.original.sessionId, this.generation).catch(() => undefined);
  }
}
