// Functions for the first-run setup page only (choose main PC or second PC).
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('stockwellSetup', {
  lan: () => ipcRenderer.invoke('setup:lan'),
  test: (address: string) => ipcRenderer.invoke('setup:test', address),
  choose: (mode: 'main' | 'client', address?: string) => ipcRenderer.invoke('setup:choose', mode, address),
});
