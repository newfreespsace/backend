import { ApiProperty } from "@nestjs/swagger";

export class InactiveUserDto {
  @ApiProperty()
  id: number;

  @ApiProperty()
  username: string;

  @ApiProperty()
  nickname: string;

  @ApiProperty()
  email: string;

  @ApiProperty()
  registrationTime: Date;
}
