import Navbar from './navbar';
import { ScreenRecorderBody } from './screen-recorder';

import './screen-recorder.css';

function ScreenRecorder() {
  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <Navbar />
      <div className="flex-1 min-h-0 relative">
        <ScreenRecorderBody />
      </div>
    </div>
  );
}

export default ScreenRecorder;
