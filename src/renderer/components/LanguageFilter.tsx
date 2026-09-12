import { LANGUAGE_OPTIONS } from '@shared/language';
import './language-filter.css';

export function LanguageFilter({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <label className="language-filter">
      <span>Language</span>
      <select aria-label="Language" value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">All languages</option>
        {LANGUAGE_OPTIONS.map((language) => <option key={language}>{language}</option>)}
        <option>Multi-audio</option>
        <option>Dual audio</option>
        <option value="unknown">Unknown language</option>
      </select>
    </label>
  );
}
