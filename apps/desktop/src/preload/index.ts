import { contextBridge, ipcRenderer } from 'electron';
import {
  INVOKE_CHANNEL,
  PUSH_CHANNEL,
  ipcChannels,
  type HiveBridge,
  type HivePush,
  type IpcResult,
} from '@hive/core';

const bridge: HiveBridge = {
  async invoke(channel, ...input) {
    if (!ipcChannels.includes(channel)) throw new Error('Canal IPC desconhecido.');
    const result: IpcResult<unknown> = await ipcRenderer.invoke(INVOKE_CHANNEL, channel, input[0]);
    if (!result.ok)
      throw Object.assign(new Error(result.error.message), { code: result.error.code });
    return result.value as never;
  },
  subscribe(listener) {
    const handler = (_event: Electron.IpcRendererEvent, push: HivePush) => listener(push);
    ipcRenderer.on(PUSH_CHANNEL, handler);
    return () => ipcRenderer.removeListener(PUSH_CHANNEL, handler);
  },
};
contextBridge.exposeInMainWorld('hive', bridge);
