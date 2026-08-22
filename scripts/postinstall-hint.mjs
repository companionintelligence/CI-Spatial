#!/usr/bin/env node
/**
 * postinstall-hint.mjs — one-time reminder, printed after `npm ci`/`npm
 * install`, pointing at `npm run setup:models`. Print-only: never reads
 * stdin, so it's safe in automated/CI contexts even though none currently
 * invoke npm (.github/workflows/deno-ci.yml installs with `deno install`).
 */
import { formatSetupBanner } from '../src/shared/model-catalog.ts'

console.log('')
console.log(formatSetupBanner(undefined, process.env.OLLAMA_MODEL || null))
console.log('')
