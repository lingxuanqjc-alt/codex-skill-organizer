export function canonicalLogicalIdentityText(input: string): string {
  return input.normalize("NFC").toLocaleLowerCase("en-US");
}

export function canonicalLogicalSkillPath(input: string): string {
  return canonicalLogicalIdentityText(input.replaceAll("\\", "/").replace(/^\.\//u, ""));
}
