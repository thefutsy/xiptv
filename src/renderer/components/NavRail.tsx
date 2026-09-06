import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Clapperboard, History, MonitorPlay, Search, Settings as SettingsIcon, Star, Tv, type LucideIcon,
} from 'lucide-react';
import { useApp, type Route } from '@/state/store';
import { Tally, Tooltip } from '@/components/Primitives';
import './navrail.css';

interface NavItem { key: string; label: string; short?: string; Icon: LucideIcon; route: Route }

const GROUPS: NavItem[][] = [
  [
    { key: 'live', label: 'Live TV', Icon: Tv, route: { view: 'live' } },
    { key: 'movies', label: 'Movies', Icon: Clapperboard, route: { view: 'movies' } },
    { key: 'shows', label: 'TV Shows', Icon: MonitorPlay, route: { view: 'shows' } },
  ],
  [
    { key: 'search', label: 'Search', Icon: Search, route: { view: 'search', query: '' } },
    { key: 'favourites', label: 'Favourites', Icon: Star, route: { view: 'favourites' } },
    { key: 'continue', label: 'Continue Watching', short: 'Continue', Icon: History, route: { view: 'continue' } },
  ],
];

const SETTINGS: NavItem = { key: 'settings', label: 'Settings', Icon: SettingsIcon, route: { view: 'settings' } };

function activeKey(route: Route): string {
  switch (route.view) {
    case 'guide': return 'live';
    case 'detail':
      return route.item.kind === 'movie' ? 'movies' : route.item.kind === 'series' ? 'shows' : 'live';
    default: return route.view;
  }
}

function Item({ item, active, register, tip }: {
  item: NavItem;
  active: boolean;
  register: (key: string, el: HTMLElement | null) => void;
  tip?: string;
}) {
  const button = (
    <button
      ref={(el) => { register(item.key, el); }}
      className="navrail__item"
      data-active={active}
      aria-current={active ? 'page' : undefined}
      aria-label={tip}
      onClick={() => useApp.getState().navigate(item.route)}
    >
      <item.Icon className="navrail__icon" size={20} strokeWidth={1.5} />
      <span className="navrail__label">{item.short ?? item.label}</span>
    </button>
  );
  return tip ? <Tooltip label={tip} placement="right">{button}</Tooltip> : button;
}

export function NavRail() {
  const route = useApp((s) => s.route);
  const active = activeKey(route);

  const railRef = useRef<HTMLElement>(null);
  const items = useRef(new Map<string, HTMLElement>());
  const [offset, setOffset] = useState<number | null>(null);
  const [primed, setPrimed] = useState(false);

  const register = useCallback((key: string, el: HTMLElement | null): void => {
    if (el) items.current.set(key, el); else items.current.delete(key);
  }, []);

  const measure = useCallback((): void => {
    const el = items.current.get(active);
    const rail = railRef.current;
    if (!el || !rail) { setOffset(null); return; }
    setOffset(el.getBoundingClientRect().top - rail.getBoundingClientRect().top);
  }, [active]);

  useLayoutEffect(measure, [measure]);
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const ro = new ResizeObserver(measure);
    ro.observe(rail);
    return () => ro.disconnect();
  }, [measure]);
  useEffect(() => { if (offset !== null) setPrimed(true); }, [offset]);

  return (
    <nav ref={railRef} className="navrail" aria-label="Sections">
      {offset !== null && (
        <span className="navrail__marker" data-primed={primed} style={{ transform: `translateY(${offset}px)` }}>
          <Tally />
        </span>
      )}

      <div className="navrail__groups">
        {GROUPS.map((group, i) => (
          <div className="navrail__group" key={i}>
            {i > 0 && <span className="navrail__rule" aria-hidden />}
            {group.map((item) => (
              <Item
                key={item.key}
                item={item}
                active={active === item.key}
                register={register}
                tip={item.short && item.label}
              />
            ))}
          </div>
        ))}
      </div>

      <div className="navrail__foot">
        <span className="navrail__rule" aria-hidden />
        <Item item={SETTINGS} active={active === SETTINGS.key} register={register} />
      </div>
    </nav>
  );
}
