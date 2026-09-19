import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sum } from './sum.mjs';
test('sum handles positive integers', () => assert.equal(sum(2, 3), 5));
test('sum handles negative integers', () => assert.equal(sum(-2, -3), -5));
