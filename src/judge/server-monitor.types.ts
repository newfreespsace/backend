export interface ServerResourceSample {
  at: number;
  cpuPercent: number | null;
  memoryPercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
}

export interface ServerMonitorSnapshot {
  unavailable: boolean;
  bucketSeconds: number;
  servers: {
    id: string;
    latest: ServerResourceSample;
    points: { at: number; cpuPercent: number | null; memoryPercent: number | null }[];
  }[];
}

export function aggregateServerSamples(
  samples: ServerResourceSample[],
  now: number,
  hours: number
): ServerMonitorSnapshot["servers"][number]["points"] {
  const width = (hours === 1 ? 10 : hours === 6 ? 60 : 120) * 1000;
  const start = Math.floor((now - hours * 3600000) / width) * width;
  const buckets = new Map<number, ServerResourceSample[]>();
  for (const sample of samples) {
    const at = Math.floor(sample.at / width) * width;
    if (at < start || sample.at > now) continue;
    if (!buckets.has(at)) buckets.set(at, []);
    buckets.get(at).push(sample);
  }
  const points: ServerMonitorSnapshot["servers"][number]["points"] = [];
  for (let at = start; at <= now; at += width) {
    const rows = buckets.get(at) || [];
    const cpu = rows.filter(row => row.cpuPercent !== null);
    points.push({
      at,
      cpuPercent: cpu.length ? cpu.reduce((sum, row) => sum + row.cpuPercent, 0) / cpu.length : null,
      memoryPercent: rows.length ? rows.reduce((sum, row) => sum + row.memoryPercent, 0) / rows.length : null
    });
  }
  return points;
}
