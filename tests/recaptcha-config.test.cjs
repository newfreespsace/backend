const assert = require("node:assert/strict");
const { test } = require("node:test");

const { createGoogleRecaptchaOptions } = require("../dist/shared.module");

function configService(recaptchaEnabled, secretKey) {
  return {
    config: {
      preference: { security: { recaptchaEnabled } },
      security: { recaptcha: { secretKey } }
    }
  };
}

test("disabled reCAPTCHA starts without a configured secret and skips validation", async () => {
  const options = createGoogleRecaptchaOptions(configService(false, null));

  assert.equal(options.secretKey, "recaptcha-disabled");
  assert.equal(await options.skipIf({ headers: {}, session: null }), true);
});

test("enabled reCAPTCHA requires a configured secret", () => {
  assert.throws(
    () => createGoogleRecaptchaOptions(configService(true, null)),
    /security\.recaptcha\.secretKey is missing/
  );
});

test("enabled reCAPTCHA preserves normal and privileged-skip behavior", async () => {
  const options = createGoogleRecaptchaOptions(configService(true, "configured-secret"));

  assert.equal(options.secretKey, "configured-secret");
  assert.equal(await options.skipIf({ headers: {}, session: null }), false);
  assert.equal(
    await options.skipIf({
      headers: { "x-recaptcha-token": "skip" },
      session: { userCanSkipRecaptcha: async () => true }
    }),
    true
  );
});
