import { ShaderBackground } from '@/components/ui/adisyon-shader';
import { useApp } from '@/state/store';
import './backdrop.css';

export function ShaderBackdrop() {
  const accelerated = useApp((s) => s.settings.hardwareAcceleration);
  if (!accelerated) return null;
  return (
    <div className="backdrop" aria-hidden="true">
      <div className="backdrop__field"><ShaderBackground /></div>
      <div className="backdrop__scrim" />
    </div>
  );
}
