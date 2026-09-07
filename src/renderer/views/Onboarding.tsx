import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
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
import './onboard.css';

type Step = 'welcome' | 'kind' | 'connect' | 'sync';
type FormStep = Exclude<Step, 'welcome'>;

/** The welcome screen is a curtain, not a task, so it sits outside the numbered rail. */
const RAIL: readonly FormStep[] = ['kind', 'connect', 'sync'];
const RAIL_LABEL: Record<FormStep, string> = {
  kind: 'Provider',
  connect: 'Details',
  sync: 'Catalogue',
};

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
    body: 'A playlist URL or a file on this machine, with an optional XMLTV guide.',
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
  const [step, setStep] = useState<Step>('welcome');
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const { test, setTest, testing, runTest } = useSourceTest(draft);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<Source | undefined>();
  const [sync, setSync] = useState<SyncProgress | undefined>();
  const [stats, setStats] = useState<SourceStats | undefined>();
  const accelerated = useApp((s) => s.settings.hardwareAcceleration);
  const alive = useRef(true);

  useEffect(() => () => { alive.current = false; }, []);
  useEffect(() => window.iptv.on('sync-progress', (p) => { if (alive.current) setSync(p); }), []);

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

  const done = stats !== undefined || sync?.phase === 'done';

  return (
    <div className="onboard">
      {/* With the shader off there is no ocean to sit on, so the flow brings its own tide. */}
      {!accelerated && <div className="onboard__wash" aria-hidden />}

      <main className="onboard__col">
        <section className={classNames('onboard__panel', step === 'welcome' && 'onboard__panel--hero')}>
          {step !== 'welcome' && <Rail step={step} />}

          {/* Keyed so every step, and the moment the catalogue lands, plays its own entrance. */}
          <div className="onboard__stage" key={step === 'sync' && done ? 'landed' : step}>
            {step === 'welcome' && <Welcome onStart={() => setStep('kind')} />}

            {step === 'kind' && (
              <PickKind onPick={(kind) => { setDraft({ ...draft, kind }); setTest(undefined); setStep('connect'); }} />
            )}

            {step === 'connect' && (
              <Connect
                draft={draft}
                onDraft={(d) => { setDraft(d); setTest(undefined); }}
                test={test}
                testing={testing}
                adding={adding}
                onBack={() => { setTest(undefined); setStep('kind'); }}
                onTest={() => void runTest()}
                onAdd={() => void add()}
              />
            )}

            {step === 'sync' && (
              <Landing
                name={added?.name ?? draft.name}
                sync={sync}
                stats={stats}
                done={done}
                onRetry={() => { if (added) { setSync(undefined); setStats(undefined); void startSync(added); } }}
                onEdit={() => { setSync(undefined); setStep('connect'); }}
                onFinish={() => void finish()}
              />
            )}
          </div>
        </section>

        {step !== 'sync' && (
          <p className="onboard__foot caption">
            Everything stays on this machine. xiptv only talks to the provider you name.
          </p>
        )}
      </main>
    </div>
  );
}

function Rail({ step }: { step: FormStep }) {
  const index = RAIL.indexOf(step);
  return (
    <>
      <div className="onboard__rail" aria-hidden>
        {RAIL.map((s, i) => (
          <span
            key={s}
            className="onboard__rail-seg"
            data-state={i < index ? 'done' : i === index ? 'on' : 'off'}
          />
        ))}
      </div>
      <p className="onboard__kicker onboard__kicker--rail" key={step}>
        {`0${index + 1} / 0${RAIL.length}`}
        <span className="onboard__kicker-dot" aria-hidden>·</span>
        {RAIL_LABEL[step]}
      </p>
    </>
  );
}

/** The brand mark: two currents crossing into an X. `--i` staggers the draw, blue then amber. */
const CURRENTS = [
  { d: 'M9 9C21 15 29 35 41 41', stroke: 'url(#xiptv-current)' },
  { d: 'M9 41C21 35 29 15 41 9', stroke: 'var(--accent)' },
];

function BrandMark() {
  return (
    <div className="onboard__mark" aria-hidden>
      <svg viewBox="0 0 50 50" fill="none">
        <defs>
          <linearGradient id="xiptv-current" x1="9" y1="9" x2="41" y2="41" gradientUnits="userSpaceOnUse">
            <stop stopColor="#1B6CA8" />
            <stop offset="1" stopColor="#5AD2F4" />
          </linearGradient>
        </defs>
        {CURRENTS.map((c, i) => (
          <path
            key={c.d}
            className="onboard__current"
            style={{ '--i': i } as CSSProperties}
            d={c.d}
            stroke={c.stroke}
          />
        ))}
      </svg>
    </div>
  );
}

