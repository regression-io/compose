import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assembleTimeline } from '../src/components/vision/timelineAssembler.js';

describe('assembleTimeline', () => {
  const baseSessions = [
    {
      id: 'session-1',
      startedAt: '2026-03-27T10:00:00.000Z',
      endedAt: '2026-03-27T10:30:00.000Z',
      toolCount: 42,
      featureCode: 'FEAT-1',
      phaseAtBind: 'explore_design',
      phaseAtEnd: 'blueprint',
      errors: [
        { type: 'lint', severity: 'warning', message: 'Unused variable', timestamp: '2026-03-27T10:15:00.000Z', tool: 'Bash' },
      ],
    },
    {
      id: 'session-2',
      startedAt: '2026-03-27T11:00:00.000Z',
      endedAt: '2026-03-27T11:45:00.000Z',
      toolCount: 87,
      featureCode: 'FEAT-1',
      phaseAtBind: 'blueprint',
      phaseAtEnd: 'execute',
      errors: [],
    },
  ];

  const baseGates = [
    {
      id: 'gate-1',
      itemId: 'item-1',
      createdAt: '2026-03-27T10:25:00.000Z',
      resolvedAt: '2026-03-27T10:28:00.000Z',
      outcome: 'approve',
      comment: 'Looks good',
      fromPhase: 'explore_design',
      toPhase: 'blueprint',
    },
    {
      id: 'gate-2',
      itemId: 'item-1',
      createdAt: '2026-03-27T11:40:00.000Z',
      resolvedAt: null,
      outcome: null,
      fromPhase: 'blueprint',
      toPhase: 'plan',
    },
  ];

  it('returns events sorted by timestamp ascending', () => {
    const events = assembleTimeline(baseSessions, baseGates, { id: 'item-1' });
    for (let i = 1; i < events.length; i++) {
      assert.ok(events[i].timestamp >= events[i - 1].timestamp,
        `Event ${i} (${events[i].timestamp}) should be >= event ${i-1} (${events[i-1].timestamp})`);
    }
  });

  it('generates session start and end events', () => {
    const events = assembleTimeline(baseSessions, [], { id: 'item-1' });
    const sessionEvents = events.filter(e => e.category === 'session');
    // 2 sessions × 2 (start + end) = 4
    assert.equal(sessionEvents.length, 4);
    assert.ok(sessionEvents.some(e => e.title.includes('started')));
    assert.ok(sessionEvents.some(e => e.title.includes('ended')));
  });

  it('generates error events from session errors', () => {
    const events = assembleTimeline(baseSessions, [], { id: 'item-1' });
    const errorEvents = events.filter(e => e.category === 'error');
    assert.equal(errorEvents.length, 1);
    assert.equal(errorEvents[0].severity, 'warning');
    assert.ok(errorEvents[0].title.includes('Unused variable'));
  });

  it('generates gate events', () => {
    const events = assembleTimeline([], baseGates, { id: 'item-1' });
    const gateEvents = events.filter(e => e.category === 'gate');
    // gate-1: created + resolved = 2, gate-2: created only = 1 → 3
    assert.equal(gateEvents.length, 3);
    assert.ok(gateEvents.some(e => e.severity === 'success' && e.title.includes('approved')));
  });

  it('generates phase events from session phase transitions', () => {
    const events = assembleTimeline(baseSessions, [], { id: 'item-1' });
    const phaseEvents = events.filter(e => e.category === 'phase');
    // session-1: phaseAtBind !== phaseAtEnd → 1 transition
    // session-2: phaseAtBind !== phaseAtEnd → 1 transition
    assert.ok(phaseEvents.length >= 2);
    assert.ok(phaseEvents.some(e => e.title.includes('explore_design') && e.title.includes('blueprint')));
  });

  it('each event has required fields', () => {
    const events = assembleTimeline(baseSessions, baseGates, { id: 'item-1' });
    for (const event of events) {
      assert.ok(event.id, 'event should have id');
      assert.ok(event.timestamp, 'event should have timestamp');
      assert.ok(['phase', 'gate', 'session', 'iteration', 'error'].includes(event.category),
        `event category "${event.category}" should be valid`);
      assert.ok(event.title, 'event should have title');
      assert.ok(['info', 'success', 'warning', 'error'].includes(event.severity),
        `event severity "${event.severity}" should be valid`);
    }
  });

  it('filters gates by itemId', () => {
    const otherGates = [{ ...baseGates[0], id: 'gate-other', itemId: 'item-999' }];
    const events = assembleTimeline([], [...baseGates, ...otherGates], { id: 'item-1' });
    const gateEvents = events.filter(e => e.category === 'gate');
    assert.ok(gateEvents.every(e => !e.id.includes('gate-other')));
  });

  it('handles empty inputs', () => {
    const events = assembleTimeline([], [], { id: 'item-1' });
    assert.deepEqual(events, []);
  });

  it('handles null/undefined gracefully', () => {
    const events = assembleTimeline(null, null, null);
    assert.deepEqual(events, []);
  });

  it('normalizes long-form gate outcomes (approved/revised/killed)', () => {
    const gates = [
      { id: 'g1', itemId: 'item-1', createdAt: '2026-03-27T10:00:00Z', resolvedAt: '2026-03-27T10:05:00Z', outcome: 'approved', comment: null },
      { id: 'g2', itemId: 'item-1', createdAt: '2026-03-27T11:00:00Z', resolvedAt: '2026-03-27T11:05:00Z', outcome: 'revised', comment: null },
      { id: 'g3', itemId: 'item-1', createdAt: '2026-03-27T12:00:00Z', resolvedAt: '2026-03-27T12:05:00Z', outcome: 'killed', comment: null },
    ];
    const events = assembleTimeline([], gates, { id: 'item-1' });
    const resolved = events.filter(e => e.id.startsWith('gate-resolved'));
    assert.equal(resolved.length, 3);
    assert.ok(resolved[0].title.includes('approved'));
    assert.equal(resolved[0].severity, 'success');
    assert.ok(resolved[1].title.includes('revised'));
    assert.equal(resolved[1].severity, 'warning');
    assert.ok(resolved[2].title.includes('killed'));
    assert.equal(resolved[2].severity, 'error');
  });

  it('deduplicates by id', () => {
    const events = assembleTimeline(baseSessions, baseGates, { id: 'item-1' });
    const ids = events.map(e => e.id);
    assert.equal(ids.length, new Set(ids).size, 'All event IDs should be unique');
  });
});
