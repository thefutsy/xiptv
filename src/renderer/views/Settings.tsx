import {
  useCallback, useEffect, useRef, useState, useSyncExternalStore,
  type ReactNode,
} from 'react';
import type {
  EpgFeed, EpgFeedStatus, EpgFillSettings, M3uSource, SettingsPatch, Source, SourceKind, SourceProbe,
  SourceStats, SyncProgress, XtreamSource,
} from '@shared/types';
import { useApp } from '@/state/store';
import { Button } from '@/components/Primitives';
import { Glyph, ICON, ProgressBar, Segmented } from '@/components/CommandPalette';
import type { LucideIcon } from 'lucide-react';
import { classNames, errorText } from '@/lib/format';
import './misc.css';

export interface UiPrefs {
  reduceTransparency: boolean;
  hideAdult: boolean;
  collapseDuplicates: boolean;
}

const UI_PREFS_KEY = 'xiptv.ui-prefs';
const UI_PREFS_DEFAULT: UiPrefs = {
  reduceTransparency: false,
  hideAdult: true,
  collapseDuplicates: true,
};

function loadUiPrefs(): UiPrefs {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(UI_PREFS_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object') return UI_PREFS_DEFAULT;
    const raw = parsed as Record<string, unknown>;
    const pick = (k: keyof UiPrefs): boolean => typeof raw[k] === 'boolean' ? raw[k] : UI_PREFS_DEFAULT[k];
    return {
      reduceTransparency: pick('reduceTransparency'),
      hideAdult: pick('hideAdult'),
      collapseDuplicates: pick('collapseDuplicates'),
    };
  } catch {
    return UI_PREFS_DEFAULT;
  }
}

let uiPrefs: UiPrefs = loadUiPrefs();
const uiPrefsListeners = new Set<() => void>();

function applyUiPrefs(): void {
  document.documentElement.dataset.transparency = uiPrefs.reduceTransparency ? 'off' : 'on';
}

export function getUiPrefs(): UiPrefs { return uiPrefs; }

export function setUiPrefs(patch: Partial<UiPrefs>): void {
  uiPrefs = { ...uiPrefs, ...patch };
  try { localStorage.setItem(UI_PREFS_KEY, JSON.stringify(uiPrefs)); } catch {}
  applyUiPrefs();
  for (const listener of uiPrefsListeners) listener();
}

export function useUiPrefs(): UiPrefs {
  return useSyncExternalStore(
    (listener) => { uiPrefsListeners.add(listener); return () => uiPrefsListeners.delete(listener); },
    getUiPrefs,
    getUiPrefs,
  );
}

applyUiPrefs();

export interface Draft {
  kind: SourceKind;
  name: string;
  url: string;
  username: string;
  password: string;
  epgUrl: string;
}

export const EMPTY_DRAFT: Draft = { kind: 'xtream', name: '', url: '', username: '', password: '', epgUrl: '' };

export function sourceToDraft(source: Source): Draft {
  return {
    kind: source.kind,
    name: source.name,
    url: source.url,
    username: source.kind === 'xtream' ? source.username : '',
    password: source.kind === 'xtream' ? source.password : '',
    epgUrl: source.epgUrl ?? '',
  };
}

type NewSource = Omit<XtreamSource, 'id'> | Omit<M3uSource, 'id'>;

export function draftToNew(draft: Draft): NewSource {
  const name = draft.name.trim();
  const url = draft.url.trim().replace(/\/+$/, '');
  const epgUrl = draft.epgUrl.trim() || undefined;
  return draft.kind === 'xtream'
    ? { kind: 'xtream', name, url, username: draft.username.trim(), password: draft.password, epgUrl }
    : { kind: 'm3u', name, url, epgUrl };
}

export function draftToSource(draft: Draft, id: string): Source {
  return { id, ...draftToNew(draft) };
}

export function draftComplete(draft: Draft): boolean {
  if (!draft.name.trim() || !draft.url.trim()) return false;
  if (draft.kind === 'xtream' && (!draft.username.trim() || !draft.password)) return false;
  return true;
}

