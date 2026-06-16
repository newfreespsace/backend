import { Body, Controller, ForbiddenException, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiOkResponse, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "@/common/user.decorator";
import { UserEntity } from "@/user/user.entity";
import { UserPrivilegeService, UserPrivilegeType } from "@/user/user-privilege.service";

import { ChapterService } from "./chapter.service";
import { CreateChapterDto } from "./dto/create-chapter.dto";
import { DeleteByIdRequestDto } from "./dto/delete-by-id-request.dto";
import { GetChapterByIdDto } from "./dto/get-chapter-by-id-request.dto";
import { QueryChapterByTrainingIdDto } from "./dto/query-chapter.dto";
import { ReorderChaptersDto } from "./dto/reorder-items.dto";
import { ChapterMetaDto } from "./dto/training-meta.dto";
import { UpdateChapterDto } from "./dto/update-chapter.dto";

@ApiTags("Training")
@Controller("training/chapter")
export class ChapterController {
  constructor(
    private readonly chapterService: ChapterService,
    private readonly userPrivilegeService: UserPrivilegeService
  ) {}

  private async checkManageTrainingPermission(currentUser: UserEntity): Promise<void> {
    if (!(await this.userPrivilegeService.userHasPrivilege(currentUser, UserPrivilegeType.ManageProblem))) {
      throw new ForbiddenException("permission denied");
    }
  }

  @Post("queryChapterSetByTrainingId")
  @ApiOkResponse({ type: ChapterMetaDto, isArray: true })
  queryChapterSetByTrainingId(
    @CurrentUser()
    currentUser: UserEntity,
    @Body()
    request: QueryChapterByTrainingIdDto
  ): Promise<ChapterMetaDto[]> {
    const { trainingId } = request;
    const chapters = this.chapterService.queryChapterSetByTrainingId(trainingId, currentUser);
    return chapters;
  }

  @Post("createChapter")
  @ApiBearerAuth()
  async createChapter(
    @CurrentUser()
    currentUser: UserEntity,
    @Body()
    request: CreateChapterDto
  ): Promise<ChapterMetaDto> {
    await this.checkManageTrainingPermission(currentUser);
    const chapter = await this.chapterService.createChapter(request);
    return chapter;
  }

  @Post("updateChapter")
  @ApiBearerAuth()
  async updateChapter(
    @CurrentUser()
    currentUser: UserEntity,
    @Body()
    request: UpdateChapterDto
  ): Promise<ChapterMetaDto> {
    await this.checkManageTrainingPermission(currentUser);
    const { id } = request;
    const chapter = await this.chapterService.updateChapter(id, request);
    return chapter;
  }

  @Post("getChapterById")
  getChapterById(
    @CurrentUser()
    currentUser: UserEntity,
    @Body()
    request: GetChapterByIdDto
  ): Promise<ChapterMetaDto> {
    const { id } = request;
    const chapter = this.chapterService.getChapterById(id, currentUser);
    return chapter;
  }

  @Post("delChapterById")
  @ApiBearerAuth()
  async delChapterById(
    @CurrentUser()
    currentUser: UserEntity,
    @Body()
    request: DeleteByIdRequestDto
  ): Promise<void> {
    await this.checkManageTrainingPermission(currentUser);
    await this.chapterService.delChapterById(request.id);
  }

  @Post("reorderChapters")
  @ApiBearerAuth()
  async reorderChapters(
    @CurrentUser()
    currentUser: UserEntity,
    @Body()
    request: ReorderChaptersDto
  ): Promise<void> {
    await this.checkManageTrainingPermission(currentUser);
    await this.chapterService.reorderChapters(request.trainingId, request.items);
  }
}
