import { useCallback, useEffect, useRef, useState } from 'react';
import type { Source, SourceKind, SourceStats, SyncProgress } from '@shared/types';
import { useApp } from '@/state/store';
import { Button } from '@/components/Primitives';
import { Glyph, ICON, ProgressBar } from '@/components/CommandPalette';
import type { LucideIcon } from 'lucide-react';
import { classNames, errorText } from '@/lib/format';
import {
  EMPTY_DRAFT, SourceFields, TestReport, draftComplete, draftToNew, draftToSource, useSourceTest,
  type Draft, type TestResult,
} from '@/views/Settings';
import './misc.css';

interface KindOption { value: SourceKind; title: string; body: string; icon: LucideIcon }

const KINDS: readonly KindOption[] = [
  {
    value: 'xtream',
    title: 'Xtream Codes',
    body: 'A server, a username and a password. Brings live TV, movies, series and the guide in one pass.',
    icon: ICON.server,
  },
  {
    value: 'm3u',
    title: 'M3U playlist',
    body: 'A playlist URL or a file on this machine, with an optional XMLTV guide alongside it.',
    icon: ICON.bookmark,
  },
];

const PHASES = [
  { phase: 'categories', label: 'Categories' },
  { phase: 'live', label: 'Channels' },
  { phase: 'movies', label: 'Movies' },
  { phase: 'series', label: 'Series' },
  { phase: 'epg', label: 'Guide' },
] as const;

export function Onboarding() {
  const [step, setStep] = useState<'form' | 'sync'>('form');
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const { test, setTest, testing, runTest } = useSourceTest(draft);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<Source | undefined>();
  const [sync, setSync] = useState<SyncProgress | undefined>();
  const [stats, setStats] = useState<SourceStats | undefined>();
  const alive = useRef(true);

  useEffect(() => () => { alive.current = false; }, []);
  useEffect(() => window.iptv.on('sync-progress', (p) => { if (alive.current) setSync(p); }), []);

  const complete = draftComplete(draft);

  const startSync = useCallback(async (source: Source) => {
    try {
      await window.iptv.sources.setActive(source.id);
      await window.iptv.settings.set({ activeSourceId: source.id });
      await window.iptv.catalog.refresh(source.id);
      const read = await window.iptv.catalog.stats(source.id);
      if (alive.current) setStats(read);
    } catch (err) {
      if (alive.current) {
        setSync({ phase: 'error', message: 'Reading the catalogue failed', progress: null, error: errorText(err) });
      }
    }
  }, []);

  const add = useCallback(async () => {
    setAdding(true);
    try {
      const source = added
        ? await window.iptv.sources.update(draftToSource(draft, added.id))
        : await window.iptv.sources.add(draftToNew(draft));
      if (!alive.current) return;
      setAdded(source);
      setStep('sync');
      void startSync(source);
    } catch (err) {
      if (alive.current) setTest({ ok: false, message: errorText(err) });
    } finally {
      if (alive.current) setAdding(false);
    }
  }, [added, draft, startSync]);

  const finish = useCallback(async () => {
    try {
      const [sources, settings] = await Promise.all([window.iptv.sources.list(), window.iptv.settings.get()]);
      useApp.getState().patch({ sources, activeSourceId: added?.id ?? settings.activeSourceId, settings, ready: true });
      useApp.getState().navigate({ view: 'live' });
    } catch (err) {
      useApp.getState().toast$(errorText(err, 'Could not open the catalogue.'), 'error');
    }
  }, [added]);

  return (
    <div className="onboard">
      <main className="onboard__col">
        {step === 'form' ? (
          <FirstSourceForm
            draft={draft}
            onDraft={(d) => { setDraft(d); setTest(undefined); }}
            test={test}
            testing={testing}
            complete={complete}
            adding={adding}
            onTest={() => void runTest()}
            onAdd={() => void add()}
          />
        ) : (
          <SyncLedger
            name={added?.name ?? draft.name}
            sync={sync}
            stats={stats}
            onRetry={() => { if (added) { setSync(undefined); setStats(undefined); void startSync(added); } }}
            onEdit={() => { setStep('form'); setSync(undefined); }}
            onFinish={() => void finish()}
          />
        )}
      </main>
    </div>
  );
}

