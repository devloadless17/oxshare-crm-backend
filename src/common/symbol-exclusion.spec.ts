import { describe, expect, it } from 'vitest';
import { folderOf, normaliseMt5Path, symbolExclusion } from './symbol-exclusion';

/**
 * Which symbols a commission type pays nothing on (0198). Every wrong answer
 * here is money: an excluded symbol paid, or an included one skipped.
 */
describe('normaliseMt5Path / folderOf', () => {
  it('reads either separator, drops the ends, and ignores case', () => {
    expect(normaliseMt5Path(' Forex/Majors\\ ')).toBe('forex\\majors');
    expect(normaliseMt5Path('\\Crypto\\\\BTCUSD')).toBe('crypto\\btcusd');
  });

  it('the folder is the path without the symbol at its end', () => {
    expect(folderOf('Forex\\Majors\\EURUSD')).toBe('forex\\majors');
    expect(folderOf('Crypto\\BTCUSD')).toBe('crypto');
    expect(folderOf('EURUSD')).toBe('');
  });
});

describe('symbolExclusion', () => {
  const crypto = { excludedPaths: ['Crypto'], excludedSymbols: [] };

  it('excludes nothing when the type lists nothing — whatever the symbol', () => {
    expect(symbolExclusion({}, 'BTCUSD', null)).toEqual({ excluded: false });
    expect(
      symbolExclusion({ excludedPaths: [], excludedSymbols: [] }, undefined, undefined),
    ).toEqual({ excluded: false });
  });

  it('excludes a symbol inside an excluded folder', () => {
    const result = symbolExclusion(crypto, 'BTCUSD', 'Crypto\\BTCUSD');
    expect(result.excluded).toBe(true);
  });

  it('pays a symbol outside it', () => {
    expect(symbolExclusion(crypto, 'EURUSD', 'Forex\\Majors\\EURUSD')).toEqual({ excluded: false });
  });

  it('a folder covers every depth beneath it', () => {
    const forex = { excludedPaths: ['Forex'] };
    expect(symbolExclusion(forex, 'EURUSD', 'Forex\\Majors\\EURUSD').excluded).toBe(true);
    expect(symbolExclusion(forex, 'USDTRY', 'Forex\\Exotics\\USDTRY').excluded).toBe(true);
  });

  it('a sub-folder rule leaves its siblings paid', () => {
    const exotics = { excludedPaths: ['Forex\\Exotics'] };
    expect(symbolExclusion(exotics, 'USDTRY', 'Forex\\Exotics\\USDTRY').excluded).toBe(true);
    expect(symbolExclusion(exotics, 'EURUSD', 'Forex\\Majors\\EURUSD')).toEqual({
      excluded: false,
    });
  });

  it('matches on whole folder names, never a prefix of one', () => {
    // "Crypto" must not swallow a folder called "CryptoIndices".
    expect(symbolExclusion(crypto, 'CRY10', 'CryptoIndices\\CRY10')).toEqual({ excluded: false });
  });

  it('ignores case and separator style, as MT5 does', () => {
    expect(
      symbolExclusion({ excludedPaths: ['crypto'] }, 'btcusd', 'CRYPTO\\BTCUSD').excluded,
    ).toBe(true);
    expect(
      symbolExclusion({ excludedPaths: ['Forex/Majors/'] }, 'EURUSD', 'Forex\\Majors\\EURUSD')
        .excluded,
    ).toBe(true);
  });

  it('excludes a single symbol by name, needing no folder', () => {
    const btc = { excludedSymbols: ['btcusd'] };
    expect(symbolExclusion(btc, 'BTCUSD', null).excluded).toBe(true);
    expect(symbolExclusion(btc, 'ETHUSD', null)).toEqual({ excluded: false });
  });

  /*
   * The case that must NOT guess: folder rules exist and this symbol's folder
   * is unknown. Paying could pay an excluded folder; skipping could lose money.
   */
  it('reports an unknown folder rather than guessing, when folders are excluded', () => {
    const result = symbolExclusion(crypto, 'NEWCOIN', null);
    expect(result.excluded).toBe('unknown');
  });

  it('a symbol rule still decides when the folder is unknown', () => {
    const rules = { excludedPaths: ['Crypto'], excludedSymbols: ['NEWCOIN'] };
    expect(symbolExclusion(rules, 'NEWCOIN', null).excluded).toBe(true);
  });

  it('only symbol rules → an unknown folder does not matter', () => {
    expect(symbolExclusion({ excludedSymbols: ['BTCUSD'] }, 'NEWCOIN', null)).toEqual({
      excluded: false,
    });
  });

  it('a trade with no symbol is unknown when anything is excluded', () => {
    expect(symbolExclusion(crypto, undefined, undefined).excluded).toBe('unknown');
  });
});
