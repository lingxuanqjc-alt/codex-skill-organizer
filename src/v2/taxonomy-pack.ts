import {
  BUILTIN_CATEGORY_IDS,
  type BuiltinCategoryId,
  type TaxonomyClassificationInput,
  type TaxonomyClassificationResult,
  type TaxonomyMatcher,
  type TaxonomyPack,
  type TaxonomyRule,
} from "./domain.js";

const categories: TaxonomyPack["categories"] = [
  {
    id: "development",
    label: { zhCN: "开发与工程", enUS: "Development & Engineering" },
    description: { zhCN: "API、框架、CLI、前后端和桌面应用", enUS: "APIs, frameworks, CLI, web and desktop engineering" },
  },
  {
    id: "quality",
    label: { zhCN: "测试与质量", enUS: "Testing & Quality" },
    description: { zhCN: "测试、调试、审查、性能和简化", enUS: "Testing, debugging, review, performance and simplification" },
  },
  {
    id: "security",
    label: { zhCN: "安全与治理", enUS: "Security & Governance" },
    description: { zhCN: "加固、威胁建模、权限和合规", enUS: "Hardening, threat models, access and compliance" },
  },
  {
    id: "delivery",
    label: { zhCN: "交付与运维", enUS: "Delivery & Operations" },
    description: { zhCN: "Git、CI/CD、部署、迁移和监控", enUS: "Git, CI/CD, deployment, migration and operations" },
  },
  {
    id: "data-automation",
    label: { zhCN: "数据与自动化", enUS: "Data & Automation" },
    description: { zhCN: "表格、Notebook、结构化数据和自动化", enUS: "Spreadsheets, notebooks, structured data and automation" },
  },
  {
    id: "docs-knowledge",
    label: { zhCN: "文档与知识", enUS: "Documents & Knowledge" },
    description: { zhCN: "文档、PDF、知识库和资料管理", enUS: "Documents, PDFs, knowledge bases and records" },
  },
  {
    id: "design-media",
    label: { zhCN: "设计与多媒体", enUS: "Design & Media" },
    description: { zhCN: "Figma、Canva、演示、图片和音视频", enUS: "Design, presentations, images, audio and video" },
  },
  {
    id: "research-analysis",
    label: { zhCN: "研究与分析", enUS: "Research & Analysis" },
    description: { zhCN: "论文、网页研究、证据和综合分析", enUS: "Papers, web research, evidence and synthesis" },
  },
  {
    id: "finance-trading",
    label: { zhCN: "金融与交易", enUS: "Finance & Trading" },
    description: { zhCN: "市场数据、资产、策略、风控和估值", enUS: "Markets, assets, strategies, risk and valuation" },
  },
  {
    id: "content-social",
    label: { zhCN: "内容与社媒", enUS: "Content & Social" },
    description: { zhCN: "内容生产、发布和社媒分析", enUS: "Content creation, publishing and social analysis" },
  },
  {
    id: "agent-workflow",
    label: { zhCN: "Agent 与工作流", enUS: "Agents & Workflows" },
    description: { zhCN: "Skill、插件、上下文、目标和规划", enUS: "Skills, plugins, context, goals and planning" },
  },
];

