import { writeFileSync } from 'node:fs';
import { supportedModelEfforts } from '../../src/model-effort.ts';

/**
 * Offline registry fixture plus capability probe. The endpoint must never receive a model
 * request. The probe compares this extension's capability discovery with the host's own
 * public resolver, loaded through the same virtual-module path as production.
 */
export const EFFORT_PROVIDER = 'supervisor-effort-test';

export default function effortProvider(pi: any): void {
  pi.registerProvider(EFFORT_PROVIDER, {
    api: 'openai-completions',
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKey: 'offline-test-placeholder',
    models: [
      { id: 'baseline', reasoning: false },
      { id: 'reasoner', reasoning: true },
    ].map(model => ({
      ...model,
      name: `Effort test ${model.id}`,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 1024,
    })),
  });
  const output = process.env.SUPERVISOR_EFFORT_PROBE;
  if (!output) return;
  pi.on('session_start', async (_event: any, ctx: any) => {
    const compat: any = await import('@earendil-works/pi-ai/compat');
    const result: Record<string, unknown> = {};
    for (const id of ['baseline', 'reasoner']) {
      const model = ctx.modelRegistry.find(EFFORT_PROVIDER, id);
      result[id] = {
        extension: await supportedModelEfforts(model),
        host: compat.getSupportedThinkingLevels(model),
      };
    }
    writeFileSync(output, JSON.stringify(result));
  });
}
