import { Injectable, NestMiddleware, UnauthorizedException } from "@nestjs/common";

import { Response } from "express";

import { RequestWithSession } from "./auth.middleware";

const ALLOWED_PATHS_FOR_ANONYMOUS = new Set([
  "auth/getSessionInfo",
  "auth/login",
  "auth/register",
  "auth/checkAvailability",
  "auth/sendEmailVerificationCode",
  "auth/resetPassword",
  "migration/queryUserMigrationInfo",
  "migration/migrateUser"
]);

@Injectable()
export class AuthRequiredMiddleware implements NestMiddleware {
  use(req: RequestWithSession, res: Response, next: () => void): void {
    if (req.session?.user) {
      next();
      return;
    }

    const path = req.path.replace(/^\/api\//, "").replace(/^\/+/, "");

    if (ALLOWED_PATHS_FOR_ANONYMOUS.has(path)) {
      next();
      return;
    }

    throw new UnauthorizedException("login required");
  }
}
