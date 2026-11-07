// Gives the screens a few safe desktop functions (save PDF, save file, open WhatsApp…).
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('stockwell', {
  savePdf: (url: string, fileName: string) => ipcRenderer.invoke('savePdf', url, fileName),
  saveFile: (fileName: string, content: string) => ipcRenderer.invoke('saveFile', fileName, content),
  openExternal: (url: string) => ipcRenderer.invoke('openExternal', url),
  showInFolder: (file: string) => ipcRenderer.invoke('showInFolder', file),
  chooseFolder: () => ipcRenderer.invoke('chooseFolder'),
  connection: () => ipcRenderer.invoke('connection'),
  resetConnection: (token: string | null) => ipcRenderer.invoke('resetConnection', token),
  restore: (token: string | null, company: string | null) => ipcRenderer.invoke('restore', token, company),
});
