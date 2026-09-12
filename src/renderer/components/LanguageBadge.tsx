import type { MediaItem } from '@shared/types';
import { mediaLanguage } from '@shared/language';
import './language-badge.css';

export function LanguageBadge({ item, overlay = false }: { item: MediaItem; overlay?: boolean }) {
  const hint = mediaLanguage(item);
  if (!hint) return null;
  return (
    <span className={`language-badge${overlay ? ' language-badge--overlay' : ''}`} title={hint.description} aria-label={hint.description}>
      {hint.label}
    </span>
  );
}
