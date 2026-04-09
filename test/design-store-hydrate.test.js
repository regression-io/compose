import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const messages = [
  {
    role: 'human',
    type: 'text',
    content: 'We need a design for this workflow.',
    timestamp: '2026-04-09T10:00:00.000Z',
  },
];

const decisions = [
  {
    question: 'How should jobs run?',
    selectedOption: { title: 'Queued workers', bullets: ['Process work asynchronously'] },
    comment: 'Keeps the UI responsive.',
    superseded: false,
    timestamp: '2026-04-09T10:05:00.000Z',
  },
];

class MockEventSource {
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
  }

  addEventListener(name, handler) {
    this.listeners.set(name, handler);
  }

  close() {}
}

const mockStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
const originalLocalStorage = globalThis.localStorage;

beforeEach(() => {
  globalThis.localStorage = mockStorage;
  globalThis.EventSource = MockEventSource;
});

afterEach(async () => {
  const { useDesignStore } = await import(`${ROOT}/src/components/vision/useDesignStore.js`);
  useDesignStore.getState().disconnectSSE();
  useDesignStore.getState().reset();

  if (originalFetch === undefined) {
    delete globalThis.fetch;
  } else {
    globalThis.fetch = originalFetch;
  }

  if (originalEventSource === undefined) {
    delete globalThis.EventSource;
  } else {
    globalThis.EventSource = originalEventSource;
  }

  if (originalLocalStorage === undefined) {
    delete globalThis.localStorage;
  } else {
    globalThis.localStorage = originalLocalStorage;
  }
});

describe('useDesignStore hydrate', () => {
  test('preserves manual draft edits across rehydrate', async () => {
    globalThis.fetch = async () => ({
      json: async () => ({
        session: {
          scope: 'product',
          featureCode: null,
          status: 'active',
          messages,
          decisions,
        },
      }),
    });

    const { useDesignStore } = await import(`${ROOT}/src/components/vision/useDesignStore.js`);

    useDesignStore.setState({
      scope: 'product',
      featureCode: null,
      researchItems: [{ id: 'r1', tool: 'webfetch', input: 'query', summary: 'cached', timestamp: '2026-04-09T10:01:00.000Z' }],
    });
    useDesignStore.getState().updateDraftDoc('# My manual draft');

    await useDesignStore.getState().hydrate('product', null);

    const state = useDesignStore.getState();
    assert.equal(state.draftDoc, '# My manual draft');
    assert.equal(state.docManuallyEdited, true);
    assert.deepEqual(state.researchItems, [{ id: 'r1', tool: 'webfetch', input: 'query', summary: 'cached', timestamp: '2026-04-09T10:01:00.000Z' }]);
    assert.equal(state.messages.length, 1);
    assert.equal(state.decisions.length, 1);
    assert.equal(state.topicOutline.length, 1);
  });
});
