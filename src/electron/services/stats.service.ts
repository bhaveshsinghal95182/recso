/**
 * StatsService — quick overview:
 * - Provides real-time system statistics (CPU, RAM, storage usage).
 * - Used for the dashboard/monitoring UI.
 *
 * Key exports:
 *   getStatistics()  → Returns { cpu, ram, storage } percentages (async for CPU)
 *   getStaticData()  → Returns { totalStorage, cpuModel, totalRAM } (one-time info)
 */

import fs from 'fs';
import os from 'os';
import osUtils from 'os-utils';
export interface Statistics {
  cpu: number;
  ram: number;
  storage: number;
}

export interface StaticData {
  totalStorage: number;
  cpuModel: string;
  totalRAM: number;
}

export class StatsService {
  static async getStatistics(): Promise<Statistics> {
    const cpu = await this.getCPUUsage();
    const ram = this.getRAMUsage();
    const storage = this.getStorageUsage().usage;
    return { cpu, ram, storage };
  }

  static getStaticData(): StaticData {
    const totalStorage = this.getStorageUsage().total;
    const cpuModel = os.cpus()[0].model;
    const totalRAM = Math.floor(os.totalmem() / 1024);
    return { totalStorage, cpuModel, totalRAM };
  }

  private static getCPUUsage(): Promise<number> {
    return new Promise((resolve) => {
      osUtils.cpuUsage(resolve);
    });
  }

  private static getRAMUsage(): number {
    return 1 - osUtils.freememPercentage();
  }

  private static getStorageUsage(): { total: number; usage: number } {
    const stats = fs.statfsSync(process.platform === 'win32' ? 'C:\\' : '/');
    const total = stats.bsize * stats.blocks;
    const free = stats.bsize * stats.bfree;
    return {
      total: Math.floor(total / 1_000_000_000),
      usage: 1 - free / total,
    };
  }
}
