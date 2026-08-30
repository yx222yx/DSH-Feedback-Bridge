import assert from 'node:assert/strict';
import { test } from 'node:test';
import { informationNeedsFor, TYPE_INFORMATION_NEEDS } from '../lib/type-needs.js';

test('every feedback type has a defined, non-empty information-need roster', () => {
  for (const type of ['plugin-request', 'harness-feature', 'harness-defect', 'custom']) {
    const needs = TYPE_INFORMATION_NEEDS[type];
    assert.ok(Array.isArray(needs) && needs.length > 0, type);
    assert.equal(informationNeedsFor(type), needs);
  }
});

test('a defect report requests reproduction steps, environment, and version information', () => {
  const needs = informationNeedsFor('harness-defect');
  assert.ok(needs.includes('reproduction'));
  assert.ok(needs.includes('environment'));
  assert.ok(needs.includes('version'));
});

test('a plugin request requests the unmet job, workaround, and intended audience', () => {
  const needs = informationNeedsFor('plugin-request');
  assert.ok(needs.includes('scenario'));
  assert.ok(needs.includes('workaround'));
  assert.ok(needs.includes('audience'));
});

test('a harness feature suggestion requests the scenario, gap, desired outcome, and environment', () => {
  const needs = informationNeedsFor('harness-feature');
  assert.ok(needs.includes('scenario'));
  assert.ok(needs.includes('gap'));
  assert.ok(needs.includes('desired'));
  assert.ok(needs.includes('environment'));
});

test('custom feedback requests the generic editable fields', () => {
  const needs = informationNeedsFor('custom');
  assert.ok(needs.includes('title'));
  assert.ok(needs.includes('scenario'));
  assert.ok(needs.includes('desired'));
  assert.ok(needs.includes('context'));
});
