import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function writeSkill(
  root: string,
  relativeDirectory: string,
  metadata: Record<string, string> & { name: string; description: string },
): Promise<string> {
  const directory = path.join(root, relativeDirectory);
  await mkdir(directory, { recursive: true });
  const lines = ["---"];
  for (const [key, value] of Object.entries(metadata)) {
    lines.push(`${key}: ${JSON.stringify(value)}`);
  }
  lines.push("---", "", `# ${metadata.name}`, "", "Fixture skill.", "");
  const filePath = path.join(directory, "SKILL.md");
  await writeFile(filePath, lines.join("\n"), "utf8");
  return filePath;
}
