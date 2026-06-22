import { CanActivate, ExecutionContext, Injectable, Inject, forwardRef } from "@nestjs/common";

import { RequestWithSession } from "@/auth/auth.middleware";

import { ContestService } from "./contest.service";

@Injectable()
export class ContestAccessGuard implements CanActivate {
  constructor(
    @Inject(forwardRef(() => ContestService))
    private readonly contestService: ContestService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestWithSession>();
    const user = req.session?.user;
    if (!user) return true;

    const restrictedContests = await this.contestService.getContestAccessRestriction(user);
    if (restrictedContests.length === 0) return true;

    const path = req.path.replace(/^\/api\//, "");
    const activeContestIds = new Set(restrictedContests.map(contest => contest.id));
    const contestId = Number(req.body?.contestId ?? req.query?.contestId);

    if (path === "auth/getSessionInfo" || path === "auth/logout") return true;

    if (path.startsWith("gallery/image/")) return true;

    if (path === "file/upload" || path === "file/download") return true;

    if (path === "contest/queryContests") return true;

    if (path === "contest/getContest" || path === "contest/getContestProblem") {
      return activeContestIds.has(contestId);
    }

    if (path === "submission/submit" || path === "submission/querySubmission") {
      return activeContestIds.has(contestId);
    }

    if (path === "submission/getSubmissionDetail" || path === "submission/downloadSubmissionFile") {
      return true;
    }

    return false;
  }
}
