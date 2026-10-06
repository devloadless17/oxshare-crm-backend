/**
 * Which traded symbols a commission type does NOT pay partners or clients on
 * (0198) — the owner's rule, 6 Oct 2026.
 *
 * A commission type may exclude whole MT5 symbol FOLDERS — the categories the
 * terminal's symbol search shows (Forex, Metals, Crypto, Indices\Cash…) — and
 * single symbols. A trade on an excluded symbol is still stored; it pays no
 * commission and no rebate.
 *
 * Pure: the engine and its tests call it with the deal's symbol and the folder
 * path the CRM's symbol mirror holds for it.
 *
 * ## Matching
 *
 * MT5 paths are backslash-separated and end in the symbol itself
 * (`Forex\Majors\EURUSD`), and MT5 treats them case-insensitively, so both
 * sides are normalised: `/` read as `\`, no trailing separator, lower case.
 * A folder rule excludes every symbol inside it at ANY depth — excluding
 * `Forex` excludes `Forex\Majors\EURUSD` — and a symbol added to that folder
 * later is excluded too, which is the point of choosing a folder.
 */

export interface SymbolExclusionRules {
  /** Folder paths, e.g. `Crypto` or `Forex\Majors`. */
  excludedPaths?: readonly string[] | null;
  /** Symbol names, e.g. `BTCUSD`. */
  excludedSymbols?: readonly string[] | null;
}

export type SymbolExclusion =
  | { excluded: false }
  | { excluded: true; reason: string }
  /**
   * The type excludes folders, and this symbol's folder is not known — the
   * CRM's symbol mirror has not seen it yet. The caller must NOT guess: paying
   * it could pay on a folder the broker excluded, and skipping it could lose
   * money that is owed. The deal waits and is priced once the mirror knows.
   */
  | { excluded: 'unknown'; reason: string };

/** `Forex/Majors\` → `forex\majors`. */
export function normaliseMt5Path(value: string): string {
  return value
    .trim()
    .replace(/\//g, '\\')
    .replace(/\\{2,}/g, '\\')
    .replace(/^\\+|\\+$/g, '')
    .toLowerCase();
}

/** The folder a symbol's full path sits in: `Forex\Majors\EURUSD` → `forex\majors`. */
export function folderOf(symbolPath: string): string {
  const parts = normaliseMt5Path(symbolPath).split('\\');
  return parts.slice(0, -1).join('\\');
}

/** True when `folder` is `rule` or anywhere beneath it. */
function within(folder: string, rule: string): boolean {
  return folder === rule || folder.startsWith(`${rule}\\`);
}

export function symbolExclusion(
  rules: SymbolExclusionRules,
  symbol: string | null | undefined,
  symbolPath: string | null | undefined,
): SymbolExclusion {
  const paths = (rules.excludedPaths ?? []).map(normaliseMt5Path).filter(Boolean);
  const symbols = (rules.excludedSymbols ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (paths.length === 0 && symbols.length === 0) return { excluded: false };

  const name = symbol?.trim() ?? '';
  if (!name) {
    return {
      excluded: 'unknown',
      reason: 'the trade carries no symbol, and this commission type excludes some symbols',
    };
  }

  if (symbols.includes(name.toLowerCase())) {
    return { excluded: true, reason: `${name} is excluded from commission on this type` };
  }

  if (paths.length === 0) return { excluded: false };

  if (!symbolPath) {
    return {
      excluded: 'unknown',
      reason:
        `the folder ${name} sits in is not known yet — the CRM's MT5 symbol list has not seen ` +
        'it. It is priced once the next symbol sync (Settings → Scheduled jobs, with the MT5 ' +
        'groups) records it',
    };
  }

  const folder = folderOf(symbolPath);
  const rule = paths.find((p) => within(folder, p) || normaliseMt5Path(symbolPath) === p);
  return rule
    ? { excluded: true, reason: `${name} is in the excluded folder ${rule}` }
    : { excluded: false };
}
