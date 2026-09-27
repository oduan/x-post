'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('xpost', {
  // 分页读取：{view:'timeline'|'user', userId?, cursor?, limit?} → {items, nextCursor, total}
  pageTweets: (q) => ipcRenderer.invoke('tweets:page', q),
  deleteTweet: (id) => ipcRenderer.invoke('tweets:delete', id),
  getConfig: () => ipcRenderer.invoke('config:get'),
  chooseDataDir: () => ipcRenderer.invoke('config:chooseDir'),
  openDataDir: () => ipcRenderer.invoke('data:openDir'),
  openExternal: (url) => ipcRenderer.invoke('sys:openExternal', url),
  // 网络检测：访问 Google 连通性端点，{ok:true, latencyMs} | {ok:false, error}
  checkNetwork: () => ipcRenderer.invoke('net:check'),
  // 浏览器扩展：连接状态（{connected, version, lastSeenAt, dir}）与安装引导辅助
  getExtensionStatus: () => ipcRenderer.invoke('extension:status'),
  openExtensionDir: () => ipcRenderer.invoke('extension:openDir'),
  copyExtensionPath: () => ipcRenderer.invoke('extension:copyPath'),
  // 数据增量变化：{event:'upsert', tweet} | {event:'delete', id} | {event:'reload'}
  onChanged: (cb) => {
    ipcRenderer.on('tweets:changed', (_e, payload) => cb(payload));
  },
  // 应用内更新：{status:'idle'|'available'|'downloading'|'downloaded', version, progress, platform}
  onUpdateStatus: (cb) => {
    ipcRenderer.on('updater:status', (_e, s) => cb(s));
  },
  updateAction: () => ipcRenderer.invoke('updater:action'),
});
