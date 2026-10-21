import { providerPresets, type ModelInfo, type ProviderConfig, type Worker } from '@hive/core';

/**
 * Problems that would prevent a worker from running, shown in the UI before execution.
 * Unverified capabilities produce warnings prefixed with `Warning:`; everything else blocks.
 */
export function workerCompatibilityIssues(
  worker: Worker,
  provider: ProviderConfig | null,
  model: ModelInfo | null,
): string[] {
  const issues: string[] = [];
  if (!worker.providerId || !provider) return ['No provider selected.'];
  if (!provider.enabled) issues.push(`Provider "${provider.name}" is disabled.`);
  if (!provider.hasCredential && !providerPresets[provider.kind].keyOptional) {
    issues.push(`Provider "${provider.name}" has no API key.`);
  }
  if (!worker.modelId) {
    issues.push('No model selected.');
    return issues;
  }
  if (!model) {
    issues.push(
      `Warning: model "${worker.modelId}" is not in the cached catalog; refresh models to verify it exists.`,
    );
    return issues;
  }
  if (model.capabilities.tools === 'no') {
    issues.push(`Model "${model.id}" does not support tool calling, which agents require.`);
  } else if (model.capabilities.tools === 'unknown') {
    issues.push(
      `Warning: tool calling for "${model.id}" is unverified. Use "Probe tools" on the Providers screen.`,
    );
  }
  return issues;
}

export function isBlocking(issues: string[]): boolean {
  return issues.some((issue) => !issue.startsWith('Warning:'));
}
