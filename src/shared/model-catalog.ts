/**
 * Curated catalog of vision-capable Ollama models this app is known to work
 * with, tiered by speed/size so a new user can pick a reasonable one instead
 * of guessing at Ollama's full library. The single source of truth for "what
 * model is the default" and "what models are worth trying" — before this
 * file existed, that was two independent, unsynced literals (inference.ts's
 * silent-fallback list and bench-models.mjs's bench candidate list), which
 * is the ADR 0001 reuse violation this module fixes.
 *
 * Runtime-agnostic (no `Deno.*` / `node:*` imports): imported by Deno server code
 * (inference.ts, main.ts) and by Node scripts (scripts/setup-models.mjs,
 * scripts/bench-models.mjs, scripts/postinstall-hint.mjs) alike, following
 * the src/shared/ precedent (events.ts, cv-palette.ts, test-homes.ts).
 *
 * Deliberately carries no "is this pulled" field — that's a fact about one
 * box's Ollama store right now, not a property of a model, and would go
 * stale the moment someone runs `npm run setup:models`. Callers that need it
 * fetch `${OLLAMA_HOST}/api/tags` live (same rule bench-models.mjs's
 * ensureModel() already uses) and pass the result in.
 */

export type ModelTier = 'ultra-fast' | 'fast' | 'mid' | 'moe-fast-capable' | 'flagship-dense'

export interface CatalogModel {
  /** Exact Ollama tag to pull/run, e.g. 'qwen3-vl:4b'. The one place any given model's tag is authored — nowhere else in the repo should hardcode one of these strings. */
  tag: string
  tier: ModelTier
  /** Human-readable param count, e.g. '4.4B' or '26B (3.8B active MoE)'. Display only, never parsed. */
  params: string
  /** Best-estimate download size in GB. Display + rough sort key, not a guarantee — Ollama's own listing is the source of truth at pull time. */
  approxDiskGB: number
  /** Set when approxDiskGB and/or the active-param figure in `params` wasn't independently verified against ollama.com. Rendered as a qualifier, never silently dropped. */
  unconfirmed?: true
  /** One-line "why this model is in the mix". Optional — left unset rather than inventing copy for entries that don't have one. */
  rationale?: string
  /** Exactly one entry across the whole catalog carries this — see DEFAULT_MODEL_TAG. */
  isProductionDefault?: true
}

export const TIER_ORDER: readonly ModelTier[] = [
  'ultra-fast', 'fast', 'mid', 'moe-fast-capable', 'flagship-dense',
]

export const TIER_LABELS: Record<ModelTier, string> = {
  'ultra-fast': 'Ultra-fast',
  'fast': 'Fast',
  'mid': 'Mid',
  'moe-fast-capable': 'MoE fast-capable',
  'flagship-dense': 'Flagship (dense)',
}

/**
 * Researched 2026-08-21 against this box (RTX 4090, 24GB VRAM) and Ollama's
 * live library (ollama.com/search?c=vision). Re-verify sizes/tags there
 * before trusting an `unconfirmed` entry for anything load-bearing.
 */
export const MODEL_CATALOG: readonly CatalogModel[] = [
  { tag: 'moondream:latest', tier: 'ultra-fast', params: '1B', approxDiskGB: 1.7,
    rationale: 'current floor; weak on complex scenes, 2K context' },
  { tag: 'minicpm-v4.6', tier: 'ultra-fast', params: '1B', approxDiskGB: 1.6,
    rationale: 'second opinion at the same size, different lineage' },

  { tag: 'qwen3-vl:2b', tier: 'fast', params: '2.1B', approxDiskGB: 1.9 },
  { tag: 'qwen3-vl:4b', tier: 'fast', params: '4.4B', approxDiskGB: 3.3,
    isProductionDefault: true, rationale: 'current production default' },
  { tag: 'gemma4:e4b', tier: 'fast', params: '4.5B effective', approxDiskGB: 9.6,
    rationale: 'Google edge tier, cross-family check at similar ambition to 4b' },

  { tag: 'qwen3-vl:8b', tier: 'mid', params: '8.8B', approxDiskGB: 6.1,
    rationale: "already in bench-models.mjs's own default list" },

  { tag: 'gemma4:26b', tier: 'moe-fast-capable', params: '26B (3.8B active MoE)', approxDiskGB: 18,
    rationale: 'near-flagship reasoning at a fraction of dense compute' },
  { tag: 'qwen3-vl:30b', tier: 'moe-fast-capable', params: '~30B (MoE, active-param count unconfirmed)',
    approxDiskGB: 20, unconfirmed: true, rationale: 'same bet, other family' },

  { tag: 'qwen3.8:27b', tier: 'flagship-dense', params: '27.3B', approxDiskGB: 17.7,
    rationale: 'most VRAM headroom of the three flagships' },
  { tag: 'gemma4:31b', tier: 'flagship-dense', params: '30.7B', approxDiskGB: 19.9 },
  { tag: 'qwen3-vl:32b', tier: 'flagship-dense', params: '33.4B', approxDiskGB: 20.9,
    rationale: 'closest to the 24GB ceiling' },
] as const

