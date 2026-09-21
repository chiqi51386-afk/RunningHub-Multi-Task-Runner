const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("runningHub", {
  accounts: {
    list: () => ipcRenderer.invoke("accounts:list"),
    add: input => ipcRenderer.invoke("accounts:add", input),
    updateKey: input => ipcRenderer.invoke("accounts:updateKey", input),
    refresh: id => ipcRenderer.invoke("accounts:refresh", id),
    refreshAll: () => ipcRenderer.invoke("accounts:refreshAll"),
    setEnabled: (id, enabled) => ipcRenderer.invoke("accounts:setEnabled", id, enabled),
    remove: id => ipcRenderer.invoke("accounts:remove", id),
  },
  workflows: {
    list: () => ipcRenderer.invoke("workflows:list"),
    importApiJson: input => ipcRenderer.invoke("workflows:import", input),
    importPortablePackage: input => ipcRenderer.invoke("workflows:importPortable", input),
    exportPackage: id => ipcRenderer.invoke("workflows:export", id),
    updateProfile: input => ipcRenderer.invoke("workflows:update", input),
    remove: id => ipcRenderer.invoke("workflows:remove", id),
  },
  media: {
    select: type => ipcRenderer.invoke("media:select", type),
    fromDroppedFile: file => {
      const localPath = webUtils.getPathForFile(file);
      if (!localPath) throw new Error("无法读取拖入文件的本地路径。");
      return ipcRenderer.invoke("media:fromDroppedPath", localPath);
    },
  },
  jobs: {
    list: () => ipcRenderer.invoke("jobs:list"),
    create: input => ipcRenderer.invoke("jobs:create", input),
    createBatch: inputs => ipcRenderer.invoke("jobs:createBatch", inputs),
    cancel: id => ipcRenderer.invoke("jobs:cancel", id),
    remove: id => ipcRenderer.invoke("jobs:remove", id),
  },
  downloads: {
    directory: () => ipcRenderer.invoke("downloads:directory"),
    openDirectory: () => ipcRenderer.invoke("downloads:openDirectory"),
    selectDirectory: () => ipcRenderer.invoke("downloads:selectDirectory"),
    resetDirectory: () => ipcRenderer.invoke("downloads:resetDirectory"),
    reveal: localPath => ipcRenderer.invoke("downloads:reveal", localPath),
  },
  scheduler: {
    start: () => ipcRenderer.invoke("scheduler:start"),
    stop: () => ipcRenderer.invoke("scheduler:stop"),
  },
  external: {
    openApiKeys: () => ipcRenderer.invoke("external:openApiKeys"),
  },
});
