import { describe, expect, it } from 'vitest';
import { normalizeModels } from './models';

const endpoint = { providerId: 'p1', kind: 'openrouter', baseUrl: 'x', apiKey: null } as const;

describe('normalizeModels', () => {
  it('sabe quais modelos enxergam imagens pelo catálogo', () => {
    const models = normalizeModels(endpoint, {
      data: [
        { id: 'a/vision', architecture: { input_modalities: ['text', 'image'] } },
        { id: 'b/text', architecture: { input_modalities: ['text'] } },
        { id: 'c/plain' },
      ],
    });
    const vision = Object.fromEntries(models.map((m) => [m.id, m.capabilities.vision]));
    expect(vision).toEqual({ 'a/vision': 'yes', 'b/text': 'no', 'c/plain': 'unknown' });
  });
});
