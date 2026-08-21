/**
 * Contract for locally retained, privacy-sensitive real-camera fixtures.
 * Assets live in ignored `test-data/real-camera/`; only this validator and its
 * documentation are committed. Synthetic fixtures must never enter this bank.
 */
export interface RealCameraFixture {
  fixtureId: string
  source: 'android-real-camera'
  deviceId: string
  deviceModel?: string
  place: string
  area?: string | null
  capturedAt: string
  location: {
    latitude?: number | null
    longitude?: number | null
    accuracyM?: number | null
    label: string
  }
  artifacts: {
    cameraPhoto: string
    tagScreenshot: string
  }
  verification: {
    realCameraVisible: true
    solidColorScreen: false
    generatedTagsVisible: true
    notes?: string
  }
}

export interface RealCameraFixtureManifest {
  version: 1
  generatedAt: string
  fixtures: RealCameraFixture[]
}

export function validateRealCameraFixtureManifest(value: unknown): string[] {
  const issues: string[] = []
  if (!value || typeof value !== 'object') return ['manifest must be an object']
  const manifest = value as Partial<RealCameraFixtureManifest>
  if (manifest.version !== 1) issues.push('version must be 1')
  if (!isTimestamp(manifest.generatedAt)) issues.push('generatedAt must be an ISO timestamp')
  if (!Array.isArray(manifest.fixtures) || manifest.fixtures.length === 0) {
    issues.push('fixtures must contain at least one real-camera capture')
    return issues
  }
  const ids = new Set<string>()
  for (const [index, fixture] of manifest.fixtures.entries()) {
    const prefix = `fixtures[${index}]`
    if (!fixture || typeof fixture !== 'object') {
      issues.push(`${prefix} must be an object`)
      continue
    }
    if (!isText(fixture.fixtureId)) issues.push(`${prefix}.fixtureId is required`)
    else if (ids.has(fixture.fixtureId)) issues.push(`${prefix}.fixtureId must be unique`)
    else ids.add(fixture.fixtureId)
    if (fixture.source !== 'android-real-camera') issues.push(`${prefix}.source must be android-real-camera`)
    if (!isText(fixture.deviceId)) issues.push(`${prefix}.deviceId is required`)
    if (!isText(fixture.place)) issues.push(`${prefix}.place is required`)
    if (!isTimestamp(fixture.capturedAt)) issues.push(`${prefix}.capturedAt must be an ISO timestamp`)
    if (!fixture.location || !isText(fixture.location.label)) issues.push(`${prefix}.location.label is required`)
    if (!fixture.artifacts || !isSafeRelativeAsset(fixture.artifacts.cameraPhoto)) {
      issues.push(`${prefix}.artifacts.cameraPhoto must be a relative asset path`)
    }
    if (!fixture.artifacts || !isSafeRelativeAsset(fixture.artifacts.tagScreenshot)) {
      issues.push(`${prefix}.artifacts.tagScreenshot must be a relative asset path`)
    }
    if (fixture.verification?.realCameraVisible !== true) issues.push(`${prefix} must verify a visible real camera feed`)
    if (fixture.verification?.solidColorScreen !== false) issues.push(`${prefix} must reject solid-color camera screens`)
    if (fixture.verification?.generatedTagsVisible !== true) issues.push(`${prefix} must verify generated tags in its screenshot`)
  }
  return issues
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isTimestamp(value: unknown): boolean {
  return isText(value) && Number.isFinite(Date.parse(value))
}

function isSafeRelativeAsset(value: unknown): boolean {
  return isText(value)
    && !value.startsWith('/')
    && !value.includes('..')
    && /\.(?:jpe?g|png|webp)$/i.test(value)
}
