import { describe, expect, it } from 'vitest';
import { nextRevealedCount, tokenize } from './useTypewriter.js';

describe('tokenize', () => {
  it('leerer Text liefert leeres Array', () => {
    expect(tokenize('')).toEqual([]);
  });

  it('splitet in Wörter und erhält Leerzeichen', () => {
    expect(tokenize('hallo welt ')).toEqual(['hallo ', 'welt ']);
  });

  it('erkennt einzelne Wörter', () => {
    expect(tokenize('ein')).toEqual(['ein']);
  });
});

describe('nextRevealedCount', () => {
  it('Append: ein Wort pro Tick bei kleinem Backlog', () => {
    expect(nextRevealedCount('hallo welt', 'hallo', 1)).toBe(2);
  });

  it('Catch-up: holt großen Backlog proportional auf', () => {
    const target = 'a b c d e f g h i j k l m n o p q'; // 17 Tokens
    expect(nextRevealedCount(target, 'a', 1, 8)).toBe(3);
  });

  it('Replace: Hypothese geändert → Reset auf 0', () => {
    expect(nextRevealedCount('ganz neu', 'hallo', 1)).toBe(0);
  });

  it('Cap: nie mehr als tokens.length', () => {
    expect(nextRevealedCount('a b', '', 5)).toBe(2);
  });

  it('leerer Target → 0', () => {
    expect(nextRevealedCount('', 'hallo', 2)).toBe(0);
  });
});
