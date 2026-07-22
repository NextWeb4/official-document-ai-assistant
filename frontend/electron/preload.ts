/*
 * This file is part of HaoXiang Document Assistant.
 * Licensed under the MIT License. See the LICENSE file for details.
 */
/**
 * Electron Preload Script
 *
 * 通过 contextBridge 暴露安全的 IPC 接口给渲染进程。
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // App info
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  getBackendStatus: () => ipcRenderer.invoke('get-backend-status'),
  getApiBaseUrl: () => ipcRenderer.invoke('get-api-base-url'),

  // Platform helpers
  platform: process.platform,
  isElectron: true,
});