/** Derived rather than duplicated — see the entry above with isProductionDefault: true. */
export const DEFAULT_MODEL_TAG: string = (() => {
  const defaults = MODEL_CATALOG.filter((m) => m.isProductionDefault)
  if (defaults.length !== 1) {
    throw new Error(
      `model-catalog: expected exactly one isProductionDefault entry, found ${defaults.length}`,
    )
  }
  return defaults[0].tag
})()

/** Groups by TIER_ORDER, preserving catalog array order within each tier. Tiers with no entries are omitted. */
export function groupByTier(
  catalog: readonly CatalogModel[] = MODEL_CATALOG,
): Map<ModelTier, CatalogModel[]> {
  const grouped = new Map<ModelTier, CatalogModel[]>()
  for (const tier of TIER_ORDER) {
    const models = catalog.filter((m) => m.tier === tier)
    if (models.length) grouped.set(tier, models)
  }
  return grouped
}

/**
 * One tag per tier (first entry in catalog order) — bench-models.mjs's
 * default candidate set, so its default stays reconciled with this catalog
 * instead of an independently-hardcoded list.
 */
export function firstPerTier(catalog: readonly CatalogModel[] = MODEL_CATALOG): string[] {
  return [...groupByTier(catalog).values()].map((models) => models[0].tag)
}

/**
 * Plain-text tiered table for terminal output. `installed` is caller-
 * supplied (a live `/api/tags` check) so this module itself never needs
 * network access.
 */
export function formatCatalogTable(opts: {
  catalog?: readonly CatalogModel[]
  installed?: ReadonlySet<string>
} = {}): string {
  const catalog = opts.catalog ?? MODEL_CATALOG
  const installed = opts.installed ?? new Set<string>()
  const indexOf = new Map<string, number>()
  catalog.forEach((model, i) => indexOf.set(model.tag, i + 1))

  const lines: string[] = []
  for (const [tier, models] of groupByTier(catalog)) {
    lines.push(`${TIER_LABELS[tier]}:`)
    for (const model of models) {
      const flags = [
        model.isProductionDefault ? 'default' : null,
        installed.has(model.tag) ? 'installed' : null,
        model.unconfirmed ? 'unconfirmed' : null,
      ].filter(Boolean).join(', ')
      const rationale = model.rationale ? ` — ${model.rationale}` : ''
      lines.push(
        `  ${indexOf.get(model.tag)}) ${model.tag}  (${model.params}, ~${model.approxDiskGB}GB` +
          `${flags ? `, ${flags}` : ''})${rationale}`,
      )
    }
  }
  return lines.join('\n')
}

/**
 * Short first-boot / postinstall banner body. Length follows the catalog
 * rather than a hardcoded count, so it can't itself go stale the way the
 * docs it replaces did.
 *
 * `configuredTag` is caller-supplied (a live env read) so this module itself
 * never needs `Deno.env`/`process.env` access — same rule `formatCatalogTable`'s
 * `installed` param already follows. Omitting it (or passing null) describes
 * the unset case; passing the actual value avoids claiming OLLAMA_MODEL is
 * unset when the caller already knows it isn't.
 */
export function formatSetupBanner(defaultTag: string = DEFAULT_MODEL_TAG, configuredTag: string | null = null): string {
  return [
    configuredTag
      ? `[setup] OLLAMA_MODEL is set to ${configuredTag}.`
      : `[setup] No OLLAMA_MODEL set — using the default vision model:\n[setup]   ${defaultTag}`,
    `[setup] ${MODEL_CATALOG.length} recommended models across ${TIER_ORDER.length} tiers ` +
      '(fast → flagship) are documented.',
    '[setup] Run `npm run setup:models` to see them and install the ones you want.',
  ].join('\n')
}
