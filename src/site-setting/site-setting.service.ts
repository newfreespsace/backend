import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "crypto";

import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";

import { Repository } from "typeorm";

import { ConfigService } from "@/config/config.service";
import { PreferenceConfig } from "@/config/config.schema";
import { UserEntity } from "@/user/user.entity";

import { SiteSettingEntity } from "./site-setting.entity";
import { RemoteJudgeSettingsDto, UpdateRemoteJudgeSettingsRequestDto } from "./dto/remote-judge-settings.dto";

const SITE_PREFERENCE_KEY = "preference";
const ATCODER_SESSION_KEY = "remote-judge:atcoder-session";
const ATCODER_SESSION_HEALTH_KEY = "remote-judge:atcoder-session-health";

interface AtcoderSessionHealth {
  fingerprint: string;
  status: "valid" | "expired" | "unavailable";
  checkedAt: string;
  error?: string;
}

interface StoredAtcoderSession {
  version: 1;
  disabled?: boolean;
  iv?: string;
  tag?: string;
  ciphertext?: string;
}

function deepMerge<T>(base: T, patch: Partial<T>): T {
  if (!patch || typeof patch !== "object") return base;

  const result = (Array.isArray(base) ? [...base] : { ...(base as unknown as Record<string, unknown>) }) as Record<
    string,
    unknown
  >;

  for (const [key, value] of Object.entries(patch)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      result[key] &&
      typeof result[key] === "object" &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key], value as Partial<unknown>);
    } else {
      result[key] = value;
    }
  }

  return result as T;
}

@Injectable()
export class SiteSettingService {
  constructor(
    @InjectRepository(SiteSettingEntity)
    private readonly siteSettingRepository: Repository<SiteSettingEntity>,
    private readonly configService: ConfigService
  ) {}

  private atcoderEncryptionKey(): Buffer {
    return createHmac("sha256", this.configService.config.security.sessionSecret)
      .update("NSOJ:AtCoder:session:v1")
      .digest();
  }

  async getRemoteJudgeSettings(): Promise<RemoteJudgeSettingsDto> {
    const setting = await this.siteSettingRepository.findOneBy({ key: ATCODER_SESSION_KEY });
    let result: RemoteJudgeSettingsDto;
    if (setting) {
      const value = setting.value as StoredAtcoderSession;
      result = {
        atcoderSessionConfigured: !value.disabled && !!value.ciphertext,
        atcoderSessionSource: value.disabled ? "none" : "site",
        atcoderSessionStatus: value.disabled ? "missing" : "unchecked",
        updatedAt: setting.updateTime
      };
    } else {
      const configured = !!process.env.NSOJ_ATCODER_SESSION?.trim();
      result = {
        atcoderSessionConfigured: configured,
        atcoderSessionSource: configured ? "environment" : "none",
        atcoderSessionStatus: configured ? "unchecked" : "missing"
      };
    }
    if (!result.atcoderSessionConfigured) return result;
    let session: string;
    try {
      session = this.atcoderSessionFromSetting(setting);
    } catch {
      return { ...result, atcoderSessionStatus: "unavailable", atcoderSessionError: "REMOTE_SESSION_UNREADABLE" };
    }
    const healthSetting = await this.siteSettingRepository.findOneBy({ key: ATCODER_SESSION_HEALTH_KEY });
    const health = healthSetting?.value as AtcoderSessionHealth;
    if (health?.fingerprint === this.atcoderSessionFingerprint(session)) {
      result.atcoderSessionStatus = health.status;
      result.atcoderSessionLastCheckedAt = new Date(health.checkedAt);
      result.atcoderSessionError = health.error;
    }
    return result;
  }

  /** Backend-only accessor. Never include this value in preference or admin responses. */
  async getAtcoderSession(): Promise<string | undefined> {
    const setting = await this.siteSettingRepository.findOneBy({ key: ATCODER_SESSION_KEY });
    return this.atcoderSessionFromSetting(setting);
  }

  private atcoderSessionFromSetting(setting: SiteSettingEntity | null): string | undefined {
    if (!setting) return process.env.NSOJ_ATCODER_SESSION?.trim() || undefined;
    const value = setting.value as StoredAtcoderSession;
    if (value.disabled) return undefined;
    try {
      if (value.version !== 1 || !value.iv || !value.tag || !value.ciphertext) throw new Error();
      const decipher = createDecipheriv("aes-256-gcm", this.atcoderEncryptionKey(), Buffer.from(value.iv, "base64"));
      decipher.setAAD(Buffer.from(ATCODER_SESSION_KEY));
      decipher.setAuthTag(Buffer.from(value.tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]).toString(
        "utf8"
      );
    } catch {
      throw new Error("REMOTE_SESSION_UNREADABLE");
    }
  }

