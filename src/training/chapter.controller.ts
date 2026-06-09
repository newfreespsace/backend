import { Body, Controller, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { ChapterService } from "./chapter.service";
import { CreateChapterDto } from "./dto/create-chapter.dto";
import { QueryChapterByTrainingIdDto } from "./dto/query-chapter.dto";
import { UpdateChapterDto } from "./dto/update-chapter.dto";

@ApiTags("Training")
@Controller("training/chapter")
export class ChapterController {
  constructor(private readonly chapterService: ChapterService) {}

  @Post("queryChapterSetByTrainingId")
  queryChapterSetByTrainingId(
    @Body()
    request: QueryChapterByTrainingIdDto
  ) {
    const { trainingId } = request;
    const chapters = this.chapterService.queryChapterSetByTrainingId(trainingId);
    return chapters;
  }

  @Post("createChapter")
  createChapter(
    @Body()
    request: CreateChapterDto
  ) {
    const chapter = this.chapterService.createChapter(request);
    return chapter;
  }

  @Post("updateChapter")
  updateChapter(
    @Body()
    request: UpdateChapterDto
  ) {
    const { id } = request;
    const chapter = this.chapterService.updateChapter(id, request);
    return chapter;
  }
}
