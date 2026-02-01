import { ScreenRecorderBody } from './screen-recorder';

import './screen-recorder.css';

interface ScreenRecorderProps {
  onOpenEditor?: (recordingId: string) => void;
}

function ScreenRecorder({ onOpenEditor }: ScreenRecorderProps) {
  return (
    <div className="flex-1 min-h-0 relative h-full">
      <ScreenRecorderBody onOpenEditor={onOpenEditor} />
    </div>
  );
}

export default ScreenRecorder;
