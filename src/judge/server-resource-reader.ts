import { readFile } from "fs/promises";
import os from "os";

export interface ResourceCounters {
  total: number;
  idle: number;
  memoryTotalBytes: number;
  memoryUsedBytes: number;
}

export function parseLinuxResources(stat: string, meminfo: string): ResourceCounters {
  const cpu = stat
    .match(/^cpu\s+(.+)$/m)?.[1]
    .trim()
    .split(/\s+/)
    .map(Number);
  const memory = (name: string) => Number(meminfo.match(new RegExp(`^${name}:\\s+(\\d+)`, "m"))?.[1]) * 1024;
  const memoryTotalBytes = memory("MemTotal");
  const available = memory("MemAvailable");
  // guest/guest_nice are already included in user/nice. iowait is counted as idle.
  if (
    !cpu ||
    cpu.length < 4 ||
    cpu.some(value => !Number.isFinite(value)) ||
    !Number.isFinite(available) ||
    !(memoryTotalBytes > 0)
  )
    throw new Error("Invalid system resource counters");
  return {
    total: cpu.slice(0, 8).reduce((sum, value) => sum + value, 0),
    idle: cpu[3] + (cpu[4] || 0),
    memoryTotalBytes,
    memoryUsedBytes: Math.max(0, Math.min(memoryTotalBytes, memoryTotalBytes - available))
  };
}

export function cpuUsage(previous: ResourceCounters | null, current: ResourceCounters): number | null {
  if (!previous) return null;
  const total = current.total - previous.total;
  const idle = current.idle - previous.idle;
  return total > 0 && idle >= 0 && idle <= total ? (1 - idle / total) * 100 : null;
}

export async function readServerResources(): Promise<ResourceCounters> {
  if (process.platform === "linux") {
    const [stat, meminfo] = await Promise.all([readFile("/proc/stat", "utf8"), readFile("/proc/meminfo", "utf8")]);
    return parseLinuxResources(stat, meminfo);
  }
  const cpus = os.cpus();
  if (!cpus.length) throw new Error("CPU counters unavailable");
  const memoryTotalBytes = os.totalmem();
  return {
    total: cpus.reduce(
      (sum, cpu) => sum + Object.values(cpu.times).reduce((subtotal, value) => subtotal + value, 0),
      0
    ),
    idle: cpus.reduce((sum, cpu) => sum + cpu.times.idle, 0),
    memoryTotalBytes,
    memoryUsedBytes: Math.max(0, memoryTotalBytes - os.freemem())
  };
}
