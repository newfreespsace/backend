import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";

import { Repository } from "typeorm";

import { SaveWhiteboardDto, WhiteboardVersionDto } from "./whiteboard.dto";
import { WhiteboardEntity } from "./whiteboard.entity";

export const MAX_SCENE_BYTES = 10 * 1024 * 1024;

export function validateScene(scene: string): void {
  if (Buffer.byteLength(scene, "utf8") > MAX_SCENE_BYTES) throw new PayloadTooLargeException("画板不能超过 10 MB");
  try {
    const data = JSON.parse(scene);
    if (
      data?.type !== "excalidraw" ||
      !Array.isArray(data.elements) ||
      !data.appState ||
      typeof data.appState !== "object" ||
      Array.isArray(data.appState) ||
      !data.files ||
      typeof data.files !== "object" ||
      Array.isArray(data.files)
    )
      throw new Error();
  } catch {
    throw new BadRequestException("无效的画板数据");
  }
}

@Injectable()
export class WhiteboardService {
  constructor(@InjectRepository(WhiteboardEntity) private readonly repository: Repository<WhiteboardEntity>) {}

  async list(userId: number) {
    // The scene column is excluded, so image data never enters list responses.
    return await this.repository.find({ where: { userId }, order: { updatedAt: "DESC" } });
  }

  async get(userId: number, id: string) {
    const board = await this.repository
      .createQueryBuilder("board")
      .addSelect("board.scene")
      .where("board.id = :id AND board.userId = :userId", { id, userId })
      .getOne();
    if (!board) throw new NotFoundException("画板不存在或无权访问");
    return board;
  }

  async save(userId: number, request: SaveWhiteboardDto) {
    validateScene(request.scene);
    const title = request.title.trim();
    if (!title) throw new BadRequestException("请输入画板名称");
    const { id, version, scene } = request;
    const updatedAt = new Date();
    if (version === 0) {
      try {
        await this.repository.insert({ id, userId, title, scene, version: 1, createdAt: updatedAt, updatedAt });
      } catch (error) {
        if (error.code === "ER_DUP_ENTRY" || error.driverError?.code === "ER_DUP_ENTRY") {
          return await this.recoverSave(userId, request, title);
        }
        throw error;
      }
    } else {
      // One SQL statement makes ownership + version checks atomic, including across server workers.
      const result = await this.repository.update(
        { id, userId, version },
        { title, scene, version: version + 1, updatedAt }
      );
      if (result.affected !== 1) return await this.recoverSave(userId, request, title);
    }
    return { id, title, version: version + 1, updatedAt };
  }

  private async recoverSave(userId: number, request: SaveWhiteboardDto, title: string) {
    // A response may be lost after commit. Accept an exact retry, never a different edit.
    const board = await this.repository
      .createQueryBuilder("board")
      .addSelect("board.scene")
      .where("board.id = :id AND board.userId = :userId", { id: request.id, userId })
      .getOne();
    if (board && board.version === request.version + 1 && board.title === title && board.scene === request.scene) {
      return { id: board.id, title: board.title, version: board.version, updatedAt: board.updatedAt };
    }
    throw new ConflictException("云端画板已更新或删除，请重新打开云端版本或另存副本");
  }

  async delete(userId: number, request: WhiteboardVersionDto) {
    const result = await this.repository.delete({ id: request.id, userId, version: request.version });
    if (result.affected !== 1) throw new ConflictException("云端画板已更新或删除，请刷新列表");
  }
}
