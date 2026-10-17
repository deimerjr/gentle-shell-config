/** Offline registry fixture only: these endpoints must never receive a model request. */
export default function assignmentProvider(pi: any): void {
  pi.registerProvider('supervisor-assignment-test', {
    api: 'openai-completions',
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKey: 'offline-test-placeholder',
    models: ['baseline', 'alpha', 'beta'].map(id => ({
      id,
      name: `Assignment test ${id}`,
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 1024,
    })),
  });
}
