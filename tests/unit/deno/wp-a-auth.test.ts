/**
 * Strict world auth (server/wp-a-auth.ts). SCAN_REQUIRE_AUTH=1 turns strict world auth on, as
 * WORLD_STRICT_AUTH=1 does. With no flags and sign-in off, world writes stay open.
 */
import { assertEquals } from 'jsr:@std/assert@^1.0.0'
import { worldStrictAuthOn } from '../../../server/wp-a-auth.ts'

const env = (vars: Record<string, string>) => (name: string) => vars[name]

Deno.test('with no flags and sign-in off, world writes stay as they were (open)', () => {
  assertEquals(worldStrictAuthOn(env({}), false), false)
})

Deno.test('SCAN_REQUIRE_AUTH=1 makes world writes strict even with sign-in off', () => {
  assertEquals(worldStrictAuthOn(env({ SCAN_REQUIRE_AUTH: '1' }), false), true)
})

Deno.test('WORLD_STRICT_AUTH=1 still makes world writes strict', () => {
  assertEquals(worldStrictAuthOn(env({ WORLD_STRICT_AUTH: '1' }), false), true)
})

Deno.test('sign-in on is strict, whatever the flags say', () => {
  assertEquals(worldStrictAuthOn(env({}), true), true)
})

Deno.test('only the value 1 turns a flag on', () => {
  assertEquals(worldStrictAuthOn(env({ SCAN_REQUIRE_AUTH: '0', WORLD_STRICT_AUTH: 'true' }), false), false)
})
