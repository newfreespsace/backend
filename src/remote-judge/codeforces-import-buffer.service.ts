/* eslint-disable no-await-in-loop -- Stage bounded pages without oversized SQL packets. */
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";

import { In, Not, Repository } from "typeorm";

import { CodeforcesImportBufferEntity } from "./codeforces-import-buffer.entity";
import { RemoteSubmission } from "./remote-judge.types";

@Injectable()
export class CodeforcesImportBufferService {
  constructor(
    @InjectRepository(CodeforcesImportBufferEntity)
    private readonly entries: Repository<CodeforcesImportBufferEntity>
  ) {}

  async discard(accountId: number): Promise<void> {
    await this.entries.delete({ accountId });
  }

  async stage(accountId: number, batch: string, submissions: RemoteSubmission[]): Promise<void> {
    // A reset (new problem, new credentials, or an interrupted old scan) abandons the previous batch.
    await this.entries.delete({ accountId, batch: Not(batch) });
    for (const row of submissions) {
      if (
        !/^\d+$/.test(row.id) ||
        !Number.isSafeInteger(Number(row.id)) ||
        Number(row.id) <= 0 ||
        !Number.isSafeInteger(row.submittedAt) ||
        row.submittedAt <= 0
      )
        continue;
      await this.entries.upsert(
        {
          accountId,
          batch,
          remoteId: row.id,
          submittedAt: row.submittedAt,
          problemKey: `${row.contestId}:${row.taskId}`,
          payload: row
        },
        ["accountId", "batch", "remoteId"]
      );
    }
  }

  async read(accountId: number, batch: string) {
    const rows = await this.entries.find({
      where: { accountId, batch },
      order: { submittedAt: "ASC", remoteId: "ASC" },
      select: ["remoteId", "payload"],
      take: 101
    });
    const page = rows.slice(0, 100);
    return {
      submissions: page.map(row => row.payload),
      more: rows.length > 100,
      // Failed imports retain the page. Ordinary submission keys make retries idempotent.
      acknowledge: async () => {
        if (page.length) await this.entries.delete({ accountId, batch, remoteId: In(page.map(row => row.remoteId)) });
      }
    };
  }
}
