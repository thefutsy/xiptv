import { ShaderBackground } from '@/components/ui/adisyon-shader';
import { useApp } from '@/state/store';
import { reducedMotion } from '@/lib/ease';
import './backdrop.css';

export function ShaderBackdrop() {
  const accelerated = useApp((s) => s.settings.hardwareAcceleration);
  if (!accelerated) return null;
  return (
    <div className="backdrop" aria-hidden="true">
      {/* The field drifts continuously, so under reduced motion its still gradient stands in. */}
      <div className="backdrop__field">{reducedMotion() ? null : <ShaderBackground />}</div>
      <div className="backdrop__scrim" />
    </div>
  );
}
