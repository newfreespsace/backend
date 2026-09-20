import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";

import { Repository } from "typeorm";

import { UserEntity } from "@/user/user.entity";

import { UsacoGuideUserDataEntity } from "./usaco-guide-user-data.entity";

import { UsacoGuideUserDataResponseDto } from "./dto";

const MAX_USER_DATA_BYTES = 2 * 1024 * 1024;

@Injectable()
export class UsacoGuideService {
  constructor(
    @InjectRepository(UsacoGuideUserDataEntity)
    private readonly userDataRepository: Repository<UsacoGuideUserDataEntity>
  ) {}

  async getUserData(userId: number): Promise<UsacoGuideUserDataResponseDto> {
    const entity = await this.userDataRepository.findOneBy({ userId });
    if (!entity) return { data: null, schemaVersion: 1, revision: 0, updatedAt: null };
    return {
      data: entity.data,
      schemaVersion: entity.schemaVersion,
      revision: entity.revision,
      updatedAt: entity.updatedAt
    };
  }

  async saveUserData(
    user: UserEntity,
    data: Record<string, unknown>,
    schemaVersion: number,
    expectedRevision?: number
  ): Promise<UsacoGuideUserDataResponseDto> {
    if (Buffer.byteLength(JSON.stringify(data), "utf8") > MAX_USER_DATA_BYTES)
      throw new BadRequestException("USACO Guide user data exceeds the 2 MiB limit");

    const now = new Date();
    let entity = await this.userDataRepository.findOneBy({ userId: user.id });
    if (!entity) {
      if (expectedRevision != null && expectedRevision !== 0)
        throw new ConflictException("USACO Guide user data has changed");
      entity = this.userDataRepository.create({
        userId: user.id,
        data,
        schemaVersion,
        revision: 1,
        createdAt: now,
        updatedAt: now
      });
    } else {
      if (expectedRevision != null) {
        const result = await this.userDataRepository.update(
          { userId: user.id, revision: expectedRevision },
          {
            data,
            schemaVersion,
            revision: () => "revision + 1",
            updatedAt: now
          }
        );
        if (result.affected !== 1) throw new ConflictException("USACO Guide user data has changed");
        return await this.getUserData(user.id);
      }
      entity.data = data;
      entity.schemaVersion = schemaVersion;
      entity.revision += 1;
      entity.updatedAt = now;
    }
    await this.userDataRepository.save(entity);
    return await this.getUserData(user.id);
  }

  async deleteUserData(userId: number): Promise<void> {
    await this.userDataRepository.delete({ userId });
  }
}
