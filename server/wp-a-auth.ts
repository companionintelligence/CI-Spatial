/**
 * Whether world writes need that world's token.
 *
 * Strict mode is on when sign-in is on, or when either flag asks for it.
 * WORLD_STRICT_AUTH=1 turns it on alone. SCAN_REQUIRE_AUTH=1 turns it on too: it also
 * gates the session routes, and with sign-in off no request gets past that gate.
 */
export function worldStrictAuthOn(readEnv: (name: string) => string | undefined, portalEnabled: boolean): boolean {
  return readEnv('WORLD_STRICT_AUTH') === '1' || readEnv('SCAN_REQUIRE_AUTH') === '1' || portalEnabled
}
