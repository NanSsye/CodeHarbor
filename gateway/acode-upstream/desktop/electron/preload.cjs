const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codeharborDesktop", {
  getState: () => ipcRenderer.invoke("desktop:get-state"),
  saveSettings: (settings) => ipcRenderer.invoke("desktop:save-settings", settings),
  openWorkspace: () => ipcRenderer.invoke("desktop:open-workspace"),
  openRegister: () => ipcRenderer.invoke("desktop:open-register"),
  logoutRelay: () => ipcRenderer.invoke("desktop:logout-relay"),
  openLogs: () => ipcRenderer.invoke("desktop:open-logs"),
  restartGateway: () => ipcRenderer.invoke("desktop:restart-gateway"),
  stopGateway: () => ipcRenderer.invoke("desktop:stop-gateway"),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("desktop:state", listener);
    return () => ipcRenderer.removeListener("desktop:state", listener);
  }
});