export function Field({
  label, value, onChange, placeholder, hint, type = 'text', autoFocus, invalid,
}: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string;
  hint?: string; type?: 'text' | 'password'; autoFocus?: boolean; invalid?: boolean;
}) {
  const [reveal, setReveal] = useState(false);
  const secret = type === 'password';
  return (
    <label className="mx-field">
      <span className="mx-field__label">{label}</span>
      <span className={classNames('mx-field__box', invalid && 'mx-field__box--bad')}>
        <input
          className="mx-field__input"
          type={secret && !reveal ? 'password' : 'text'}
          value={value}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          autoFocus={autoFocus}
          dir="auto"
          onChange={(e) => onChange(e.target.value)}
        />
        {secret && (
          <button
            type="button"
            className="mx-field__reveal"
            aria-label={reveal ? 'Hide password' : 'Show password'}
            onClick={() => setReveal((r) => !r)}
          >
            <Glyph icon={reveal ? ICON.eyeOff : ICON.eye} />
          </button>
        )}
      </span>
      {hint && <span className="mx-field__hint caption t-tertiary">{hint}</span>}
    </label>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={classNames('mx-switch', checked && 'mx-switch--on')}
      onClick={() => onChange(!checked)}
    >
      <span className="mx-switch__knob" />
    </button>
  );
}

function tally(n?: number): ReactNode {
  return n === undefined ? <span className="mx-spec__dash">—</span> : <span className="data">{n.toLocaleString()}</span>;
}

function stamp(at?: string): ReactNode {
  return at ? <span className="data">{at}</span> : <span className="mx-spec__dash">Never</span>;
}

export function SpecRow({ label, children, tone }: { label: string; children: ReactNode; tone?: 'muted' | 'bad' }) {
  return (
    <div className="mx-spec__row">
      <span className="mx-spec__label">{label}</span>
      <span className={classNames('mx-spec__value', tone === 'muted' && 'mx-spec__value--muted', tone === 'bad' && 'mx-spec__value--bad')}>
        {children}
      </span>
    </div>
  );
}

export function SourceFields({ draft, onChange, autoFocus }: { draft: Draft; onChange: (d: Draft) => void; autoFocus?: boolean }) {
  const set = (patch: Partial<Draft>): void => onChange({ ...draft, ...patch });
  return (
    <div className="mx-fields">
      <Field
        label="Display name"
        value={draft.name}
        autoFocus={autoFocus}
        placeholder={draft.kind === 'xtream' ? 'Living room provider' : 'Weekend playlist'}
        onChange={(name) => set({ name })}
      />
      {draft.kind === 'xtream' ? (
        <>
          <Field
            label="Server URL"
            value={draft.url}
            placeholder="http://line.example.com:8080"
            hint="Origin only. xiptv appends the API paths itself."
            onChange={(url) => set({ url })}
          />
          <div className="mx-fields__pair">
            <Field label="Username" value={draft.username} onChange={(username) => set({ username })} />
            <Field label="Password" type="password" value={draft.password} onChange={(password) => set({ password })} />
          </div>
          <Field
            label="Guide URL (optional)"
            value={draft.epgUrl}
            placeholder="Defaults to xmltv.php on the same server"
            onChange={(epgUrl) => set({ epgUrl })}
          />
        </>
      ) : (
        <>
          <Field
            label="Playlist URL or file path"
            value={draft.url}
            placeholder="https://example.com/list.m3u8  ·  /home/you/list.m3u"
            hint="A remote playlist or an absolute path to one on this machine."
            onChange={(url) => set({ url })}
          />
          <Field
            label="Guide URL (optional)"
            value={draft.epgUrl}
            placeholder="https://example.com/xmltv.xml"
            hint="Without XMLTV, two thirds of channels show no programme information."
            onChange={(epgUrl) => set({ epgUrl })}
          />
        </>
      )}
    </div>
  );
}

function Section({ label, glyph, children }: { label: string; glyph: LucideIcon; children: ReactNode }) {
  return (
    <section className="settings__section">
      <h2 className="settings__section-head">
        <span className="settings__section-glyph"><Glyph icon={glyph} /></span>
        {label}
      </h2>
      {children}
    </section>
  );
}

