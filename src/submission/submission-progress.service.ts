import { Injectable } from "@nestjs/common";

import { Redis } from "ioredis";

import { logger } from "@/logger";
import { RedisService } from "@/redis/redis.service";

import { SubmissionProgress, SubmissionProgressType } from "./submission-progress.interface";
import { SubmissionProgressGateway } from "./submission-progress.gateway";

export enum SubmissionEventType {
  Progress,
  Canceled,
  Deleted
}

const REDIS_KEY_SUBMISSION_PROGRESS = "submission-progress:%d";
const REDIS_KEY_SUBMISSION_FIRST_ACCEPTED = "submission-first-accepted:%d";
const REDIS_CHANNEL_SUBMISSION_EVENT = "submission-event";
const FIRST_ACCEPTED_MARKER_RETENTION_SECONDS = 5 * 60;

// The process for after a progress received:
// 1. If its type is "Finished", it's converted to a "result" and stored to the database,
//    anything related to the submission will be updated, its previous progress will be removed from Redis.
//    Otherwise (non-finished) the progress is stored to Redis.
// 2. A message is published to other all nodes to tell all nodes about the progress.
// 3. Once a cluster recived the Redis message of progress, it will lookup for its clients who has subscribed
//    the submission's progress and send them the progress via WebSocket.
@Injectable()
export class SubmissionProgressService {
  private readonly redisForSubscribe: Redis;

  private readonly redis: Redis;

  constructor(
    private readonly redisService: RedisService,
    private readonly submissionProgressGateway: SubmissionProgressGateway
  ) {
    this.redis = this.redisService.getClient();
    this.redisForSubscribe = this.redisService.getClient();

    this.redisForSubscribe.on("message", (channel: string, message: string) => {
      const { submissionId, type, progress } = JSON.parse(message);
      this.onSubmissionEvent(submissionId, type, progress);
    });
    this.redisForSubscribe.subscribe(REDIS_CHANNEL_SUBMISSION_EVENT);
  }

  private async onSubmissionEvent(submissionId: number, type: SubmissionEventType, progress?: SubmissionProgress) {
    logger.log(`Consume event for submission ${submissionId}`);
    this.submissionProgressGateway.onSubmissionEvent(submissionId, type, progress);
  }

  // If the progress type is "Finished", this method is called after the progress
  // result is stored in the database.
  async emitSubmissionEvent(
    submissionId: number,
    type: SubmissionEventType,
    progress?: SubmissionProgress
  ): Promise<void> {
    logger.log(`Progress for submission ${submissionId} received, pushing to Redis`);
    if (type === SubmissionEventType.Progress && progress.progressType !== SubmissionProgressType.Finished) {
      await this.redis.del(REDIS_KEY_SUBMISSION_FIRST_ACCEPTED.format(submissionId));
      await this.redis.set(REDIS_KEY_SUBMISSION_PROGRESS.format(submissionId), JSON.stringify(progress));
    } else if (type === SubmissionEventType.Progress) {
      // Keep the UI-only first-accept marker briefly so a result that finishes before
      // the detail page/WebSocket connects can still be delivered without persisting it.
      await this.redis.del(REDIS_KEY_SUBMISSION_PROGRESS.format(submissionId));
      await this.redis.setex(
        REDIS_KEY_SUBMISSION_FIRST_ACCEPTED.format(submissionId),
        FIRST_ACCEPTED_MARKER_RETENTION_SECONDS,
        progress.isFirstAccepted ? "1" : "0"
      );
    } else {
      await this.redis.del(
        REDIS_KEY_SUBMISSION_PROGRESS.format(submissionId),
        REDIS_KEY_SUBMISSION_FIRST_ACCEPTED.format(submissionId)
      );
    }

    // This will call this.onSubmissionEvent
    await this.redis.publish(
      REDIS_CHANNEL_SUBMISSION_EVENT,
      JSON.stringify({
        submissionId,
        type,
        progress
      })
    );
  }

  async getPendingSubmissionProgress(submissionId: number): Promise<SubmissionProgress> {
    const str = await this.redis.get(REDIS_KEY_SUBMISSION_PROGRESS.format(submissionId));
    try {
      return JSON.parse(str);
    } catch (e) {
      return null;
    }
  }

  async getRecentlyFinishedFirstAccepted(submissionId: number): Promise<boolean | null> {
    const marker = await this.redis.get(REDIS_KEY_SUBMISSION_FIRST_ACCEPTED.format(submissionId));
    return marker == null ? null : marker === "1";
  }
}
