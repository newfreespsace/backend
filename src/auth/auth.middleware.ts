import { AsyncLocalStorage } from "async_hooks";

import { NestMiddleware, Injectable, ForbiddenException } from "@nestjs/common";

import { Request, Response } from "express"; // eslint-disable-line import/no-extraneous-dependencies

import { UserEntity } from "@/user/user.entity";
import { UserPrivilegeService, UserPrivilegeType } from "@/user/user-privilege.service";

import { AuthSessionService } from "./auth-session.service";
import { SESSION_COOKIE_NAME } from "./auth.constants";

const asyncLocalStorage = new AsyncLocalStorage();

export interface Session {
  sessionKey?: string;
  sessionId?: number;
  user?: UserEntity;
  userCanSkipRecaptcha: () => Promise<boolean>;
}

function getCookie(req: Request, name: string): string | undefined {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return undefined;

  for (const cookie of cookieHeader.split(";")) {
    const separator = cookie.indexOf("=");
    if (separator === -1) continue;
    if (cookie.slice(0, separator).trim() === name) {
      try {
        return decodeURIComponent(cookie.slice(separator + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export interface RequestWithSession extends Request {
  session: Session;
}

@Injectable()
export class AuthMiddleware implements NestMiddleware {
  constructor(
    private readonly authSessionService: AuthSessionService,
    private readonly userPrivilegeService: UserPrivilegeService
  ) {}

  async use(req: RequestWithSession, res: Response, next: () => void): Promise<void> {
    const authHeader = req.headers.authorization;
    const bearerSessionKey = authHeader && authHeader.split(" ")[1];
    const cookieSessionKey = getCookie(req, SESSION_COOKIE_NAME);
    const sessionKey = bearerSessionKey || cookieSessionKey;

    if (cookieSessionKey && !bearerSessionKey && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const { origin } = req.headers;
      const allowedOrigins = this.authSessionService.getAllowedBrowserOrigins();
      const requestOrigin = `${req.protocol}://${req.get("host")}`;
      if (origin && origin !== requestOrigin && !allowedOrigins.includes(origin))
        throw new ForbiddenException("invalid request origin");
    }
    if (sessionKey) {
      const [sessionId, user] = await this.authSessionService.accessSession(sessionKey);
      if (user) {
        req.session = {
          sessionKey,
          sessionId,
          user,
          userCanSkipRecaptcha: () => this.userPrivilegeService.userHasPrivilege(user, UserPrivilegeType.SkipRecaptcha)
        };
      }
    }

    asyncLocalStorage.run(req, () => next());
  }
}

/**
 * Get the current request object from async local storage.
 *
 * Calling it in a EventEmitter's callback may be not working since EventEmitter's callbacks
 * run in different contexts.
 */
export function getCurrentRequest(): RequestWithSession {
  return asyncLocalStorage.getStore() as RequestWithSession;
}
