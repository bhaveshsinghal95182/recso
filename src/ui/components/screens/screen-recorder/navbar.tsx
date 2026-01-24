import { X } from 'lucide-react';

import Minimize24Regular from '../../icons/minimize';

const Navbar = () => {
  const handleClose = () => {
    window.electron.window.close();
  };

  const handleHideToTray = () => {
    window.electron.window.hideToTray();
  };

  return (
    <nav className="naavbar bg-gray-700">
      <h1>Recso</h1>
      <div className="nav-buttons">
        <button className="tray-btn" onClick={handleHideToTray} title="Hide to Tray">
          <Minimize24Regular size="16" />
        </button>
        <button className="close-btn" onClick={handleClose} title="Close">
          <X size="16" />
        </button>
      </div>
    </nav>
  );
};

export default Navbar;