export const DEFAULT_TAXONOMY_PACK: TaxonomyPack = {
  packId: "codex-skill-organizer-default",
  version: 3,
  categories,
  categoryAliases: {
    "开发与工程": "development",
    development: "development",
    "测试与质量": "quality",
    quality: "quality",
    "安全与治理": "security",
    security: "security",
    "交付与运维": "delivery",
    delivery: "delivery",
    "数据与自动化": "data-automation",
    data: "data-automation",
    "文档与知识": "docs-knowledge",
    documentation: "docs-knowledge",
    "设计与多媒体": "design-media",
    design: "design-media",
    "研究与分析": "research-analysis",
    research: "research-analysis",
    "金融与交易": "finance-trading",
    finance: "finance-trading",
    "内容与社媒": "content-social",
    content: "content-social",
    "Agent 与工作流": "agent-workflow",
    agent: "agent-workflow",
  },
  exactSourceRules: [
    {
      id: "source-vibe-trading",
      categoryId: "finance-trading",
      priority: 1000,
      matchers: [{ field: "source", operator: "contains", value: "HKUDS/Vibe-Trading" }],
      tags: ["bundle:vibe-trading"],
    },
    {
      id: "source-paper-reading",
      categoryId: "research-analysis",
      priority: 1000,
      matchers: [{ field: "source", operator: "equals", value: "Agentchengfeng/paper-reading-skills" }],
    },
    {
      id: "source-a-stock-data",
      categoryId: "finance-trading",
      priority: 1000,
      matchers: [{ field: "source", operator: "equals", value: "simonlin1212/a-stock-data" }],
    },
  ],
  bundleRules: [
    {
      id: "bundle-vibe-trading",
      categoryId: "finance-trading",
      priority: 900,
      matchers: [{ field: "package", operator: "equals", value: "vibe-trading" }],
      tags: ["bundle:vibe-trading"],
    },
    {
      id: "bundle-xhs",
      categoryId: "content-social",
      priority: 900,
      matchers: [{ field: "name", operator: "startsWith", value: "xhs" }],
      tags: ["bundle:xhs"],
    },
    {
      id: "bundle-xhs-zh",
      categoryId: "content-social",
      priority: 900,
      matchers: [{ field: "name", operator: "token", value: "小红书" }],
      tags: ["bundle:xhs"],
    },
    ...["figma", "canva", "remotion"].flatMap((bundle): TaxonomyRule[] => ([
      {
        id: `bundle-${bundle}-plugin`,
        categoryId: "design-media",
        priority: 910,
        matchers: [{ field: "plugin", operator: "equals", value: bundle }],
        tags: [`bundle:${bundle}`],
      },
      {
        id: `bundle-${bundle}-name`,
        categoryId: "design-media",
        priority: 900,
        matchers: [{ field: "name", operator: "startsWith", value: bundle }],
        tags: [`bundle:${bundle}`],
      },
    ])),
    {
      id: "bundle-presentations-name",
      categoryId: "design-media",
      priority: 850,
      matchers: [{ field: "name", operator: "token", value: "slides" }],
      tags: ["format:presentation"],
    },
    {
      id: "bundle-ppt-name",
      categoryId: "design-media",
      priority: 850,
      matchers: [{ field: "name", operator: "token", value: "ppt" }],
      tags: ["format:presentation"],
    },
  ],
  keywordRules: Object.entries({
    security: ["security", "threat", "hardening", "vulnerability", "permission", "安全", "权限", "漏洞", "威胁"],
    quality: ["test", "testing", "debug", "debugging", "review", "quality", "performance", "simplification", "playwright", "测试", "调试", "审查", "质量", "性能"],
    delivery: ["deploy", "cloudflare", "vercel", "netlify", "render", "shipping", "release", "migration", "ci-cd", "git-workflow", "observability", "sentry", "部署", "迁移", "交付", "运维"],
    "design-media": ["figma", "canva", "ux", "slide", "slides", "ppt", "presentation", "image", "video", "remotion", "speech", "transcribe", "screenshot", "shader", "设计", "演示", "图片", "视频", "音频"],
    "docs-knowledge": ["document", "documents", "docs", "documentation", "pdf", "knowledge", "notion", "google-drive", "adr", "文档", "知识", "资料"],
    "content-social": ["xhs", "redskill", "social-media", "content", "publish", "小红书", "社媒", "内容", "发布"],
    "finance-trading": ["stock", "trading", "finance", "market", "fund", "option", "crypto", "valuation", "macro", "etf", "bond", "risk", "股票", "金融", "交易", "市场", "基金", "期权", "估值", "风控"],
    "research-analysis": ["research", "paper", "literature", "analysis", "evidence", "study", "论文", "研究", "分析", "证据"],
    "data-automation": ["spreadsheet", "spreadsheets", "excel", "jupyter", "data", "automation", "chart", "charts", "dataset", "数据", "自动化", "表格", "图表"],
    "agent-workflow": ["skill", "plugin", "agent", "context", "goal", "planning", "prompt", "workflow", "linear", "mcp", "技能", "插件", "工作流", "规划"],
    development: ["api", "frontend", "backend", "aspnet", "winui", "cli", "code", "developer", "engineering", "workbench", "spec", "app", "sdk", "开发", "工程", "代码", "应用"],
  }).flatMap(([categoryId, keywords], categoryIndex) => keywords.flatMap((value, index): TaxonomyRule[] => ([
    {
      id: `keyword-name-${categoryId}-${index}`,
      categoryId: categoryId as BuiltinCategoryId,
      priority: 400 - categoryIndex,
      matchers: [{ field: "name", operator: "token", value }],
    },
    {
      id: `keyword-search-${categoryId}-${index}`,
      categoryId: categoryId as BuiltinCategoryId,
      // Description/source evidence is weaker than an explicit name token.
      priority: 200 - categoryIndex,
      matchers: [{ field: "searchable", operator: "token", value }],
    },
  ]))),
  migrationAliases: {
    engineering: "development",
    testing: "quality",
    governance: "security",
    operations: "delivery",
    automation: "data-automation",
    knowledge: "docs-knowledge",
    media: "design-media",
    analysis: "research-analysis",
    trading: "finance-trading",
    social: "content-social",
    workflow: "agent-workflow",
  },
};

const BUILTIN_CATEGORY_SET = new Set<string>(BUILTIN_CATEGORY_IDS);

