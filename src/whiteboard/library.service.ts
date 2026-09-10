import { BadRequestException, ConflictException, Injectable, PayloadTooLargeException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { WhiteboardLibraryEntity } from "./library.entity";

export const MAX_LIBRARY_BYTES = 10 * 1024 * 1024;
type LibraryItem = { id: string; status: string; created: number; elements: Record<string, unknown>[] };
type LibraryChange = { id: string; item?: LibraryItem };

export function parseLibraryChanges(json: string): LibraryChange[] {
  if (typeof json !== "string") throw new BadRequestException("无效的素材库数据");
  if (Buffer.byteLength(json, "utf8") > MAX_LIBRARY_BYTES) throw new PayloadTooLargeException("素材库不能超过 10 MB");
  try {
    const changes = JSON.parse(json);
    if (!Array.isArray(changes) || changes.length > 10000) throw new Error();
    for (const change of changes) {
      if (!change || typeof change.id !== "string" || !change.id || change.id.length > 128) throw new Error();
      if (change.item !== undefined) {
        const item = change.item;
        if (
          !item ||
          item.id !== change.id ||
          !["published", "unpublished"].includes(item.status) ||
          !Number.isFinite(item.created) ||
          !Array.isArray(item.elements) ||
          !item.elements.length ||
          !item.elements.every(
            element =>
              element &&
              typeof element === "object" &&
              typeof element.id === "string" &&
              typeof element.type === "string"
          )
        )
          throw new Error();
      }
    }
    return changes;
  } catch {
    throw new BadRequestException("无效的素材库数据");
  }
}

@Injectable()
export class WhiteboardLibraryService {
  constructor(
    @InjectRepository(WhiteboardLibraryEntity) private readonly repository: Repository<WhiteboardLibraryEntity>
  ) {}

  async get(userId: number) {
    const library = await this.repository.findOneBy({ userId });
    return { libraryItems: library ? JSON.parse(library.items) : [] };
  }

  async save(userId: number, json: string) {
    const changes = parseLibraryChanges(json);
    // Retry against the latest snapshot. Independent edits on other devices are preserved.
    for (let attempt = 0; attempt < 8; attempt++) {
      const previous = await this.repository.findOneBy({ userId });
      const items = new Map<string, LibraryItem>(
        (previous ? JSON.parse(previous.items) : []).map((item: LibraryItem) => [item.id, item])
      );
      for (const change of changes) {
        if (change.item) items.set(change.id, change.item);
        else items.delete(change.id);
      }
      const libraryItems = [...items.values()];
      const serialized = JSON.stringify(libraryItems);
      if (Buffer.byteLength(serialized, "utf8") > MAX_LIBRARY_BYTES)
        throw new PayloadTooLargeException("素材库不能超过 10 MB");
      if (serialized === (previous?.items || "[]")) return { libraryItems };
      if (previous) {
        const result = await this.repository.update(
          { userId, version: previous.version },
          { items: serialized, version: previous.version + 1 }
        );
        if (result.affected === 1) return { libraryItems };
      } else {
        try {
          await this.repository.insert({ userId, items: serialized, version: 1 });
          return { libraryItems };
        } catch (error) {
          if (error.code !== "ER_DUP_ENTRY" && error.driverError?.code !== "ER_DUP_ENTRY") throw error;
        }
      }
    }
    throw new ConflictException("素材库正在其他设备上更新，请重试");
  }
}