function Row({ title, help, children }: { title: string; help?: string; children: ReactNode }) {
  return (
    <div className="settings__row">
      <div className="settings__row-text">
        <span className="settings__row-title">{title}</span>
        {help && <span className="settings__row-help caption t-tertiary">{help}</span>}
      </div>
      <div className="settings__row-ctl">{children}</div>
    </div>
  );
}

function isUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function feedTally(s?: EpgFeedStatus): ReactNode {
  if (!s) return <span className="mx-spec__dash">Not read yet</span>;
  if (s.error) return s.error;
  return <span className="data">{s.channels.toLocaleString()} ch · {s.programmes.toLocaleString()} prog</span>;
}

function FillFeeds({ sourceId, fill, status, onChange }: {
  sourceId?: string; fill: EpgFillSettings; status?: EpgFeedStatus[]; onChange: (f: EpgFillSettings) => void;
}) {
  const [catalogue, setCatalogue] = useState<{ catalogue: EpgFeed[]; auto: string[] }>();
  const [showAll, setShowAll] = useState(false);
  const [url, setUrl] = useState('');

  useEffect(() => {
    if (!sourceId) return;
    let live = true;
    window.iptv.epg.feeds(sourceId).then((c) => { if (live) setCatalogue(c); }).catch(() => undefined);
    return () => { live = false; };
  }, [sourceId]);

  const auto = catalogue?.auto ?? [];
  const entries = catalogue?.catalogue ?? [];
  const known = new Set(entries.map((f) => f.id));
  const byId = new Map((status ?? []).map((s) => [s.id, s]));

  const isOn = (id: string): boolean =>
    !fill.disabled.includes(id) && (fill.enabled.includes(id) || (fill.auto && auto.includes(id)));

  const toggle = (id: string): void => {
    const enabled = fill.enabled.filter((x) => x !== id);
    const disabled = fill.disabled.filter((x) => x !== id);
    if (isOn(id)) {
      if (fill.auto && auto.includes(id)) disabled.push(id);
    } else {
      enabled.push(id);
    }
    onChange({ ...fill, enabled, disabled });
  };

  const custom = fill.enabled.filter((id) => !known.has(id));
  const addCustom = (): void => {
    const u = url.trim();
    if (!isUrl(u) || fill.enabled.includes(u)) return;
    onChange({ ...fill, enabled: [...fill.enabled, u] });
    setUrl('');
  };

  const shown = showAll ? entries : entries.filter((f) => isOn(f.id) || auto.includes(f.id));
  const on = entries.filter((f) => isOn(f.id)).length + custom.length;

  return (
    <>
      <Row title="Pick guides from channel names" help="Reads the country tags on your channels (AU:, US |, UK ★) and ticks the matching public guides.">
        <Switch label="Pick guides from channel names" checked={fill.auto} onChange={(auto) => onChange({ ...fill, auto })} />
      </Row>

      <div className="settings__stack">
        <span className="caption t-tertiary">
          {on === 0 ? 'No extra guides. Only the provider feed is read.' : `${on} extra ${on === 1 ? 'guide' : 'guides'} fill channels the provider leaves blank.`}
        </span>
        <div className="settings__feeds">
          {shown.map((f) => (
            <button
              key={f.id}
              type="button"
              className={classNames('mx-tog sm', isOn(f.id) && 'mx-tog--on')}
              aria-pressed={isOn(f.id)}
              title={byId.get(f.id)?.error ?? f.url}
              onClick={() => toggle(f.id)}
            >
              {f.label}
              {byId.get(f.id)?.error && <Glyph icon={ICON.alert} size={12} />}
            </button>
          ))}
          {custom.map((u) => (
            <button
              key={u}
              type="button"
              className="mx-tog sm mx-tog--on"
              aria-pressed
              title={byId.get(u)?.error ?? `${u} · click to remove`}
              onClick={() => toggle(u)}
            >
              <span className="truncate">{byId.get(u)?.label ?? u}</span>
              <Glyph icon={ICON.close} size={12} />
            </button>
          ))}
          {entries.length > shown.length && (
            <button type="button" className="mx-tog sm" onClick={() => setShowAll(true)}>
              <Glyph icon={ICON.plus} size={12} />{entries.length - shown.length} more{entries.length - shown.length === 1 ? ' country' : ' countries'}
            </button>
          )}
          {showAll && (
            <button type="button" className="mx-tog sm" onClick={() => setShowAll(false)}>Fewer</button>
          )}
        </div>
        <div className="settings__feeds-add">
          <Field
            label="Add your own XMLTV guide"
            value={url}
            placeholder="https://example.com/guide.xml.gz"
            hint="Plain, gzip, brotli or deflate XMLTV. It fills only channels no earlier guide covers."
            onChange={setUrl}
          />
          <div className="settings__stack-act">
            <Button variant="ghost" disabled={!isUrl(url.trim())} onClick={addCustom}><Glyph icon={ICON.plus} />Add guide</Button>
          </div>
        </div>
      </div>

      {status && status.length > 0 && (
        <div className="mx-spec">
          {status.map((s) => (
            <SpecRow key={s.id} label={s.label} tone={s.error ? 'bad' : s.channels === 0 ? 'muted' : undefined}>
              {feedTally(s)}
            </SpecRow>
          ))}
        </div>
      )}
    </>
  );
}

