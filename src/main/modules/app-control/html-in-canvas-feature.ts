export const HTML_IN_CANVAS_BLINK_FEATURE = 'CanvasDrawElement'
export const BROWSER_AUTOPLAY_POLICY = 'user-gesture-required'

interface BlinkFeatureWebPreferences extends Record<string, unknown> {
  enableBlinkFeatures?: string
}

export function withHtmlInCanvasWebPreferences<T extends BlinkFeatureWebPreferences>(
  webPreferences: T,
): T & { enableBlinkFeatures: string; autoplayPolicy: typeof BROWSER_AUTOPLAY_POLICY } {
  return {
    ...webPreferences,
    autoplayPolicy: BROWSER_AUTOPLAY_POLICY,
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
