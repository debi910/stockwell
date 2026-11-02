// Gives the screens a few safe desktop functions (save PDF, save file, open WhatsApp…).
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('stockwell', {
  savePdf: (url: string, fileName: string) => ipcRenderer.invoke('savePdf', url, fileName),
  saveFile: (fileName: string, content: string) => ipcRenderer.invoke('saveFile', fileName, content),
  openExternal: (url: string) => ipcRenderer.invoke('openExternal', url),
  showInFolder: (file: string) => ipcRenderer.invoke('showInFolder', file),
  chooseFolder: () => ipcRenderer.invoke('chooseFolder'),
  connection: () => ipcRenderer.invoke('connection'),
  resetConnection: () => ipcRenderer.invoke('resetConnection'),
});

contextBridge.exposeInMainWorld('stockwellSetup', {
  lan: () => ipcRenderer.invoke('setup:lan'),
  test: (address: string) => ipcRenderer.invoke('setup:test', address),
  choose: (mode: 'main' | 'client', address?: string) => ipcRenderer.invoke('setup:choose', mode, address),
});
