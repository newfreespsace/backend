export function removeProblemTitlePrefix(title: string): string {
  return title.replace(/^\s*「[^」]*」\s*/, "");
}
