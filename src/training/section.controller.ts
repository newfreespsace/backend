import { Body, Controller, ForbiddenException, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiOkResponse, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "@/common/user.decorator";
import { UserEntity } from "@/user/user.entity";
import { UserPrivilegeService, UserPrivilegeType } from "@/user/user-privilege.service";

import { SectionService } from "./section.service";
import { CreateSectionDto } from "./dto/create-section.dto";
import { DeleteByIdRequestDto } from "./dto/delete-by-id-request.dto";
import { QuerySectionByChapterIdDto } from "./dto/query-section.dto";
import {
  QuerySectionGroupRanklistDto,
  QuerySectionGroupRanklistResponseDto
} from "./dto/query-section-group-ranklist.dto";
import { UpdateSectionDto } from "./dto/update-section.dto";
import { GetSectionByIdDto } from "./dto/get-section-by-id.dto";
import { GetSectionByIdResponseDto } from "./dto/get-section-by-id-response.dto";
import { ReorderSectionsDto } from "./dto/reorder-items.dto";
import { SetSectionProblemsDto } from "./dto/set-section-problems.dto";
import { SetSectionProblemsResponseDto } from "./dto/set-section-problems-response.dto";
import { SectionMetaDto } from "./dto/training-meta.dto";

@ApiTags("Training")
@Controller("training/chapter/section")
export class SectionController {
  constructor(
    private readonly sectionService: SectionService,
    private readonly userPrivilegeService: UserPrivilegeService
  ) {}

  private async checkManageTrainingPermission(currentUser: UserEntity): Promise<void> {
    if (!(await this.userPrivilegeService.userHasPrivilege(currentUser, UserPrivilegeType.ManageProblem))) {
      throw new ForbiddenException("permission denied");
    }
  }

  @Post("querySectionSetByChapterId")
  @ApiOkResponse({ type: SectionMetaDto, isArray: true })
  querySectionSetByChapterId(
    @CurrentUser()
    currentUser: UserEntity,
    @Body()
    request: QuerySectionByChapterIdDto
  ): Promise<SectionMetaDto[]> {
    const { chapterId } = request;
    const sections = this.sectionService.querySectionSetByChapterId(chapterId, currentUser);
    return sections;
  }

  @Post("createSection")
  @ApiBearerAuth()
  async createSection(
    @CurrentUser()
    currentUser: UserEntity,
    @Body()
    request: CreateSectionDto
  ) {
    await this.checkManageTrainingPermission(currentUser);
    const section = await this.sectionService.createSection(request);
    return section;
  }

  @Post("updateSection")
  @ApiBearerAuth()
  async updateSection(
    @CurrentUser()
    currentUser: UserEntity,
    @Body()
    request: UpdateSectionDto
  ) {
    await this.checkManageTrainingPermission(currentUser);
    const { id } = request;
    const section = await this.sectionService.updateSection(id, request);
    return section;
  }

  // @Post("addProblemToSection")
  // addProblemToSection(
  //   @Body()
  //   request: AddProblemToSectionDto
  // ): Promise<AddProblemToSectionResponseDto> {
  //   return this.sectionService.addProblemToSection(request);
  // }

  @Post("getSectionById")
  getSectionById(
    @CurrentUser()
    currentUser: UserEntity,
    @Body()
    request: GetSectionByIdDto
  ): Promise<GetSectionByIdResponseDto> {
    const section = this.sectionService.getSectionById(currentUser, request);
    return section;
  }

  @Post("setSectionProblems")
  @ApiBearerAuth()
  async setSectionProblems(
    @CurrentUser()
    currentUser: UserEntity,
    @Body()
    request: SetSectionProblemsDto
  ): Promise<SetSectionProblemsResponseDto> {
    await this.checkManageTrainingPermission(currentUser);
    return this.sectionService.setSectionProblems(request);
  }

  @Post("delSectionById")
  @ApiBearerAuth()
  async delSectionById(
    @CurrentUser()
    currentUser: UserEntity,
    @Body()
    request: DeleteByIdRequestDto
  ): Promise<void> {
    await this.checkManageTrainingPermission(currentUser);
    await this.sectionService.delSectionById(request.id);
  }

  @Post("reorderSections")
  @ApiBearerAuth()
  async reorderSections(
    @CurrentUser()
    currentUser: UserEntity,
    @Body()
    request: ReorderSectionsDto
  ): Promise<void> {
    await this.checkManageTrainingPermission(currentUser);
    await this.sectionService.reorderSections(request.chapterId, request.items);
  }

  @Post("querySectionGroupRanklist")
  @ApiBearerAuth()
  async querySectionGroupRanklist(
    @CurrentUser()
    currentUser: UserEntity,
    @Body()
    request: QuerySectionGroupRanklistDto
  ): Promise<QuerySectionGroupRanklistResponseDto> {
    return await this.sectionService.querySectionGroupRanklist(currentUser, request);
  }
}
