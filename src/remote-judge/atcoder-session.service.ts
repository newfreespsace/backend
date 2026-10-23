import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "crypto";

import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";

import { Repository } from "typeorm";

import { ConfigService } from "@/config/config.service";

import { RemoteAccountEntity } from "./remote-account.entity";
import { SubmissionMethod } from "./remote-judge.types";

export function normalizeAtcoderSession(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const session = value.trim().replace(/^REVEL_SESSION=/, "");
  return session &&
    session.length <= 8192 &&
    !/[;\s]/.test(session) &&
    Array.from(session).every(character => character.charCodeAt(0) >= 33 && character.charCodeAt(0) <= 126)
    ? session
    : undefined;
}

@Injectable()
export class AtcoderSessionService {
  constructor(
    @InjectRepository(RemoteAccountEntity) private readonly accounts: Repository<RemoteAccountEntity>,
    private readonly configService: ConfigService
  ) {}

  private key(): Buffer {
    return createHmac("sha256", this.configService.config.security.sessionSecret)
      .update("NSOJ:AtCoder:personal-session:v1")
      .digest();
  }

  private context(account: RemoteAccountEntity): Buffer {
    return Buffer.from(`NSOJ:AtCoder:${account.id}:${account.userId}:${account.handleKey}:v1`);
  }

  encrypt(account: RemoteAccountEntity, session: string): RemoteAccountEntity["atcoderSession"] {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    cipher.setAAD(this.context(account));
    return {
      iv: iv.toString("base64"),
      ciphertext: Buffer.concat([cipher.update(session, "utf8"), cipher.final()]).toString("base64"),
      tag: cipher.getAuthTag().toString("base64")
    };
  }

  async get(accountId: number): Promise<string | undefined> {
    if (!Number.isSafeInteger(accountId) || accountId <= 0) return undefined;
    const account = await this.accounts.findOne({
      where: { id: accountId, platform: SubmissionMethod.AtCoder },
      select: ["id", "userId", "handleKey", "atcoderSessionConfigured", "atcoderSession"]
    });
    if (!account?.atcoderSessionConfigured) return undefined;
    try {
      const { iv, tag, ciphertext } = account.atcoderSession;
      const decipher = createDecipheriv("aes-256-gcm", this.key(), Buffer.from(iv, "base64"));
      decipher.setAAD(this.context(account));
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      const session = Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString(
        "utf8"
      );
      if (normalizeAtcoderSession(session) !== session) throw new Error();
      return session;
    } catch {
      throw new Error("REMOTE_SESSION_UNREADABLE");
    }
  }
}
