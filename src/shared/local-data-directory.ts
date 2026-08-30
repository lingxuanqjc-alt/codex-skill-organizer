import path from "node:path";

export function resolveOrganizerDataDirectory(homeDirectory: string): string {
  if (!path.isAbsolute(homeDirectory)) throw new Error("Organizer home directory must be absolute");
  return path.join(path.resolve(homeDirectory), "AppData", "Local", "SkillOrganizerForCodex");
}
