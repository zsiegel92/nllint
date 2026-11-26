import type {Mode, ReviewMode} from './api';
import {modes, reviewModes} from './navigation';

const labels: Record<Mode, string> = {
  files: 'File',
  ranges: 'Ranges',
  adjudication: 'Snippet Adjudication',
};

export function TableStages({selected, onChange}: {
  selected: Mode[]; onChange: (stages: Mode[]) => void;
}) {
  return <div className="segmented" role="group" aria-label="Table stages">
    {modes.map(stage => <button key={stage} type="button"
      aria-pressed={selected.includes(stage)} onClick={() => onChange(
        modes.filter(item => item === stage ? !selected.includes(item) : selected.includes(item))
      )}>{labels[stage]}</button>)}
  </div>;
}

export function ReviewStages({mode, onChange}: {
  mode: ReviewMode; onChange: (mode: ReviewMode) => void;
}) {
  return <div className="segmented" role="group" aria-label="Review stage">
    {reviewModes.map(stage => <button key={stage} type="button"
      aria-pressed={mode === stage} onClick={() => onChange(stage)}>{labels[stage]}</button>)}
  </div>;
}
