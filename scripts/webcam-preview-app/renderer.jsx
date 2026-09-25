import React from 'react';
import { createRoot } from 'react-dom/client';

import { ScreenRecorderBody } from '../../src/ui/screens/screen-recorder/screen-recorder';
import '../../src/ui/index.css';

// Count actual paints, not IPC responses. The test also checks canvas pixels
// and the placeholder so a disconnected frame-to-UI path fails this check.
window.previewPaintCount = 0;
const drawImage = CanvasRenderingContext2D.prototype.drawImage;
CanvasRenderingContext2D.prototype.drawImage = function (...args) {
  window.previewPaintCount += 1;
  return drawImage.apply(this, args);
};

createRoot(document.getElementById('root')).render(
  React.createElement(React.StrictMode, null, React.createElement(ScreenRecorderBody)),
);
