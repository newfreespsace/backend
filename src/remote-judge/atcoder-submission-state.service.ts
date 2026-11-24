import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Repository } from "typeorm";

import { AtcoderSubmissionStateEntity } from "./atcoder-submission-state.entity";

@Injectable()
export class AtcoderSubmissionStateService {
  constructor(
    @InjectRepository(AtcoderSubmissionStateEntity)
    private readonly submissions: Repository<AtcoderSubmissionStateEntity>
  ) {}

  async pendingContests(accountId: number): Promise<string[]> {
    const rows = await this.submissions
      .createQueryBuilder("state")
      .select("DISTINCT state.contestId", "contestId")
      .where("state.accountId = :accountId AND state.pending = 1", { accountId })
      .getRawMany<{ contestId: string }>();
    return rows.map(row => row.contestId);
  }

  async load(accountId: number, contestId: string, ids: string[]): Promise<AtcoderSubmissionStateEntity[]> {
    const results = await this.submissions.findBy({ accountId, contestId, pending: true });
    const loaded = new Set(results.map(row => String(row.submissionId)));
    const remaining = [...new Set(ids)].filter(id => !loaded.has(id));
    for (let offset = 0; offset < remaining.length; offset += 500) {
      // eslint-disable-next-line no-await-in-loop -- Bound each SQL IN clause.
      const rows = await this.submissions.findBy({
        accountId,
        contestId,
        submissionId: In(remaining.slice(offset, offset + 500))
      });
      results.push(...rows);
    }
    return results;
  }

  async save(rows: Omit<AtcoderSubmissionStateEntity, "account">[]): Promise<void> {
    if (!rows.length) return;
    await this.submissions.manager.transaction(async manager => {
      const repository = manager.getRepository(AtcoderSubmissionStateEntity);
      for (let offset = 0; offset < rows.length; offset += 100) {
        // eslint-disable-next-line no-await-in-loop -- Bound statement size while committing one checkpoint.
        await repository.upsert(rows.slice(offset, offset + 100), ["accountId", "contestId", "submissionId"]);
      }
    });
  }
}