export function assertTaxonomyPack(pack: TaxonomyPack): void {
  if (!pack.packId.trim() || !Number.isInteger(pack.version) || pack.version < 1) {
    throw new Error("TaxonomyPack packId/version 无效");
  }
  const ids = pack.categories.map((category) => category.id);
  if (ids.length !== BUILTIN_CATEGORY_IDS.length || new Set(ids).size !== BUILTIN_CATEGORY_IDS.length) {
    throw new Error("TaxonomyPack 必须且只能声明 11 个内置分类");
  }
  for (const id of BUILTIN_CATEGORY_IDS) {
    if (!ids.includes(id)) throw new Error(`TaxonomyPack 缺少内置分类: ${id}`);
  }
  const allRules = [...pack.exactSourceRules, ...pack.bundleRules, ...pack.keywordRules];
  if (new Set(allRules.map((rule) => rule.id)).size !== allRules.length) {
    throw new Error("TaxonomyPack rule id 必须唯一");
  }
  for (const rule of allRules) {
    if (!BUILTIN_CATEGORY_SET.has(rule.categoryId) || rule.matchers.length === 0) {
      throw new Error(`TaxonomyPack rule 无效: ${rule.id}`);
    }
  }
  for (const [alias, categoryId] of Object.entries({ ...pack.categoryAliases, ...pack.migrationAliases })) {
    if (!alias.trim() || !BUILTIN_CATEGORY_SET.has(categoryId)) {
      throw new Error(`TaxonomyPack alias 无效: ${alias}`);
    }
  }
}

export function resolveTaxonomyCategoryAlias(pack: TaxonomyPack, value: string | null): BuiltinCategoryId | null {
  if (!value) return null;
  const normalized = value.normalize("NFC").trim();
  if (BUILTIN_CATEGORY_SET.has(normalized)) return normalized as BuiltinCategoryId;
  const alias = Object.entries({ ...pack.migrationAliases, ...pack.categoryAliases })
    .find(([candidate]) => candidate.localeCompare(normalized, undefined, { sensitivity: "accent" }) === 0);
  return alias?.[1] ?? null;
}

function normalizedField(input: TaxonomyClassificationInput, field: TaxonomyMatcher["field"]): string {
  const value = field === "searchable"
    ? [input.name, input.description, input.source, input.packageId, input.pluginId ?? ""].join(" ")
    : field === "source"
    ? input.source
    : field === "package"
      ? input.packageId
      : field === "plugin"
        ? input.pluginId ?? ""
        : field === "relativePath"
          ? input.relativePath.replaceAll("\\", "/")
          : field === "name"
            ? input.name
            : input.description;
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function matches(input: TaxonomyClassificationInput, matcher: TaxonomyMatcher): boolean {
  const actual = normalizedField(input, matcher.field);
  const expected = matcher.value.normalize("NFC").toLocaleLowerCase("en-US");
  if (matcher.operator === "equals") return actual === expected;
  if (matcher.operator === "startsWith") return actual.startsWith(expected);
  if (matcher.operator === "token") {
    if (/\p{Script=Han}/u.test(expected)) return actual.includes(expected);
    const actualTokens = actual.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const expectedTokens = expected.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (expectedTokens.length === 0 || expectedTokens.length > actualTokens.length) return false;
    return actualTokens.some((_, start) => expectedTokens.every((token, offset) => actualTokens[start + offset] === token));
  }
  return actual.includes(expected);
}

function firstMatchingRule(input: TaxonomyClassificationInput, rules: TaxonomyRule[]): TaxonomyRule | null {
  return [...rules]
    .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))
    .find((rule) => rule.matchers.every((matcher) => matches(input, matcher))) ?? null;
}

export function classifyWithTaxonomy(
  pack: TaxonomyPack,
  input: TaxonomyClassificationInput,
): TaxonomyClassificationResult {
  assertTaxonomyPack(pack);
  const phases: Array<[TaxonomyClassificationResult["source"], TaxonomyRule[]]> = [
    ["exact-source", pack.exactSourceRules],
    ["bundle", pack.bundleRules],
  ];
  for (const [source, rules] of phases) {
    const rule = firstMatchingRule(input, rules);
    if (rule) {
      const tags = [...(rule.tags ?? [])];
      if (rule.id.includes("vibe-trading") && input.existingCategory) {
        const secondary = input.existingCategory.normalize("NFC").trim().toLocaleLowerCase("en-US").replace(/\s+/g, "-");
        if (secondary) tags.push(`taxonomy:vibe/${secondary}`);
      }
      return { categoryId: rule.categoryId, tags: [...new Set(tags)].sort(), source, ruleId: rule.id };
    }
  }
  const existing = resolveTaxonomyCategoryAlias(pack, input.existingCategory);
  if (existing) return { categoryId: existing, tags: [], source: "existing-category", ruleId: null };
  const keyword = firstMatchingRule(input, pack.keywordRules);
  if (keyword) {
    return { categoryId: keyword.categoryId, tags: [...(keyword.tags ?? [])], source: "keyword", ruleId: keyword.id };
  }
  return { categoryId: null, tags: [], source: "pending", ruleId: null };
}

assertTaxonomyPack(DEFAULT_TAXONOMY_PACK);
