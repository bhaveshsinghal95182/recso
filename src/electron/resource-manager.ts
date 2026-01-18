import fs from 'fs';
import os from 'os';
import osUtils from 'os-utils';

const POLLING_INTERVAL = 500;

export function pollResources() {
  setInterval(async () => {
    const CPUUsage = await getCPUUsage();
    const RAMUsage = getRAMUsage();
    const storageData = getStorageUsage();
    console.log(`cpu: ${CPUUsage}, ram: ${RAMUsage}, storage: ${storageData.usage}`);
  }, POLLING_INTERVAL);
}

export function getStaticData() {
  const totalStorage = getStorageUsage().total;
  const cpuModel = os.cpus()[0].model;
  const totalRAM = Math.floor(os.totalmem() / 1024);

  return {
    totalStorage,
    cpuModel,
    totalRAM,
  };
}

function getCPUUsage() {
  return new Promise((resolve) => {
    osUtils.cpuUsage(resolve);
  });
}

function getRAMUsage() {
  return 1 - osUtils.freememPercentage();
}

function getStorageUsage() {
  const stats = fs.statfsSync(process.platform === 'win32' ? 'C:\\' : '/');
  const total = stats.bsize * stats.blocks;
  const free = stats.bsize * stats.bfree;
  return {
    total: Math.floor(total / 1_000_000_000),
    usage: 1 - free / total,
  };
}
