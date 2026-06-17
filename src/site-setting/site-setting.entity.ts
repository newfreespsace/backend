import { Entity, PrimaryColumn, Column } from "typeorm";

@Entity("site_setting")
export class SiteSettingEntity {
  @PrimaryColumn()
  key: string;

  @Column({ type: "json" })
  value: unknown;

  @Column()
  updateTime: Date;

  @Column({ nullable: true })
  updatedByUserId?: number;
}