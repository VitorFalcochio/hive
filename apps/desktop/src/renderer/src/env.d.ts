import type { HiveBridge } from '@hive/core';
declare global {
  interface Window {
    hive: HiveBridge;
  }
}
