import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, Delete, ListFilter } from 'lucide-react';
import type { Category, MediaKind } from '@shared/types';
import { useApp, type Route } from '@/state/store';
import { Button, CategoryLabel, Skeleton, Tally } from '@/components/Primitives';
import {
  EMPTY_FACETS, activeFacetCount, deriveDecades, deriveGenres, fold, isAdultCategory, parseCategory,
  toggleIn, type Facets,
} from '@/lib/catalog';
import { VList } from '@/lib/virtual';
import { useUiPrefs } from '@/views/Settings';
import './context.css';

const ROW_H = 34;
const QUALITY_TAGS = ['4K', 'FHD', 'HD'];
const RATING_STEPS = [{ label: '7.5+', value: 7.5 }, { label: '6.5+', value: 6.5 }, { label: 'Any', value: 0 }];

function kindFor(view: Route['view']): MediaKind | undefined {
  if (view === 'live') return 'live';
  if (view === 'movies') return 'movie';
  if (view === 'shows') return 'series';
  return undefined;
}

const inFlight = new Set<string>();

function patchFacets(patch: Partial<Facets>): void {
  const app = useApp.getState();
  app.patch({ facets: { ...app.facets, ...patch } });
}

function Label({ category, query }: { category: Category; query: string }) {
  if (!query) return <CategoryLabel category={category} />;
  const parsed = parseCategory(category);
  const lower = parsed.label.toLowerCase();
  const needle = query.toLowerCase();
  // A lowercase mapping that changes length would slice the wrong run, so guard the index.
  const at = lower.length === parsed.label.length ? lower.indexOf(needle) : -1;
  if (at < 0) return <CategoryLabel category={category} />;
  return (
    <span className="catlabel">
      {parsed.chips.map((chip) => <span key={chip} className="chip micro">{chip}</span>)}
      <span className="truncate" dir="auto">
        {parsed.label.slice(0, at)}
        <mark className="context__hit">{parsed.label.slice(at, at + needle.length)}</mark>
        {parsed.label.slice(at + needle.length)}
      </span>
    </span>
  );
}