function Welcome({ onStart }: { onStart: () => void }) {
  return (
    <>
      <BrandMark />
      <p className="onboard__kicker">Welcome to xiptv</p>
      <h1 className="serif-1 onboard__title">Bring your own provider.</h1>
      <p className="onboard__lede sm t-secondary">
        xiptv carries no catalogue of its own. Point it at your Xtream account or an M3U playlist
        and it plays live TV, films and series, with the guide alongside them.
      </p>
      <div className="onboard__acts">
        <Button variant="primary" className="onboard__go" onClick={onStart}>
          Set up your provider
          <Glyph icon={ICON.arrowRight} size={15} />
        </Button>
      </div>
    </>
  );
}

function PickKind({ onPick }: { onPick: (kind: SourceKind) => void }) {
  return (
    <>
      <h1 className="serif-2 onboard__title">How do you connect?</h1>
      <p className="onboard__lede sm t-secondary">Pick the kind of account your provider gave you.</p>
      <div className="onboard__kinds">
        {KINDS.map((k) => (
          <button key={k.value} type="button" className="onboard__kind" onClick={() => onPick(k.value)}>
            <span className="onboard__kind-glyph"><Glyph icon={k.icon} size={18} /></span>
            <span className="onboard__kind-text">
              <span className="onboard__kind-title h2">{k.title}</span>
              <span className="onboard__kind-body caption t-tertiary">{k.body}</span>
            </span>
            <span className="onboard__kind-go"><Glyph icon={ICON.arrowRight} size={16} /></span>
          </button>
        ))}
      </div>
    </>
  );
}

function Connect({
  draft, onDraft, test, testing, adding, onBack, onTest, onAdd,
}: {
  draft: Draft;
  onDraft: (d: Draft) => void;
  test?: TestResult;
  testing: boolean;
  adding: boolean;
  onBack: () => void;
  onTest: () => void;
  onAdd: () => void;
}) {
  const xtream = draft.kind === 'xtream';
  const complete = draftComplete(draft);
  return (
    <>
      <h1 className="serif-2 onboard__title">{xtream ? 'Your Xtream account.' : 'Your playlist.'}</h1>
      <p className="onboard__lede sm t-secondary">
        {xtream
          ? 'Type what your provider sent you. It is kept on this machine.'
          : 'Point at a playlist URL or a file on this machine. Add a guide if you have one.'}
      </p>

      <SourceFields draft={draft} onChange={onDraft} autoFocus />
      <TestReport result={test} testing={testing} />

      <div className="onboard__acts">
        <Button variant="plain" onClick={onBack}>Back</Button>
        <span className="onboard__spacer" />
        <Button variant="ghost" disabled={!complete || testing} onClick={onTest}>
          {testing ? 'Testing' : 'Test connection'}
        </Button>
        <Button variant="primary" disabled={!complete || adding} onClick={onAdd}>
          {adding ? 'Adding' : 'Continue'}
        </Button>
      </div>
    </>
  );
}

function Landing({
  name, sync, stats, done, onRetry, onEdit, onFinish,
}: {
  name: string;
  sync?: SyncProgress;
  stats?: SourceStats;
  done: boolean;
  onRetry: () => void;
  onEdit: () => void;
  onFinish: () => void;
}) {
  const failed = sync?.phase === 'error';

  const [index, setIndex] = useState(0);
  useEffect(() => {
    const found = PHASES.findIndex((p) => p.phase === sync?.phase);
    if (found >= 0) setIndex(found);
  }, [sync?.phase]);

  return (
    <>
      <h1 className="serif-2 onboard__title">{done ? 'Your catalogue is ready.' : 'Reading your provider.'}</h1>
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

      {!failed && !done && sync?.message && (
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
            <Button variant="ghost" onClick={onEdit}>Edit source</Button>
            <span className="onboard__spacer" />
            <Button variant="primary" onClick={onRetry}>Retry</Button>
          </>
        ) : (
          <Button variant="primary" className="onboard__finish" disabled={!done} onClick={onFinish}>
            {done ? 'Start watching' : 'Reading the catalogue'}
            {done && <Glyph icon={ICON.arrowRight} size={15} />}
          </Button>
        )}
      </div>
    </>
  );
}
