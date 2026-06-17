import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { ConfigService } from "@/config/config.service";
import { PreferenceConfig } from "@/config/config.schema";
import { UserEntity } from "@/user/user.entity";

import { SiteSettingEntity } from "./site-setting.entity";

const SITE_PREFERENCE_KEY = "preference";

function deepMerge<T>(base: T, patch: Partial<T>): T {
  if (!patch || typeof patch !== "object") return base;

  const result = (Array.isArray(base)
    ? [...base]
    : { ...((base as unknown) as Record<string, unknown>) }) as Record<string, unknown>;

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
