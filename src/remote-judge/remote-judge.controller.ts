import { BadRequestException, ForbiddenException, Body, Controller, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "@/common/user.decorator";
import { UserEntity } from "@/user/user.entity";

import { RemoteJudgeService } from "./remote-judge.service";
import {
  BindRemoteAccountDto,
  RemoteContextDto,
  RemotePlatformDto,
  SetSubmissionMethodDto,
  SetCodeforcesCredentialsDto
} from "./remote-judge.dto";

@ApiTags("RemoteJudge")
@ApiBearerAuth()
@Controller("remoteJudge")
export class RemoteJudgeController {
  constructor(private readonly service: RemoteJudgeService) {}

  private async run<T>(operation: () => Promise<T>): Promise<T | { error: string }> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      if (error instanceof BadRequestException || /^REMOTE_[A-Z_]+$/.test(error.message))
        return { error: error.message };
      throw error;
    }
  }

  @Post("accounts")
  accounts(@CurrentUser() user: UserEntity) {
    return this.service.list(user);
  }

  @Post("beginBinding")
  beginBinding(@CurrentUser() user: UserEntity, @Body() request: BindRemoteAccountDto) {
    return this.run(() => this.service.beginBinding(user, request));
  }

  @Post("verifyBinding")
  verifyBinding(@CurrentUser() user: UserEntity, @Body() request: RemotePlatformDto) {
    return this.run(() => this.service.verifyBinding(user, request.platform));
  }

  @Post("unbind")
  unbind(@CurrentUser() user: UserEntity, @Body() request: RemotePlatformDto) {
    return this.service.unbind(user, request.platform);
  }

  @Post("activate")
  activate(@CurrentUser() user: UserEntity, @Body() request: RemoteContextDto) {
    return this.service.activate(user, request);
  }

  @Post("setCodeforcesCredentials")
  setCodeforcesCredentials(@CurrentUser() user: UserEntity, @Body() request: SetCodeforcesCredentialsDto) {
    return this.run(() => this.service.setCodeforcesCredentials(user, request));
  }

  @Post("status")
  status(@CurrentUser() user: UserEntity, @Body() request: RemoteContextDto) {
    return this.service.status(user, request);
  }

  @Post("setSubmissionMethod")
  setSubmissionMethod(@CurrentUser() user: UserEntity, @Body() request: SetSubmissionMethodDto) {
    return this.run(() => this.service.setMethod(user, request));
  }
}
