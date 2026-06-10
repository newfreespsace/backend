import { Body, Controller, Post } from "@nestjs/common";
import { ApiOkResponse, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "@/common/user.decorator";
import { UserEntity } from "@/user/user.entity";

import { ChapterService } from "./chapter.service";
import { CreateChapterDto } from "./dto/create-chapter.dto";
import { GetChapterByIdDto } from "./dto/get-chapter-by-id-request.dto";
import { QueryChapterByTrainingIdDto } from "./dto/query-chapter.dto";
import { ChapterMetaDto } from "./dto/training-meta.dto";
import { UpdateChapterDto } from "./dto/update-chapter.dto";

@ApiTags("Training")
@Controller("training/chapter")
export class ChapterController {
  constructor(private readonly chapterService: ChapterService) {}

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
  createChapter(
    @Body()
    request: CreateChapterDto
  ): Promise<ChapterMetaDto> {
    const chapter = this.chapterService.createChapter(request);
    return chapter;
  }

  @Post("updateChapter")
  updateChapter(
    @Body()
    request: UpdateChapterDto
  ): Promise<ChapterMetaDto> {
    const { id } = request;
    const chapter = this.chapterService.updateChapter(id, request);
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
}
