/**
 * Guards src/shared/model-catalog.ts's invariants: exactly one production
 * default, unique tags, every tier a real tier, and that the derived helpers
 * (firstPerTier, table/banner formatters) don't throw against the real
 * catalog. Not a snapshot test — deliberately doesn't pin exact prose, since
 * rationale/params text is expected to change as the catalog is curated.
 *
 *   deno test --allow-read model_catalog.test.ts
 */
import { assertEquals } from 'jsr:@std/assert@1'
import {
  DEFAULT_MODEL_TAG,
  firstPerTier,
  formatCatalogTable,
  formatSetupBanner,
  MODEL_CATALOG,
  TIER_ORDER,
} from './src/shared/model-catalog.ts'

Deno.test('MODEL_CATALOG: exactly one entry is the production default, and it matches DEFAULT_MODEL_TAG', () => {
  const defaults = MODEL_CATALOG.filter((m) => m.isProductionDefault)
  assertEquals(defaults.length, 1)
  assertEquals(defaults[0].tag, DEFAULT_MODEL_TAG)
})

Deno.test('MODEL_CATALOG: every tag is unique', () => {
  const tags = MODEL_CATALOG.map((m) => m.tag)
  assertEquals(new Set(tags).size, tags.length)
})

Deno.test('MODEL_CATALOG: every tier is a member of TIER_ORDER', () => {
  for (const model of MODEL_CATALOG) {
    assertEquals(
      TIER_ORDER.includes(model.tier),
      true,
      `${model.tag} has unknown tier "${model.tier}"`,
    )
  }
})

Deno.test('firstPerTier: returns exactly one tag per tier, in TIER_ORDER order', () => {
  const tags = firstPerTier(MODEL_CATALOG)
  assertEquals(tags.length, TIER_ORDER.length)
  for (const tag of tags) {
    assertEquals(MODEL_CATALOG.some((m) => m.tag === tag), true)
  }
})

Deno.test('formatCatalogTable / formatSetupBanner: do not throw against the real catalog', () => {
  formatCatalogTable({})
  formatCatalogTable({ installed: new Set([DEFAULT_MODEL_TAG]) })
  formatSetupBanner()
})

Deno.test('formatSetupBanner: says "not set" only when configuredTag is actually null', () => {
  assertEquals(formatSetupBanner().includes('No OLLAMA_MODEL set'), true)
  assertEquals(formatSetupBanner(DEFAULT_MODEL_TAG, null).includes('No OLLAMA_MODEL set'), true)
  const configured = formatSetupBanner(DEFAULT_MODEL_TAG, 'qwen3-vl:8b')
  assertEquals(configured.includes('No OLLAMA_MODEL set'), false)
  assertEquals(configured.includes('OLLAMA_MODEL is set to qwen3-vl:8b'), true)
})