const APP_VERSION = '1.0.0';

function versionFrom(pattern: RegExp): string {
  return pattern.exec(navigator.userAgent)?.[1] ?? 'unknown';
}

function formatStamp(unixSeconds?: number): string | undefined {
  if (!unixSeconds) return undefined;
  return new Date(unixSeconds * 1000).toLocaleString([], {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function Settings() {
  const sources = useApp((s) => s.sources);
  const activeSourceId = useApp((s) => s.activeSourceId);
  const settings = useApp((s) => s.settings);
  const prefs = useUiPrefs();

  const source = sources.find((s) => s.id === activeSourceId) ?? sources[0];

  const [stats, setStats] = useState<SourceStats | undefined>();
  const [editing, setEditing] = useState<string | 'new' | undefined>();
  const [external, setExternal] = useState(settings.externalPlayer ?? '');
  const [sync, setSync] = useState<SyncProgress | undefined>();
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => setExternal(settings.externalPlayer ?? ''), [settings.externalPlayer]);

  const loadStats = useCallback(async (id: string) => {
    try { setStats(await window.iptv.catalog.stats(id)); } catch { setStats(undefined); }
  }, []);

  useEffect(() => {
    if (!source) { setStats(undefined); return; }
    void loadStats(source.id);
  }, [source, loadStats]);

  useEffect(() => window.iptv.on('sync-progress', setSync), []);

  const write = useCallback(async (patch: SettingsPatch) => {
    try {
      const next = await window.iptv.settings.set(patch);
      useApp.getState().patch({ settings: next, activeSourceId: next.activeSourceId ?? useApp.getState().activeSourceId });
    } catch (err) {
      useApp.getState().toast$(errorText(err, 'Could not save that setting.'), 'error');
    }
  }, []);

  const reloadSources = useCallback(async () => {
    const list = await window.iptv.sources.list();
    useApp.getState().patch({ sources: list });
    return list;
  }, []);

  const removeSource = useCallback(async (id: string) => {
    try {
      await window.iptv.sources.remove(id);
      const list = await reloadSources();
      if (id === activeSourceId) {
        const next = list[0];
        useApp.getState().patch({ activeSourceId: next?.id, items: [], categories: {}, selectedCategory: {} });
        if (next) await window.iptv.sources.setActive(next.id);
      }
      useApp.getState().toast$('Source removed.');
    } catch (err) {
      useApp.getState().toast$(errorText(err, 'Could not remove that source.'), 'error');
    }
  }, [activeSourceId, reloadSources]);

  const makeActive = useCallback(async (id: string) => {
    try {
      await window.iptv.sources.setActive(id);
      useApp.getState().patch({ activeSourceId: id, items: [], categories: {}, selectedCategory: {} });
      await write({ activeSourceId: id });
    } catch (err) {
      useApp.getState().toast$(errorText(err, 'Could not switch source.'), 'error');
    }
  }, [write]);

  const refreshGuide = useCallback(async () => {
    if (!source) return;
    setRefreshing(true);
    setSync({ phase: 'epg', message: 'Contacting the guide server', progress: null });
    try {
      await window.iptv.epg.refresh(source.id);
      await loadStats(source.id);
      useApp.getState().toast$('Guide refreshed.');
    } catch (err) {
      useApp.getState().toast$(errorText(err, 'The guide server did not respond.'), 'error');
    } finally {
      setRefreshing(false);
      setSync(undefined);
    }
  }, [source, loadStats]);

  const lastSync = formatStamp(stats?.lastSync);

  return (
    <div className="mx-page settings">
      <div className="settings__scroll">
        <header className="mx-head settings__head">
          <div className="mx-head__titles">
            <h1 className="h1">Settings</h1>
            <p className="mx-head__count data">
              {sources.length.toLocaleString()} {sources.length === 1 ? 'source' : 'sources'}
              {source && <> · <span className="settings__head-name">{source.name}</span></>}
            </p>
          </div>
        </header>

        <div className="settings__body">
          <Section label="Provider" glyph={ICON.server}>
            {sources.length === 0 && (
              <p className="settings__note sm t-secondary">
                No sources yet. xiptv ships no catalogue of its own. Add an Xtream account or an
                M3U playlist and everything else in the app fills in.
              </p>
            )}

            <ul className="settings__sources">
              {sources.map((s) => (
                <li key={s.id} className={classNames('settings__source', s.id === source?.id && 'settings__source--active')}>
                  <div className="settings__source-head">
                    <span
                      className={classNames('settings__dot', s.id === source?.id ? 'settings__dot--ok' : 'settings__dot--idle')}
                      aria-hidden
                    />
                    <span className="settings__source-name truncate" dir="auto">{s.name}</span>
                    <span className="mx-chip micro">{s.kind === 'xtream' ? 'XTREAM' : 'M3U'}</span>
                    {s.id === source?.id && <span className="settings__source-flag micro">IN USE</span>}
                  </div>
                  <p className="settings__source-url data truncate" dir="auto">{s.url}</p>
                  <div className="settings__source-acts">
                    {s.id !== source?.id && (
                      <Button variant="plain" onClick={() => void makeActive(s.id)}>Use this source</Button>
                    )}
                    <Button variant="plain" onClick={() => setEditing(editing === s.id ? undefined : s.id)}>
                      {editing === s.id ? 'Close' : 'Edit'}
                    </Button>
                    <span className="settings__spacer" />
                    <Button variant="plain" className="settings__remove" onClick={() => void removeSource(s.id)}>
                      <Glyph icon={ICON.trash} />Remove
                    </Button>
                  </div>
                  {editing === s.id && (
                    <SourceEditor
                      initial={sourceToDraft(s)}
                      submitLabel="Save changes"
                      onCancel={() => setEditing(undefined)}
                      onSubmit={async (draft) => {
                        await window.iptv.sources.update(draftToSource(draft, s.id));
                        await reloadSources();
                        setEditing(undefined);
                        useApp.getState().toast$('Source updated.');
                      }}
                    />
                  )}
                </li>
              ))}
            </ul>

            {editing === 'new' ? (
              <SourceEditor
                initial={EMPTY_DRAFT}
                submitLabel="Add source"
                onCancel={() => setEditing(undefined)}
                onSubmit={async (draft) => {
                  const added = await window.iptv.sources.add(draftToNew(draft));
                  const list = await reloadSources();
                  if (list.length === 1) await makeActive(added.id);
                  setEditing(undefined);
                  useApp.getState().toast$('Source added.');
                }}
              />
            ) : (
              <Button variant="ghost" className="settings__add" onClick={() => setEditing('new')}>
                <Glyph icon={ICON.plus} />Add a source
              </Button>
            )}

            <div className="mx-spec">
              <SpecRow label="Channel categories">{tally(stats?.liveCategories)}</SpecRow>
              <SpecRow label="Movie categories">{tally(stats?.movieCategories)}</SpecRow>
              <SpecRow label="Series categories">{tally(stats?.seriesCategories)}</SpecRow>
              <SpecRow label="Synced">{stamp(lastSync)}</SpecRow>
            </div>
          </Section>

          <Section label="Guide" glyph={ICON.clock}>
            <p className="settings__note sm t-secondary">
              The provider's guide is read first. Public guides then fill in channels it shipped
              without listings; a channel that already has listings is never overwritten.
            </p>

            <div className="mx-spec">
              <SpecRow label="Programmes">
                {tally(stats?.epgProgrammes)}
              </SpecRow>
              <SpecRow label="Last sync">
                {stamp(lastSync)}
              </SpecRow>
            </div>

            <FillFeeds
              sourceId={source?.id}
              fill={settings.epgFill}
              status={stats?.epgFeeds}
              onChange={(epgFill) => void write({ epgFill })}
            />

            <Row title="Refresh the guide now" help="Re-reads the provider guide and every ticked public guide, then rebuilds the schedule index.">
              <Button variant="ghost" disabled={!source || refreshing} onClick={() => void refreshGuide()}>
                <Glyph icon={ICON.refresh} />{refreshing ? 'Refreshing' : 'Refresh guide'}
              </Button>
            </Row>

            {refreshing && (
              <div className="settings__sync">
                <ProgressBar value={sync?.progress ?? null} />
                <p className="settings__sync-msg caption t-tertiary">
                  <span className="settings__sync-phase">{(sync?.phase ?? 'epg').toUpperCase()}</span>
                  {sync?.message ?? 'Working'}
                </p>
              </div>
            )}

            <Row title="Automatic refresh" help="How often xiptv re-reads XMLTV in the background.">
              <Segmented
                label="Automatic guide refresh"
                value={settings.epgAutoRefreshHours === null ? 'off' : String(settings.epgAutoRefreshHours)}
                options={[
                  { value: 'off', label: 'Off' },
                  { value: '6', label: '6h' },
                  { value: '12', label: '12h' },
                  { value: '24', label: '24h' },
                ]}
                onChange={(v) => void write({ epgAutoRefreshHours: v === 'off' ? null : Number(v) })}
              />
            </Row>
          </Section>

          <Section label="Playback" glyph={ICON.play}>
            <Row title="Hardware acceleration" help="Decode on the GPU. Turn it off if video tears or the window renders black. Takes effect after a restart.">
              <Switch
                label="Hardware acceleration"
                checked={settings.hardwareAcceleration}
                onChange={(v) => void write({ hardwareAcceleration: v })}
              />
            </Row>

            <Row title="Live stream format" help="MPEG-TS is the most compatible. HLS recovers better on a connection that keeps dropping.">
              <Segmented
                label="Live stream format"
                value={settings.liveFormat}
                options={[{ value: 'ts', label: 'MPEG-TS' }, { value: 'hls', label: 'HLS' }]}
                onChange={(v) => void write({ liveFormat: v })}
              />
            </Row>

            <div className="settings__stack">
              <Field
                label="External player"
                value={external}
                placeholder="/usr/bin/mpv  ·  C:\Program Files\VLC\vlc.exe"
                hint='Used by "Open in external player". Leave empty to use the system default.'
                onChange={setExternal}
              />
              <div className="settings__stack-act">
                <Button
                  variant="ghost"
                  disabled={external === (settings.externalPlayer ?? '')}
                  onClick={() => void write({ externalPlayer: external.trim() || null })}
                >
                  Save path
                </Button>
              </div>
            </div>
          </Section>

          <Section label="Interface" glyph={ICON.monitor}>
            <Row title="Reduce transparency" help="Turns off the blur behind the section headers, the guide ruler and the palette.">
              <Switch label="Reduce transparency" checked={prefs.reduceTransparency} onChange={(v) => setUiPrefs({ reduceTransparency: v })} />
            </Row>

            <Row title="Hide adult categories" help="Filters XXX categories out of the sidebar, the landings and every search result.">
              <Switch label="Hide adult categories" checked={prefs.hideAdult} onChange={(v) => setUiPrefs({ hideAdult: v })} />
            </Row>

            <Row title="Collapse duplicate channels" help="Providers ship the same channel six times. Folds the run into one row with quality pills.">
              <Switch label="Collapse duplicate channels" checked={prefs.collapseDuplicates} onChange={(v) => setUiPrefs({ collapseDuplicates: v })} />
            </Row>
          </Section>

          <Section label="About" glyph={ICON.info}>
            <div className="mx-spec">
              <SpecRow label="xiptv"><span className="data">{APP_VERSION}</span></SpecRow>
              <SpecRow label="Electron"><span className="data">{versionFrom(/Electron\/([\d.]+)/)}</span></SpecRow>
              <SpecRow label="Chromium"><span className="data">{versionFrom(/Chrome\/([\d.]+)/)}</span></SpecRow>
            </div>
            <p className="settings__note sm t-secondary">
              xiptv plays what your provider ships and nothing else. There is no account, no
              telemetry and no catalogue of its own. The source list above is the whole product.
            </p>
          </Section>
        </div>
      </div>
    </div>
  );
}

export interface TestResult { ok: boolean; message: string; probe?: SourceProbe }

export function useSourceTest(draft: Draft) {
  const [test, setTest] = useState<TestResult | undefined>();
  const [testing, setTesting] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const runTest = useCallback(async () => {
    setTesting(true);
    setTest(undefined);
    try {
      const result = await window.iptv.sources.test(draftToNew(draft));
      if (alive.current) setTest(result);
    } catch (err) {
      if (alive.current) setTest({ ok: false, message: errorText(err) });
    } finally {
      if (alive.current) setTesting(false);
    }
  }, [draft]);

  return { test, setTest, testing, runTest };
}

function SourceEditor({
  initial, submitLabel, onSubmit, onCancel,
}: {
  initial: Draft;
  submitLabel: string;
  onSubmit: (draft: Draft) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(initial);
  const { test, setTest, testing, runTest } = useSourceTest(draft);
  const [saving, setSaving] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const complete = draftComplete(draft);

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await onSubmit(draft);
    } catch (err) {
      useApp.getState().toast$(errorText(err, 'Could not save that source.'), 'error');
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  return (
    <div className="settings__editor">
      <Segmented
        label="Source type"
        className="settings__kindseg"
        value={draft.kind}
        options={[{ value: 'xtream', label: 'Xtream Codes' }, { value: 'm3u', label: 'M3U playlist' }]}
        onChange={(kind) => { setDraft({ ...draft, kind }); setTest(undefined); }}
      />
      <SourceFields draft={draft} onChange={(d) => { setDraft(d); setTest(undefined); }} autoFocus />
      <TestReport result={test} testing={testing} />
      <div className="settings__editor-acts">
        <Button variant="ghost" disabled={!complete || testing} onClick={() => void runTest()}>
          {testing ? 'Testing' : 'Test connection'}
        </Button>
        <span className="settings__spacer" />
        <Button variant="plain" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" disabled={!complete || saving} onClick={() => void save()}>{submitLabel}</Button>
      </div>
    </div>
  );
}

export function TestReport({ result, testing }: { result?: TestResult; testing: boolean }) {
  if (testing) {
    return (
      <div className="mx-report mx-report--busy">
        <ProgressBar value={null} />
        <p className="mx-report__msg sm t-secondary">Opening a connection and reading the account.</p>
      </div>
    );
  }
  if (!result) return null;

  if (!result.ok) {
    return (
      <div className="mx-report mx-report--bad" role="alert">
        <span className="mx-report__glyph"><Glyph icon={ICON.alert} size={20} /></span>
        <div className="mx-report__text">
          <p className="h2">The provider refused that</p>
          <p className="mx-report__msg sm t-secondary" dir="auto">{result.message}</p>
        </div>
      </div>
    );
  }

  const probe = result.probe;
  const labels = probe?.counts === 'categories'
    ? ['Channel categories', 'Movie categories', 'Series categories']
    : ['Channels', 'Movies', 'Series'];
  const counted: Array<[string, number]> = probe
    ? [[labels[0], probe.live], [labels[1], probe.movies], [labels[2], probe.series]]
    : [];

  return (
    <div className="mx-report mx-report--ok">
      <span className="mx-report__glyph mx-report__glyph--ok"><Glyph icon={ICON.check} size={20} /></span>
      <div className="mx-report__text">
        <p className="h2">Connected</p>
        <p className="mx-report__msg sm t-secondary" dir="auto">{result.message}</p>
        {counted.length > 0 && (
          <ul className="mx-report__counts">
            {counted.map(([label, value]) => (
              <li key={label}>
                <span className="mx-report__count data">{value.toLocaleString()}</span>
                <span className="mx-report__count-label micro">{label}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
