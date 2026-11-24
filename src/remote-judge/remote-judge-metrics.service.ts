import { Injectable } from "@nestjs/common";

import { MetricsService } from "@/metrics/metrics.service";
import { RedisService } from "@/redis/redis.service";

import { SubmissionMethod } from "./remote-judge.types";

const RESULT_SAMPLE_WINDOW_MS = 10 * 60000;
type SyncStage = "queue_wait" | "upstream_observation" | "observation_to_save" | "save_to_foreground";

export function recentResultRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value <= Date.now() && value > Date.now() - RESULT_SAMPLE_WINDOW_MS;
}

@Injectable()
export class RemoteJudgeMetricsService {
  constructor(private readonly metrics: MetricsService, private readonly redis: RedisService) {}

  private readonly duration = this.metrics.histogram(
    "nsoj_remote_judge_stage_duration_seconds",
    [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600],
    ["platform", "stage"]
  );

  observe(platform: SubmissionMethod, stage: SyncStage, from: number, to: number): void {
    if (Number.isFinite(from) && from > 0 && Number.isFinite(to) && to >= from)
      this.duration.labels(platform, stage).observe((to - from) / 1000);
  }

  async recordForeground(platform: SubmissionMethod, id: number, revision: number): Promise<void> {
    const now = Date.now();
    try {
      const first = await this.redis
        .getSharedClient()
        .set(`remote-result-foreground:${id}:${revision}`, "1", "PX", RESULT_SAMPLE_WINDOW_MS, "NX");
      if (first) this.observe(platform, "save_to_foreground", revision, now);
    } catch {
      // Metrics never affect result synchronization or the user's page.
    }
  }
}
