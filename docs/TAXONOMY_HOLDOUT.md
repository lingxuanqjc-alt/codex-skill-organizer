# Taxonomy public holdout

## Purpose

The taxonomy release gate uses a pinned, metadata-only holdout from
[`lawrence3699/agent-skills-corpus`](https://github.com/lawrence3699/agent-skills-corpus/tree/5b5b4df597b0474c01f6a28f2061c109d3ad9d72),
commit `5b5b4df597b0474c01f6a28f2061c109d3ad9d72`. The corpus metadata is
dedicated to the public domain under
[CC0-1.0](https://github.com/lawrence3699/agent-skills-corpus/blob/5b5b4df597b0474c01f6a28f2061c109d3ad9d72/LICENSE).

The checked-in fixture is
`tests/fixtures/public-taxonomy-holdout.jsonl`. It contains 55 records: five
for each stable built-in category, drawn from 55 repositories and deduplicated
by the upstream `content_sha256`. Each row retains only:

- `frontmatter_name`
- `frontmatter_description`
- `repo`
- `path`
- `content_sha256`
- `category`

No `SKILL.md` body, asset, sibling-file list, credential, or executable content
is copied into this repository.

## Review boundary

This is a purposive, category-stratified holdout, not a statistical random
sample and not an estimate for the whole Agent Skills universe. It is also not
built from the maintainer's local Skill inventory. The examples were selected
because a reviewer could assign one primary Skill Organizer category from the
name and description without opening the body.

The corpus' own functional category is keyword-derived and approximate. It was
used only to find review candidates. The fixture's `category` field is the
human-reviewed expected Skill Organizer category, assigned against this
project's 11 stable category definitions before running the project classifier.
It is not copied from the corpus classifier and is not generated from the
current TaxonomyPack output.

Human review date: **2026-08-30**.

## Release gate

`tests/taxonomy-quality.test.ts` verifies that:

- the fixture has at least 55 rows and at least five per built-in category;
- every category spans at least three source repositories;
- content hashes are unique and each row contains metadata-only audit fields;
- automatic classification coverage is at least 80%;
- precision among automatically classified rows is at least 90%;
- at least one row in every category is classified correctly; and
- a separate set of intentionally ambiguous controls remains pending.

For TaxonomyPack version 3, the pinned holdout result on 2026-08-30 was 55/55
automatically classified (100.0% coverage) and 50/55 correctly classified
(90.9% precision). This number describes only this bounded holdout.

## Refresh procedure

1. Choose and record an immutable corpus commit. Do not silently follow the
   upstream default branch.
2. Read only the public metadata tables under `data/by_category/` (or the
   equivalent public master metadata table). Never copy or execute Skill bodies.
3. Select at least five clearly reviewable records for every stable built-in
   category, with at least three repositories per category.
4. Deduplicate the selection by `content_sha256`. Preserve exact upstream name,
   description, repository, path, and hash values.
5. Before running this project's classifier, have a reviewer assign the
   expected Skill Organizer category from the published category definitions.
   Disputed or genuinely ambiguous records belong in the separate fail-closed
   controls, not in the precision denominator.
6. Replace the JSONL fixture using only the six fields listed above, update the
   pinned commit and review date in this document, and verify each metadata row
   byte-for-value against the pinned corpus snapshot.
7. Run `npx tsx --test tests/taxonomy-quality.test.ts`, then the complete
   `npm test` suite. If the gate fails, prefer small category-general rules that
   are supported by multiple examples; do not add repository- or path-specific
   exceptions to make the holdout pass.

When category definitions change, re-review the expected labels instead of
mechanically translating the previous labels.
