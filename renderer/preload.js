/**
 * renderer/preload.js
 * contextIsolation: true 환경에서 렌더러가 안전하게 쓸 수 있는 최소 API만 노출.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getStatus: () => ipcRenderer.invoke("get-status"),
});
