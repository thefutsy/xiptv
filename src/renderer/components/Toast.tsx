import { CircleAlert, Info } from 'lucide-react';
import { useApp } from '@/state/store';
import './toast.css';

export function Toast() {
  const toast = useApp((s) => s.toast);
  const casting = useApp((s) => s.cast.connected);
  const playing = useApp((s) => !!s.nowPlaying);
  if (!toast) return null;

  const Glyph = toast.tone === 'error' ? CircleAlert : Info;
  return (
    <div
      key={toast.message}
      className="toast"
      data-tone={toast.tone}
      data-castbar={casting}
      data-playing={playing || undefined}
      role="status"
      aria-live="polite"
      onClick={() => useApp.getState().patch({ toast: undefined })}
    >
      <Glyph className="toast__glyph" size={14} strokeWidth={1.5} />
      <span className="toast__message sm">{toast.message}</span>
    </div>
  );
}
