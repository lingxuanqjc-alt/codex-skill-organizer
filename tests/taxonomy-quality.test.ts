import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  BUILTIN_CATEGORY_IDS,
  DEFAULT_TAXONOMY_PACK,
  classifyWithTaxonomy,
  type BuiltinCategoryId,
  type TaxonomyClassificationInput,
} from "../src/v2/index.js";

interface PublicHoldoutFixture {
  frontmatter_name: string;
  frontmatter_description: string;
  repo: string;
  path: string;
  content_sha256: string;
  /** Human-reviewed Skill Organizer category; not the corpus classifier output. */
  category: BuiltinCategoryId;
}

interface AmbiguousControl {
  name: string;
  description: string;
}

const PUBLIC_HOLDOUT_PATH = fileURLToPath(new URL("fixtures/public-taxonomy-holdout.jsonl", import.meta.url));
const PUBLIC_HOLDOUT_FIELDS = [
  "category",
  "content_sha256",
  "frontmatter_description",
  "frontmatter_name",
  "path",
  "repo",
];

const publicHoldout = readFileSync(PUBLIC_HOLDOUT_PATH, "utf8")
  .split(/\r?\n/u)
  .filter(Boolean)
  .map((line, index): PublicHoldoutFixture => {
    const record = JSON.parse(line) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(record).sort(),
      PUBLIC_HOLDOUT_FIELDS,
      `holdout row ${index + 1} must contain metadata-only audit fields`,
    );
    for (const field of PUBLIC_HOLDOUT_FIELDS) {
      assert.equal(typeof record[field], "string", `holdout row ${index + 1} field ${field} must be a string`);
    }
    assert.ok(
      BUILTIN_CATEGORY_IDS.includes(record.category as BuiltinCategoryId),
      `holdout row ${index + 1} has an unknown human-reviewed category`,
    );
    assert.match(record.content_sha256 as string, /^[a-f0-9]{64}$/u, `holdout row ${index + 1} has an invalid hash`);
    return record as unknown as PublicHoldoutFixture;
  });

const ambiguousControls: AmbiguousControl[] = [
  { name: "lantern-helper", description: "Keeps reusable local routines in one place." },
  { name: "quartz-kit", description: "Small utilities for daily tasks." },
  { name: "blue-orbit", description: "Connects selected inputs to outputs." },
  { name: "meadow", description: "Organizes reusable snippets." },
  { name: "relay-box", description: "A general-purpose companion." },
  { name: "compass-room", description: "Helps navigate unfamiliar work." },
  { name: "pocket-shelf", description: "Collects frequently used shortcuts." },
  { name: "amber-loop", description: "Runs a configurable sequence." },
];

function toClassificationInput(fixture: PublicHoldoutFixture): TaxonomyClassificationInput {
  return {
    source: fixture.repo,
    packageId: fixture.repo.split("/").at(-1) ?? fixture.repo,
    pluginId: null,
    relativePath: fixture.path,
    name: fixture.frontmatter_name,
    description: fixture.frontmatter_description,
    existingCategory: null,
  };
}

test("pinned public metadata holdout is broad, deduplicated, and auditable", () => {
  assert.ok(publicHoldout.length >= 55, "public holdout must contain at least 55 unfamiliar skills");
  assert.equal(
    new Set(publicHoldout.map((fixture) => fixture.content_sha256)).size,
    publicHoldout.length,
    "content hashes must stay deduplicated",
  );

  for (const categoryId of BUILTIN_CATEGORY_IDS) {
    const categoryFixtures = publicHoldout.filter((fixture) => fixture.category === categoryId);
    assert.ok(categoryFixtures.length >= 5, `${categoryId} must retain at least five human-reviewed examples`);
    assert.ok(
      new Set(categoryFixtures.map((fixture) => fixture.repo)).size >= 3,
      `${categoryId} must span multiple upstream repositories`,
    );
  }
});

test("unfamiliar public metadata clears the 80% coverage and 90% precision release gates", () => {
  const results = publicHoldout.map((fixture) => ({
    fixture,
    result: classifyWithTaxonomy(DEFAULT_TAXONOMY_PACK, toClassificationInput(fixture)),
  }));
  const automaticallyClassified = results.filter(({ result }) => result.categoryId !== null);
  const correctlyClassified = automaticallyClassified.filter(({ fixture, result }) => (
    result.categoryId === fixture.category
  ));
  const coverage = automaticallyClassified.length / results.length;
  const precision = correctlyClassified.length / automaticallyClassified.length;
  const misses = results
    .filter(({ fixture, result }) => result.categoryId !== fixture.category)
    .map(({ fixture, result }) => (
      `${fixture.repo}/${fixture.path}: expected=${fixture.category}, actual=${result.categoryId ?? "pending"}`
    ));

  assert.ok(coverage >= 0.8, `automatic coverage ${(coverage * 100).toFixed(1)}% is below 80%; misses: ${misses.join("; ")}`);
  assert.ok(
    precision >= 0.9,
    `automatic precision ${(precision * 100).toFixed(1)}% is below 90%; misses: ${misses.join("; ")}`,
  );
  assert.ok(
    BUILTIN_CATEGORY_IDS.every((categoryId) => correctlyClassified.some(({ fixture }) => fixture.category === categoryId)),
    `at least one public example per category must classify correctly; misses: ${misses.join("; ")}`,
  );
});

test("separate ambiguous controls remain pending instead of receiving invented certainty", () => {
  const failures = ambiguousControls
    .map((fixture) => ({
      fixture,
      result: classifyWithTaxonomy(DEFAULT_TAXONOMY_PACK, {
        source: "holdout-controls/ambiguous",
        packageId: "ambiguous-controls",
        pluginId: null,
        relativePath: `${fixture.name}/SKILL.md`,
        name: fixture.name,
        description: fixture.description,
        existingCategory: null,
      }),
    }))
    .filter(({ result }) => result.source !== "pending" || result.categoryId !== null)
    .map(({ fixture, result }) => `${fixture.name}: ${result.categoryId ?? result.source}`);

  assert.deepEqual(failures, []);
});
