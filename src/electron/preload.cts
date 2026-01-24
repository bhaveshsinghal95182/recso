const electron = require('electron');

electron.contextBridge.exposeInMainWorld('electron', {
  subscribeStatistics: (callback: (statisctics: unknown) => void) => callback({}),
  getStaticData: () => console.log('static'),
});
