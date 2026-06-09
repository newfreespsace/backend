import { Body, Controller, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "@/common/user.decorator";
import { UserEntity } from "@/user/user.entity";

import { SectionService } from "./section.service";
import { CreateSectionDto } from "./dto/create-section.dto";
import { QuerySectionByChapterIdDto } from "./dto/query-section.dto";
import { UpdateSectionDto } from "./dto/update-section.dto";
import { AddProblemToSectionDto } from "./dto/add-problem-to-section.dto";
import { GetSectionByIdDto } from "./dto/get-section-by-id.dto";

@ApiTags("Training")
@Controller("training/chapter/section")
export class SectionController {
  constructor(private readonly sectionService: SectionService) {}

  @Post("querySectionSetByChapterId")
  querySectionSetByChapterId(
    @Body()
    request: QuerySectionByChapterIdDto
  ) {
    const { chapterId } = request;
    const sections = this.sectionService.querySectionSetByChapterId(chapterId);
    return sections;
  }

  @Post("createSection")
  createSection(
    @Body()
    request: CreateSectionDto
  ) {
    const section = this.sectionService.createSection(request);
    return section;
  }

  @Post("updateSection")
  updateSection(
    @Body()
    request: UpdateSectionDto
  ) {
    const { id } = request;
    const section = this.sectionService.updateSection(id, request);
    return section;
  }

  @Post("addProblemToSection")
  addProblemToSection(
    @Body()
    request: AddProblemToSectionDto
  ) {
    return this.sectionService.addProblemToSection(request);
  }

  @Post("getSectionById")
  getSectionById(
    @CurrentUser()
    currentUser: UserEntity,
    @Body()
    request: GetSectionByIdDto
  ) {
    const section = this.sectionService.getSectionById(currentUser, request);
    return section;
  }
}