function FirstSourceForm({
  draft, onDraft, test, testing, complete, adding, onTest, onAdd,
}: {
  draft: Draft;
  onDraft: (d: Draft) => void;
  test?: TestResult;
  testing: boolean;
  complete: boolean;
  adding: boolean;
  onTest: () => void;
  onAdd: () => void;
}) {
  return (
    <>
      <p className="onboard__kicker">Set up xiptv</p>
      <h1 className="serif-2 onboard__title">Bring your own provider.</h1>
      <p className="onboard__lede sm t-secondary">
        xiptv ships no catalogue of its own. Point it at an Xtream account or an M3U playlist and it
        plays whatever that provider carries.
      </p>

      <div className="onboard__kinds" role="radiogroup" aria-label="Source type">
        {KINDS.map((k) => {
          const on = draft.kind === k.value;
          return (
            <button
              key={k.value}
              type="button"
              role="radio"
              aria-checked={on}
              className={classNames('onboard__kind', on && 'onboard__kind--on')}
              onClick={() => onDraft({ ...draft, kind: k.value })}
            >
              <span className="onboard__kind-top">
                <span className="onboard__kind-glyph"><Glyph icon={k.icon} /></span>
                <span className="onboard__kind-title h2">{k.title}</span>
                {on && <span className="onboard__kind-check"><Glyph icon={ICON.check} size={14} /></span>}
              </span>
              <span className="onboard__kind-body caption t-tertiary">{k.body}</span>
            </button>
          );
        })}
      </div>

      <SourceFields draft={draft} onChange={onDraft} />

      <TestReport result={test} testing={testing} />

      <div className="onboard__acts">
        <Button variant="ghost" className="onboard__test" disabled={!complete || testing} onClick={onTest}>
          {testing ? 'Testing' : 'Test connection'}
        </Button>
        <Button variant="primary" className="onboard__submit" disabled={!complete || adding} onClick={onAdd}>
          {adding ? 'Adding' : 'Add source'}
        </Button>
      </div>

      <p className="onboard__foot caption t-tertiary">
        {draft.kind === 'xtream' ? 'Credentials stay on this machine. ' : ''}
        xiptv sends nothing anywhere except to the address you type above.
      </p>
    </>
  );
}

function SyncLedger({
  name, sync, stats, onRetry, onEdit, onFinish,
}: {
  name: string;
  sync?: SyncProgress;
  stats?: SourceStats;
  onRetry: () => void;
  onEdit: () => void;
  onFinish: () => void;
}) {
  const failed = sync?.phase === 'error';
  const done = stats !== undefined || sync?.phase === 'done';

  const [index, setIndex] = useState(0);
  useEffect(() => {
    const found = PHASES.findIndex((p) => p.phase === sync?.phase);
    if (found >= 0) setIndex(found);
  }, [sync?.phase]);

  return (
    <div className="onboard__ledger">
      <p className="onboard__kicker">Reading your provider</p>
      <h1 className="serif-2 onboard__title">{done ? 'Your catalogue is ready.' : 'One moment.'}</h1>
      <p className="onboard__lede sm t-secondary" dir="auto">{name}</p>

      <ul className="onboard__phases">
        {PHASES.map((p, i) => {
          const state = done ? 'done' : failed && i === index ? 'bad' : i < index ? 'done' : i === index ? 'busy' : 'pending';
          return (
            <li key={p.phase} className={classNames('onboard__phase', `onboard__phase--${state}`)}>
              <span className="onboard__phase-label">{p.label}</span>
              <span className="onboard__phase-state">
                {state === 'pending' && <span className="onboard__dots">····</span>}
                {state === 'busy' && <ProgressBar value={sync?.progress ?? null} className="onboard__phase-bar" />}
                {state === 'done' && <span className="onboard__tick"><Glyph icon={ICON.check} size={12} /></span>}
                {state === 'bad' && <span className="onboard__bad"><Glyph icon={ICON.alert} size={12} /></span>}
              </span>
            </li>
          );
        })}
      </ul>

      {!failed && sync?.message && !done && (
        <p className="onboard__msg caption t-tertiary" dir="auto">{sync.message}</p>
      )}

      {failed && (
        <div className="mx-report mx-report--bad" role="alert">
          <span className="mx-report__glyph"><Glyph icon={ICON.alert} size={20} /></span>
          <div className="mx-report__text">
            <p className="h2">That did not finish</p>
            <p className="mx-report__msg sm t-secondary" dir="auto">{sync.error ?? sync.message}</p>
          </div>
        </div>
      )}

      {done && stats && (
        <ul className="onboard__counts">
          {([
            ['Channel categories', stats.liveCategories],
            ['Movie categories', stats.movieCategories],
            ['Series categories', stats.seriesCategories],
            ['Programmes', stats.epgProgrammes],
          ] as const).map(([label, value]) => (
            <li key={label}>
              <span className="onboard__count data">{value.toLocaleString()}</span>
              <span className="onboard__count-label micro">{label}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="onboard__acts">
        {failed ? (
          <>
            <Button variant="ghost" className="onboard__test" onClick={onEdit}>Edit source</Button>
            <Button variant="primary" className="onboard__submit" onClick={onRetry}>Retry</Button>
          </>
        ) : (
          <Button variant="primary" className="onboard__submit onboard__submit--wide" disabled={!done} onClick={onFinish}>
            {done ? 'Start watching' : 'Reading the catalogue'}
          </Button>
        )}
      </div>
    </div>
  );
}
