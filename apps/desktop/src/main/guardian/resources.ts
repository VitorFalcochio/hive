import { statfs } from 'node:fs/promises';
import os from 'node:os';
import { app } from 'electron';
import type { ResourceUsage } from '@hive/core';

const MB = 1024 * 1024;

/**
 * What Hive and the computer use right now: every Hive process (main, windows, GPU, helpers)
 * from Electron's own metrics, free memory from the system, free disk where the data lives.
 */
export async function collectResources(dataDir: string): Promise<ResourceUsage> {
  const metrics = app.getAppMetrics();
  const processes = metrics.map((metric) => ({
    type: metric.type,
    pid: metric.pid,
    cpuPercent: Math.round(metric.cpu.percentCPUUsage * 10) / 10,
    // Electron reports the working set in kilobytes.
    memoryMb: Math.round(metric.memory.workingSetSize / 1024),
  }));
  let diskFreeMb: number | null = null;
  try {
    const disk = await statfs(dataDir);
    diskFreeMb = Math.round((Number(disk.bavail) * Number(disk.bsize)) / MB);
  } catch {
    // Some systems do not say; the check then skips the disk.
  }
  return {
    cpuPercent: processes.reduce((sum, item) => sum + item.cpuPercent, 0),
    memoryMb: processes.reduce((sum, item) => sum + item.memoryMb, 0),
    processes,
    systemFreeMb: Math.round(os.freemem() / MB),
    systemTotalMb: Math.round(os.totalmem() / MB),
    diskFreeMb,
  };
}
