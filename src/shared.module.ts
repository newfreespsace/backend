import { Module, Global } from "@nestjs/common";

import { GoogleRecaptchaModule } from "@nestlab/google-recaptcha";

import { ConfigModule } from "./config/config.module";
import { ConfigService } from "./config/config.service";
import { SettingsModule } from "./settings/settings.module";
import { RequestWithSession } from "./auth/auth.middleware";

export function createGoogleRecaptchaOptions(configService: ConfigService) {
  const enabled = configService.config.preference.security.recaptchaEnabled;
  const configuredSecretKey = configService.config.security.recaptcha.secretKey;

  if (enabled && !configuredSecretKey) {
    throw new Error("reCAPTCHA is enabled but security.recaptcha.secretKey is missing");
  }

  return {
    // The integration validates its provider configuration before evaluating
    // skipIf, so a non-empty inert value is required even when it is disabled.
    secretKey: configuredSecretKey || "recaptcha-disabled",
    response: (req: RequestWithSession) => String(req.headers["x-recaptcha-token"]),
    skipIf: async (request: unknown) => {
      const req = request as RequestWithSession;
      return (
        !enabled ||
        (String(req.headers["x-recaptcha-token"]).toLowerCase() === "skip" &&
          (await req.session?.userCanSkipRecaptcha?.()))
      );
    }
  };
}

const sharedModules = [
  ConfigModule,
  SettingsModule,
  GoogleRecaptchaModule.forRootAsync({
    imports: [ConfigModule],
    useFactory: createGoogleRecaptchaOptions,
    inject: [ConfigService]
  })
];

@Global()
@Module({
  imports: sharedModules,
  exports: sharedModules
})
export class SharedModule {}
