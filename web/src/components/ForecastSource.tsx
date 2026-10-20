import type { PregameEstimate } from '../../../engine/forecast.ts';
import { useChipTip } from './ui.tsx';

const descriptions = {
  saved: 'Forecast saved before kickoff, with its timestamp verified against the game schedule.',
  replay: 'Retrospective replay using earlier games and the current model, which is trained on completed seasons and weeks. Historical injury tags are unavailable. Not an out-of-sample accuracy measurement.',
  current: 'Current forecast; it can change until kickoff.',
};

export function ForecastSource({ source, savedAt }: { source: PregameEstimate['source'] | null; savedAt: number | null }) {
  if (!source) return null;
  const timestamp = savedAt === null ? '' : ` Saved ${new Date(savedAt).toLocaleString()}.`;
  const tip = useChipTip(`${descriptions[source]}${timestamp}`);
  return (
    <>
      <span {...tip.handlers} className="block text-[10px] font-medium leading-snug text-ink-3">{source === 'saved' ? 'Saved' : source === 'replay' ? 'Replay' : 'Current'}</span>
      {tip.node}
    </>
  );
}
