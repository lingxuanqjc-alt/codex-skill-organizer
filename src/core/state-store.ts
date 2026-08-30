import { copyFile, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { OrganizerBackupV1, OrganizerStateV1, SkillOverride } from "../shared/types.js";
import { isCategoryId, TAXONOMY_VERSION, validateTagId, normalizeTagId } from "./taxonomy.js";

export class StateValidationError extends Error {}

export interface StateStoreOptions {
  moveFile?: typeof rename;
}

function initialState(): OrganizerStateV1 {
  return {
    schemaVersion: 1,
    revision: 0,
    taxonomyVersion: TAXONOMY_VERSION,
    updatedAt: new Date(0).toISOString(),
    overrides: {},
  };
}

function validateOverride(value: unknown): SkillOverride {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StateValidationError("override 必须是对象");
  }
  const item = value as Record<string, unknown>;
  if (item.primaryCategoryId !== undefined && item.primaryCategoryId !== null && !isCategoryId(item.primaryCategoryId)) {
    throw new StateValidationError("override 包含未知分类");
  }
  const readTags = (key: string): string[] => {
    const raw = item[key];
    if (!Array.isArray(raw) || !raw.every(validateTagId)) {
      throw new StateValidationError(`${key} 必须是有效标签数组`);
    }
    return [...new Set(raw.map((tag) => normalizeTagId(String(tag))))].sort();
  };
  if (typeof item.favorite !== "boolean" || typeof item.locked !== "boolean") {
    throw new StateValidationError("override favorite/locked 必须是布尔值");
  }
  if (typeof item.updatedAt !== "string" || Number.isNaN(Date.parse(item.updatedAt))) {
    throw new StateValidationError("override updatedAt 无效");
  }
  if (typeof item.taxonomyVersion !== "number" || !Number.isInteger(item.taxonomyVersion)) {
    throw new StateValidationError("override taxonomyVersion 无效");
  }
  return {
    primaryCategoryId: item.primaryCategoryId as SkillOverride["primaryCategoryId"],
    addedTagIds: readTags("addedTagIds"),
    removedTagIds: readTags("removedTagIds"),
    favorite: item.favorite,
    locked: item.locked,
    updatedAt: item.updatedAt,
    taxonomyVersion: item.taxonomyVersion,
    reason: typeof item.reason === "string" ? item.reason.slice(0, 500) : undefined,
  };
}

export function validateState(value: unknown): OrganizerStateV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StateValidationError("state 必须是对象");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) throw new StateValidationError("不支持的 state schemaVersion");
  if (typeof record.revision !== "number" || !Number.isInteger(record.revision) || record.revision < 0) {
    throw new StateValidationError("state revision 无效");
  }
  if (typeof record.taxonomyVersion !== "number" || !Number.isInteger(record.taxonomyVersion)) {
    throw new StateValidationError("state taxonomyVersion 无效");
  }
  if (typeof record.updatedAt !== "string" || Number.isNaN(Date.parse(record.updatedAt))) {
    throw new StateValidationError("state updatedAt 无效");
  }
  if (!record.overrides || typeof record.overrides !== "object" || Array.isArray(record.overrides)) {
    throw new StateValidationError("state overrides 无效");
  }
  const overrides: Record<string, SkillOverride> = {};
  for (const [skillId, override] of Object.entries(record.overrides as Record<string, unknown>)) {
    if (!/^[a-f0-9]{64}$/.test(skillId)) throw new StateValidationError(`无效 skillId: ${skillId}`);
    overrides[skillId] = validateOverride(override);
  }
  return {
    schemaVersion: 1,
    revision: record.revision,
    taxonomyVersion: record.taxonomyVersion,
    updatedAt: record.updatedAt,
    overrides,
  };
}

export function validateBackup(value: unknown): OrganizerBackupV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StateValidationError("备份必须是对象");
  }
  const record = value as Record<string, unknown>;
  if (record.format !== "codex-skill-organizer-backup" || record.version !== 1) {
    throw new StateValidationError("备份格式或版本不受支持");
  }
  if (typeof record.exportedAt !== "string" || Number.isNaN(Date.parse(record.exportedAt))) {
    throw new StateValidationError("备份 exportedAt 无效");
  }
  return {
    format: "codex-skill-organizer-backup",
    version: 1,
    exportedAt: record.exportedAt,
    state: validateState(record.state),
  };
}

export class StateStore {
  readonly filePath: string;
  readonly previousPath: string;
  readonly nextPath: string;
  readonly #moveFile: typeof rename;
  #state: OrganizerStateV1 = initialState();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(filePath: string, options: StateStoreOptions = {}) {
    this.filePath = filePath;
    this.previousPath = `${filePath}.previous`;
    this.nextPath = `${filePath}.next`;
    this.#moveFile = options.moveFile ?? rename;
  }

  async load(): Promise<OrganizerStateV1> {
    try {
      const pending = validateState(JSON.parse(await readFile(this.nextPath, "utf8")));
      await this.#copyDurably(this.nextPath, this.filePath);
      await unlink(this.nextPath);
      this.#state = pending;
      return this.snapshot();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof StateValidationError)) {
        throw error;
      }
    }
    try {
      const raw = await readFile(this.filePath, "utf8");
      this.#state = validateState(JSON.parse(raw));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
      this.#state = initialState();
    }
    return this.snapshot();
  }

  snapshot(): OrganizerStateV1 {
    return structuredClone(this.#state);
  }

  exportBackup(): OrganizerBackupV1 {
    return {
      format: "codex-skill-organizer-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      state: this.snapshot(),
    };
  }

  async update(
    mutator: (current: OrganizerStateV1) => OrganizerStateV1 | void,
  ): Promise<OrganizerStateV1> {
    const run = async (): Promise<OrganizerStateV1> => {
      const draft = this.snapshot();
      const result = mutator(draft) ?? draft;
      result.schemaVersion = 1;
      result.taxonomyVersion = TAXONOMY_VERSION;
      result.revision = this.#state.revision + 1;
      result.updatedAt = new Date().toISOString();
      const nextState = validateState(result);
      await this.#persist(nextState);
      this.#state = nextState;
      return this.snapshot();
    };
    const operation = this.#queue.then(run, run);
    this.#queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async importBackup(backupValue: unknown, mode: "merge" | "replace"): Promise<OrganizerStateV1> {
    const backup = validateBackup(backupValue);
    return this.update((draft) => {
      draft.overrides = mode === "replace"
        ? structuredClone(backup.state.overrides)
        : { ...draft.overrides, ...structuredClone(backup.state.overrides) };
    });
  }

  async clear(): Promise<OrganizerStateV1> {
    return this.update((draft) => {
      draft.overrides = {};
    });
  }

  async #persist(nextState: OrganizerStateV1): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const json = `${JSON.stringify(nextState, null, 2)}\n`;
    try {
      await copyFile(this.filePath, this.previousPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await this.#writeDurably(this.nextPath, json);
    try {
      await this.#moveFile(this.nextPath, this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      // EFS-encrypted Windows directories can reject even a same-directory rename
      // with EXDEV. The durable .next journal remains the recovery source until the
      // validated payload has been copied and flushed to its final path.
      await this.#copyDurably(this.nextPath, this.filePath);
      await unlink(this.nextPath);
    }
  }

  async #writeDurably(filePath: string, contents: string): Promise<void> {
    const handle = await open(filePath, "w", 0o600);
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async #copyDurably(sourcePath: string, destinationPath: string): Promise<void> {
    await copyFile(sourcePath, destinationPath);
    const handle = await open(destinationPath, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
