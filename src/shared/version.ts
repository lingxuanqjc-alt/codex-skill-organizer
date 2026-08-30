import packageMetadata from "../../package.json" with { type: "json" };

export const PRODUCT_NAME = "Skill Organizer for Codex";
export const SERVICE_ID = "codex-skill-organizer";
export const PRODUCT_VERSION = packageMetadata.version;

export const PROTOCOL_VERSION = "2.0";
export const PROTOCOL_MIN = "2.0";
export const PROTOCOL_MAX = "2.x";

export function isCompatibleProtocol(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("2.");
}
