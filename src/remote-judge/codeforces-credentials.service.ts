import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "crypto";

import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";

import { Repository } from "typeorm";

import { ConfigService } from "@/config/config.service";

import { RemoteAccountEntity } from "./remote-account.entity";
import { SubmissionMethod } from "./remote-judge.types";

export interface CodeforcesCredentials {
  apiKey: string;
  apiSecret: string;
}

export function validCodeforcesCredentials(credentials: CodeforcesCredentials): boolean {
  return [credentials?.apiKey, credentials?.apiSecret].every(
    value => typeof value === "string" && /^[a-zA-Z0-9]{1,256}$/.test(value)
  );
}

@Injectable()
export class CodeforcesCredentialsService {
  constructor(
    @InjectRepository(RemoteAccountEntity) private readonly accounts: Repository<RemoteAccountEntity>,
    private readonly configService: ConfigService
  ) {}

  private encryptionKey(): Buffer {
    return createHmac("sha256", this.configService.config.security.sessionSecret)
      .update("NSOJ:Codeforces:credentials:v1")
      .digest();
  }

  private context(account: RemoteAccountEntity): Buffer {
    return Buffer.from(`NSOJ:Codeforces:${account.userId}:${account.handleKey}:v1`);
  }

  encrypt(
    account: RemoteAccountEntity,
    credentials: CodeforcesCredentials
  ): RemoteAccountEntity["codeforcesCredentials"] {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey(), iv);
    cipher.setAAD(this.context(account));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credentials), "utf8"), cipher.final()]);
    return {
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64")
    };
  }

  async get(accountId: number): Promise<CodeforcesCredentials | undefined> {
    const account = await this.accounts.findOne({
      where: { id: accountId, platform: SubmissionMethod.Codeforces },
      select: ["id", "userId", "handleKey", "codeforcesSourceEnabled", "codeforcesCredentials"]
    });
    if (!account?.codeforcesSourceEnabled) return undefined;
    try {
      const { iv, tag, ciphertext } = account.codeforcesCredentials;
      const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey(), Buffer.from(iv, "base64"));
      decipher.setAAD(this.context(account));
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      const credentials = JSON.parse(
        Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8")
      );
      if (!validCodeforcesCredentials(credentials)) throw new Error();
      return credentials;
    } catch {
      throw new Error("REMOTE_CF_CREDENTIALS_UNREADABLE");
    }
  }
}