function FacetPanel() {
  const items = useApp((s) => s.items);
  const facets = useApp((s) => s.facets);
  const [open, setOpen] = useState(false);

  const genres = useMemo(() => deriveGenres(items), [items]);
  const decades = useMemo(() => deriveDecades(items), [items]);
  const qualities = useMemo(
    () => QUALITY_TAGS.filter((tag) => items.some((i) => i.name.toUpperCase().includes(tag))),
    [items],
  );
  const rated = useMemo(() => items.some((i) => (i.rating ?? 0) > 0), [items]);

  const active = activeFacetCount(facets);

  if (!genres.length && !decades.length && !qualities.length && !rated) return null;

  return (
    <div className="context__facets" data-open={open}>
      <button className="context__facet-head" onClick={() => setOpen(!open)}>
        <ListFilter size={14} strokeWidth={1.5} />
        <span className="context__facet-title sm">Filters</span>
        {active > 0 && <span className="context__badge">{active}</span>}
        <ChevronDown className="context__chev" size={14} strokeWidth={1.5} data-open={open} />
      </button>

      {open && (
        <div className="context__facet-body">
          {genres.length > 0 && (
            <section className="context__group">
              <h3 className="context__group-title">Genre</h3>
              <div className="context__checks">
                {genres.map((genre) => {
                  const on = facets.genres.includes(genre);
                  return (
                    <button
                      key={genre}
                      className="context__check"
                      data-on={on}
                      onClick={() => patchFacets({ genres: toggleIn(facets.genres, genre) })}
                    >
                      <span className="context__box">{on && <Check size={10} strokeWidth={2.5} />}</span>
                      <span className="truncate sm">{genre}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {decades.length > 0 && (
            <section className="context__group">
              <h3 className="context__group-title">Year</h3>
              <div className="context__chips">
                {decades.map((decade) => (
                  <button
                    key={decade}
                    className="context__chip"
                    data-on={facets.years.includes(decade)}
                    onClick={() => patchFacets({ years: toggleIn(facets.years, decade) })}
                  >
                    {decade}s
                  </button>
                ))}
              </div>
            </section>
          )}

          {rated && (
            <section className="context__group">
              <h3 className="context__group-title">Rating</h3>
              <div className="context__chips">
                {RATING_STEPS.map((step) => (
                  <button
                    key={step.label}
                    className="context__chip"
                    data-on={facets.minRating === step.value}
                    onClick={() => patchFacets({ minRating: step.value })}
                  >
                    {step.label}
                  </button>
                ))}
              </div>
            </section>
          )}

          {qualities.length > 0 && (
            <section className="context__group">
              <h3 className="context__group-title">Quality</h3>
              <div className="context__chips">
                {qualities.map((tag) => (
                  <button
                    key={tag}
                    className="context__chip"
                    data-on={facets.qualities.includes(tag)}
                    onClick={() => patchFacets({ qualities: toggleIn(facets.qualities, tag) })}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            </section>
          )}

          {active > 0 && (
            <Button variant="ghost" className="context__clear" onClick={() => useApp.getState().patch({ facets: EMPTY_FACETS })}>
              Clear all
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function ContextColumn() {
  const route = useApp((s) => s.route);
  const categories = useApp((s) => s.categories);
  const selected = useApp((s) => s.selectedCategory);
  const query = useApp((s) => s.categoryFilter);
  const activeSourceId = useApp((s) => s.activeSourceId);
  const { hideAdult } = useUiPrefs();

  const kind = kindFor(route.view);
  const all = kind ? categories[kind] : undefined;

  useEffect(() => {
    if (!kind || !activeSourceId || all) return;
    const key = `${activeSourceId}:${kind}`;
    if (inFlight.has(key)) return;
    inFlight.add(key);
    window.iptv.catalog.categories(activeSourceId, kind)
      .then((list) => {
        const app = useApp.getState();
        app.patch({ categories: { ...app.categories, [kind]: list } });
      })
      .catch(() => {
        const app = useApp.getState();
        app.patch({ categories: { ...app.categories, [kind]: [] } });
        app.toast$('Could not load categories for this source.', 'error');
      })
      .finally(() => inFlight.delete(key));
  }, [kind, activeSourceId, all]);

  useEffect(() => { useApp.getState().patch({ categoryFilter: '' }); }, [kind]);

  const listed = useMemo(
    () => (all ?? []).filter((c) => !hideAdult || !isAdultCategory(c)),
    [all, hideAdult],
  );
  const foldedNames = useMemo(() => listed.map((c) => fold(c.name)), [listed]);
  const visible = useMemo(() => {
    const needle = fold(query.trim());
    return needle ? listed.filter((_, i) => foldedNames[i].includes(needle)) : listed;
  }, [listed, foldedNames, query]);

  if (!kind) return null;

  const chosen = selected[kind];
  const select = (id: string): void => {
    const app = useApp.getState();
    const next = chosen === id ? undefined : id;
    app.patch({ selectedCategory: { ...app.selectedCategory, [kind]: next }, facets: EMPTY_FACETS });
  };

  return (
    <aside className="context" aria-label="Categories">
      <div className="context__head">
        <div className="context__field">
          <input
            className="context__input sm"
            value={query}
            spellCheck={false}
            placeholder={listed.length ? `Filter ${listed.length.toLocaleString()} categories` : 'Filter categories'}
            onChange={(e) => useApp.getState().patch({ categoryFilter: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.stopPropagation();
                useApp.getState().patch({ categoryFilter: '' });
              }
            }}
          />
          {query && (
            <button
              className="context__clear-glyph"
              aria-label="Clear filter"
              onClick={() => useApp.getState().patch({ categoryFilter: '' })}
            >
              <Delete size={13} strokeWidth={1.5} />
            </button>
          )}
        </div>
      </div>

      {!all ? (
        <div className="context__loading">
          {Array.from({ length: 14 }, (_, i) => (
            <div className="context__skel" key={i}>
              <Skeleton height={10} width={`${52 + ((i * 37) % 38)}%`} radius={3} />
            </div>
          ))}
        </div>
      ) : visible.length === 0 ? (
        <p className="context__empty sm t-tertiary">
          {query ? 'No categories match that filter.' : 'This source listed no categories.'}
        </p>
      ) : (
        <VList className="context__list" count={visible.length} rowHeight={ROW_H}>
          {(index) => {
            const category = visible[index];
            const isSelected = category.id === chosen;
            return (
              <button className="context__row" data-selected={isSelected} onClick={() => select(category.id)}>
                {isSelected && <Tally />}
                <span className="context__label sm">
                  <Label category={category} query={query.trim()} />
                </span>
                {category.count !== undefined && (
                  <span className="context__count">{category.count.toLocaleString()}</span>
                )}
              </button>
            );
          }}
        </VList>
      )}

      <FacetPanel />
    </aside>
  );
}
