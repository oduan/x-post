'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('xpost', {
  // 分页读取：{view:'timeline'|'user', userId?, cursor?, limit?} → {items, nextCursor, total}
  pageTweets: (q) => ipcRenderer.invoke('tweets:page', q),
  countTweets: (q) => ipcRenderer.invoke('tweets:count', q),
  deleteTweet: (id) => ipcRenderer.invoke('tweets:delete', id),
  getConfig: () => ipcRenderer.invoke('config:get'),
  chooseDataDir: () => ipcRenderer.invoke('config:chooseDir'),
  openDataDir: () => ipcRenderer.invoke('data:openDir'),
  openExternal: (url) => ipcRenderer.invoke('sys:openExternal', url),
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