  private atcoderSessionFingerprint(session: string): string {
    return createHmac("sha256", this.configService.config.security.sessionSecret)
      .update("NSOJ:AtCoder:session-health:v1:")
      .update(session)
      .digest("hex");
  }

  async recordAtcoderSessionCheck(session: string, error?: string): Promise<void> {
    // An old request may finish after an administrator replaces the session.
    const current = await this.getAtcoderSession();
    if (!current || current !== session) return;
    const safeError = [
      "REMOTE_AUTH_REQUIRED",
      "REMOTE_RATE_LIMITED",
      "REMOTE_PARSE_FAILED",
      "REMOTE_UNAVAILABLE"
    ].includes(error)
      ? error
      : error
      ? "REMOTE_UNAVAILABLE"
      : undefined;
    const health: AtcoderSessionHealth = {
      fingerprint: this.atcoderSessionFingerprint(session),
      status: !safeError ? "valid" : safeError === "REMOTE_AUTH_REQUIRED" ? "expired" : "unavailable",
      checkedAt: new Date().toISOString(),
      error: safeError
    };
    const entity = new SiteSettingEntity();
    entity.key = ATCODER_SESSION_HEALTH_KEY;
    entity.value = health;
    entity.updateTime = new Date();
    entity.updatedByUserId = null;
    await this.siteSettingRepository.save(entity);
  }

  async updateRemoteJudgeSettings(
    request: UpdateRemoteJudgeSettingsRequestDto,
    user: UserEntity
  ): Promise<RemoteJudgeSettingsDto> {
    if (request.clearAtcoderSession !== undefined && typeof request.clearAtcoderSession !== "boolean")
      throw new BadRequestException("INVALID_ATCODER_SESSION");
    const hasSession = Object.prototype.hasOwnProperty.call(request, "atcoderSession");
    if (hasSession && request.clearAtcoderSession) throw new BadRequestException("INVALID_ATCODER_SESSION");
    if (!hasSession && !request.clearAtcoderSession) return await this.getRemoteJudgeSettings();
    let value: StoredAtcoderSession = { version: 1, disabled: true };
    if (hasSession) {
      if (typeof request.atcoderSession !== "string") throw new BadRequestException("INVALID_ATCODER_SESSION");
      const session = request.atcoderSession.trim().replace(/^REVEL_SESSION=/, "");
      if (!session || session.length > 8192 || /[;\s]/.test(session))
        throw new BadRequestException("INVALID_ATCODER_SESSION");
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", this.atcoderEncryptionKey(), iv);
      cipher.setAAD(Buffer.from(ATCODER_SESSION_KEY));
      value = {
        version: 1,
        iv: iv.toString("base64"),
        ciphertext: Buffer.concat([cipher.update(session, "utf8"), cipher.final()]).toString("base64"),
        tag: cipher.getAuthTag().toString("base64")
      };
    }
    const entity = new SiteSettingEntity();
    entity.key = ATCODER_SESSION_KEY;
    entity.value = value;
    entity.updateTime = new Date();
    entity.updatedByUserId = user.id;
    await this.siteSettingRepository.save(entity);
    return await this.getRemoteJudgeSettings();
  }

  async getPreference(): Promise<PreferenceConfig> {
    const setting = await this.siteSettingRepository.findOneBy({ key: SITE_PREFERENCE_KEY });
    const basePreference = this.configService.config.preference;

    if (!setting) return basePreference;

    return deepMerge(basePreference, setting.value as Partial<PreferenceConfig>);
  }

  async getPreferenceConfigToBeSentToUser(): Promise<PreferenceConfig> {
    const preference = JSON.parse(JSON.stringify(await this.getPreference())) as PreferenceConfig;
    delete preference.serverSideOnly;
    return preference;
  }

  async updatePreferencePatch(patch: Partial<PreferenceConfig>, user: UserEntity): Promise<PreferenceConfig> {
    if (
      patch.security &&
      Object.prototype.hasOwnProperty.call(patch.security, "otherSubmissionCodeMinAcceptedProblems")
    ) {
      const threshold = patch.security.otherSubmissionCodeMinAcceptedProblems;
      if (!Number.isSafeInteger(threshold) || threshold < 0)
        throw new BadRequestException("otherSubmissionCodeMinAcceptedProblems must be a non-negative safe integer");
    }
    const current = await this.siteSettingRepository.findOneBy({ key: SITE_PREFERENCE_KEY });

    const oldValue = (current?.value || {}) as Partial<PreferenceConfig>;
    const newValue = deepMerge(oldValue, patch);

    const entity = current || new SiteSettingEntity();
    entity.key = SITE_PREFERENCE_KEY;
    entity.value = newValue;
    entity.updateTime = new Date();
    entity.updatedByUserId = user?.id || null;

    await this.siteSettingRepository.save(entity);

    return await this.getPreference();
  }
}
