export const HTML_IN_CANVAS_BLINK_FEATURE = 'CanvasDrawElement'

interface BlinkFeatureWebPreferences extends Record<string, unknown> {
  enableBlinkFeatures?: string
}

export function withHtmlInCanvasWebPreferences<T extends BlinkFeatureWebPreferences>(
  webPreferences: T,
): T & { enableBlinkFeatures: string } {
  return {
    ...webPreferences,
    enableBlinkFeatures: appendBlinkFeature(
      webPreferences.enableBlinkFeatures,
      HTML_IN_CANVAS_BLINK_FEATURE,
    ),
  }
}

function appendBlinkFeature(current: string | undefined, feature: string): string {
  const features = (current || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)

  if (!features.includes(feature)) {
    features.push(feature)
  }

  return features.join(',')
}
