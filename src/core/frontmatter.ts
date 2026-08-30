import { open } from "node:fs/promises";
import { parse } from "yaml";

const MAX_FRONTMATTER_BYTES = 256 * 1024;

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  category?: string;
  version?: string | number;
  origin?: string;
}

export interface FrontmatterResult {
  data: SkillFrontmatter;
  diagnostic?: "FRONTMATTER_MISSING" | "FRONTMATTER_INVALID" | "FRONTMATTER_TOO_LARGE";
  message?: string;
}

export interface FrontmatterReadHandle {
  readonly size: number;
  readByte(position: number): Promise<number | null>;
  close(): Promise<void>;
}

export interface FrontmatterReadAdapter {
  open(filePath: string): Promise<FrontmatterReadHandle>;
}

function createNodeFrontmatterReadAdapter(): FrontmatterReadAdapter {
  return {
    async open(filePath) {
      const handle = await open(filePath, "r");
      try {
        const info = await handle.stat();
        const byte = Buffer.allocUnsafe(1);
        return {
          size: info.size,
          async readByte(position) {
            const { bytesRead } = await handle.read(byte, 0, 1, position);
            return bytesRead === 0 ? null : byte[0]!;
          },
          close: () => handle.close(),
        };
      } catch (error) {
        await handle.close();
        throw error;
      }
    },
  };
}

function recoverSimpleCategory(yamlText: string): SkillFrontmatter {
  const matches = yamlText.match(/^category:\s*([\p{L}\p{N}._/-]+)\s*(?:#.*)?$/gmu) ?? [];
  if (matches.length !== 1) return {};
  const value = /^category:\s*([\p{L}\p{N}._/-]+)/u.exec(matches[0]!)?.[1];
  return value ? { category: value } : {};
}

function isClosingDelimiter(line: readonly number[]): boolean {
  let end = line.length;
  if (end > 0 && line[end - 1] === 0x0d) end -= 1;
  if (end < 3 || line[0] !== 0x2d || line[1] !== 0x2d || line[2] !== 0x2d) return false;
  for (let index = 3; index < end; index += 1) {
    if (line[index] !== 0x20 && line[index] !== 0x09) return false;
  }
  return true;
}

function parseFrontmatter(yamlBytes: readonly number[]): FrontmatterResult {
  const yamlText = Buffer.from(yamlBytes).toString("utf8");
  try {
    const parsed = parse(yamlText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { data: {}, diagnostic: "FRONTMATTER_INVALID", message: "frontmatter 必须是对象" };
    }

    const record = parsed as Record<string, unknown>;
    const stringValue = (key: string): string | undefined => {
      const value = record[key];
      if (typeof value === "string") return value.trim();
      if (key === "version" && typeof value === "number") return String(value);
      return undefined;
    };

    return {
      data: {
        name: stringValue("name"),
        description: stringValue("description"),
        category: stringValue("category"),
        version: stringValue("version"),
        origin: stringValue("origin"),
      },
    };
  } catch (error) {
    return {
      data: recoverSimpleCategory(yamlText),
      diagnostic: "FRONTMATTER_INVALID",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function readSkillFrontmatter(
  filePath: string,
  adapter: FrontmatterReadAdapter = createNodeFrontmatterReadAdapter(),
): Promise<FrontmatterResult> {
  const handle = await adapter.open(filePath);
  let position = 0;
  let bytesConsumed = 0;

  const readByte = async (): Promise<number | null> => {
    if (position >= handle.size) return null;
    if (bytesConsumed >= MAX_FRONTMATTER_BYTES) {
      throw new RangeError("FRONTMATTER_READ_LIMIT");
    }
    const value = await handle.readByte(position);
    if (value === null) return null;
    position += 1;
    bytesConsumed += 1;
    return value;
  };

  try {
    const prefix: number[] = [];
    let first = await readByte();
    if (first === 0xef) {
      const second = await readByte();
      const third = await readByte();
      if (second === 0xbb && third === 0xbf) first = await readByte();
      else {
        prefix.push(first, ...(second === null ? [] : [second]), ...(third === null ? [] : [third]));
        first = null;
      }
    }
    if (first !== null) prefix.push(first);
    while (prefix.length < 3) {
      const value = await readByte();
      if (value === null) break;
      prefix.push(value);
    }
    if (prefix.length < 3 || prefix[0] !== 0x2d || prefix[1] !== 0x2d || prefix[2] !== 0x2d) {
      return { data: {}, diagnostic: "FRONTMATTER_MISSING", message: "SKILL.md 缺少 YAML frontmatter" };
    }

    while (true) {
      const value = await readByte();
      if (value === null) {
        return { data: {}, diagnostic: "FRONTMATTER_INVALID", message: "frontmatter 没有结束分隔符" };
      }
      if (value === 0x0a) break;
      if (value !== 0x20 && value !== 0x09 && value !== 0x0d) {
        return { data: {}, diagnostic: "FRONTMATTER_MISSING", message: "SKILL.md 缺少 YAML frontmatter" };
      }
    }

    const yamlBytes: number[] = [];
    let lineBytes: number[] = [];
    while (true) {
      const value = await readByte();
      if (value === null) {
        if (isClosingDelimiter(lineBytes)) return parseFrontmatter(yamlBytes);
        return { data: {}, diagnostic: "FRONTMATTER_INVALID", message: "frontmatter 没有结束分隔符" };
      }
      if (value === 0x0a) {
        if (isClosingDelimiter(lineBytes)) return parseFrontmatter(yamlBytes);
        yamlBytes.push(...lineBytes, value);
        lineBytes = [];
      } else {
        lineBytes.push(value);
      }
    }
  } catch (error) {
    if (error instanceof RangeError && error.message === "FRONTMATTER_READ_LIMIT") {
      return { data: {}, diagnostic: "FRONTMATTER_TOO_LARGE", message: "frontmatter 超出安全读取上限" };
    }
    throw error;
  } finally {
    await handle.close();
  }
}
