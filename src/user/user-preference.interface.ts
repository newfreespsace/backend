import { Locale } from "@/common/locale.type";
import { ProblemReviewPreference } from "@/problem-review/problem-review.schedule";

export interface UserPreference {
  problemReview?: ProblemReviewPreference;
  locale?: {
    system?: Locale;
    content?: Locale;
    hideUnavailableMessage?: boolean;
  };
  theme?: string;
  font?: {
    contentFontFace?: string;
    codeFontFace?: string;
    codeFontSize?: number;
    codeLineHeight?: number;
    codeFontLigatures?: boolean;
  };
  codeFormatter?: {
    disableByDefault?: boolean;
    options?: string;
  };
  code?: {
    defaultLanguage?: string;
    defaultCompileAndRunOptions?: Record<string, string>;
  };
}
