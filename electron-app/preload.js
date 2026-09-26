'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('xpost', {
  listTweets: () => ipcRenderer.invoke('tweets:list'),
  deleteTweet: (id) => ipcRenderer.invoke('tweets:delete', id),
  getConfig: () => ipcRenderer.invoke('config:get'),
  chooseDataDir: () => ipcRenderer.invoke('config:chooseDir'),
  openDataDir: () => ipcRenderer.invoke('data:openDir'),
  openExternal: (url) => ipcRenderer.invoke('sys:openExternal', url),
  onChanged: (cb) => {
    ipcRenderer.on('tweets:changed', () => cb());
  },
});
