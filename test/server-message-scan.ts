import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

/**
 * Finds every English sentence the server can send a client in an error.
 *
 * Read by `server-messages-coverage.spec.ts`, which asserts each one has an
 * Arabic entry in `common/i18n/server-messages.ar.ts`. A parse, not a regex:
 * messages are written as plain strings, template literals, `'a' + 'b'`
 * concatenations and `cond ? 'x' : 'y'` choices, and a regex reads the first
 * of those and silently misses the rest.
 *
 * What counts as a message:
 *  - the first argument of `new X(…)` where X is a `DomainError` subclass or a
 *    Nest `…Exception` (the only two kinds `AllExceptionsFilter` relays) — or
 *    the `message` / `fields` of the object such an exception is given;
 *  - the `fields` map of the three field-carrying domain errors;
 *  - a default `message` parameter or a literal `super('…')` in such a class;
 *  - a `message:` inside a decorator (`@Matches(re, { message })`) and what a
 *    custom validator's `defaultMessage()` returns.
 *
 * A template literal becomes a PATTERN: each `${…}` is `{1}`, `{2}`… in order of
 * appearance — exactly how the catalogue writes it. An interpolation that is a
 * choice between literals (`minute${n === 1 ? '' : 's'}`) is expanded into one
 * message per branch rather than captured, so each reads as a whole sentence.
 */

export interface ScannedMessage {
  /** The catalogue key: the English, with `{n}` for each interpolation. */
  key: string;
  pattern: boolean;
  file: string;
  line: number;
}

export interface UnresolvedMessage {
  file: string;
  line: number;
  /** The source text of the argument that is not a literal. */
  expression: string;
}

const HOLE = Symbol('hole');
type Part = string | typeof HOLE;
type Alternatives = Part[][];

const MAX_ALTERNATIVES = 32;

/** Field-carrying errors whose SECOND argument is a field → sentence map. */
const FIELD_ERRORS = new Set([
  'FieldValidationError',
  'ProfileLockedError',
  'EmailAlreadyRegisteredError',
]);

function walkFiles(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walkFiles(path, out);
    else if (name.endsWith('.ts') && !name.endsWith('.spec.ts') && !name.endsWith('.d.ts')) {
      out.push(path);
    }
  }
}

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true);
}

function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isNonNullExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

function concat(left: Alternatives, right: Alternatives): Alternatives {
  const out: Alternatives = [];
  for (const l of left) for (const r of right) out.push([...l, ...r]);
  return out.slice(0, MAX_ALTERNATIVES);
}

/**
 * The literal alternatives an expression can produce, or null when it is not
 * text we can read. `consts` resolves a bare identifier naming a module-level
 * `const X = '…'` in the same file — the shape a sentence thrown from several
 * places takes.
 */
function alternatives(
  input: ts.Expression,
  consts: ReadonlyMap<string, ts.Expression> = new Map(),
  depth = 0,
): Alternatives | null {
  const expr = unwrap(input);
  const recur = (e: ts.Expression): Alternatives | null => alternatives(e, consts, depth + 1);
  if (depth > 8) return null;
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return [[expr.text]];
  if (ts.isIdentifier(expr)) {
    const init = consts.get(expr.text);
    return init ? recur(init) : null;
  }
  if (ts.isTemplateExpression(expr)) {
    let acc: Alternatives = [[expr.head.text]];
    for (const span of expr.templateSpans) {
      acc = concat(acc, recur(span.expression) ?? [[HOLE]]);
      acc = concat(acc, [[span.literal.text]]);
    }
    return acc;
  }
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = recur(expr.left);
    const right = recur(expr.right);
    if (!left && !right) return null;
    return concat(left ?? [[HOLE]], right ?? [[HOLE]]);
  }
  if (ts.isConditionalExpression(expr)) {
    const a = recur(expr.whenTrue);
    const b = recur(expr.whenFalse);
    if (!a && !b) return null;
    return [...(a ?? [[HOLE]]), ...(b ?? [[HOLE]])].slice(0, MAX_ALTERNATIVES);
  }
  return null;
}

function toKey(parts: Part[]): { key: string; pattern: boolean } {
  let key = '';
  let n = 0;
  for (const part of parts) key += part === HOLE ? `{${++n}}` : part;
  return { key, pattern: n > 0 };
}

/** Has words of its own — `${reason}` alone is somebody else's message passed through. */
function hasText(key: string): boolean {
  return /[A-Za-z]{2,}/.test(key.replace(/\{\d+\}/g, ''));
}

function classHeritage(files: string[]): Map<string, string> {
  const bases = new Map<string, string>();
  for (const file of files) {
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) && node.name) {
        const ext = node.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword);
        const base = ext?.types[0]?.expression;
        if (base && ts.isIdentifier(base)) bases.set(node.name.text, base.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(parse(file));
  }
  return bases;
}

/**
 * Whether `AllExceptionsFilter` relays this class's message to the caller: a
 * `DomainError` subclass, or an HTTP exception (Nest's, the throttler's). A
 * class of ours that extends a plain `Error` is answered with the generic 500
 * sentence, so its message never reaches anybody.
 */
function makeSurfacing(bases: Map<string, string>): (name: string) => boolean {
  return (name) => {
    let current: string | undefined = name;
    for (let depth = 0; current && depth < 10; depth++) {
      if (current === 'DomainError' || current === 'HttpException') return true;
      const base = bases.get(current);
      if (base === undefined) return current.endsWith('Exception');
      current = base;
    }
    return false;
  };
}

/**
 * Every `const name = …` in the file, at any depth — a sentence is often
 * assembled from a local (`const after = code ? … : …`). A name declared twice
 * is ambiguous and resolves to nothing.
 */
function constsOf(source: ts.SourceFile): Map<string, ts.Expression> {
  const consts = new Map<string, ts.Expression>();
  const seen = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclarationList(node) && node.flags & ts.NodeFlags.Const) {
      for (const decl of node.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        if (seen.has(decl.name.text)) consts.delete(decl.name.text);
        else consts.set(decl.name.text, decl.initializer);
        seen.add(decl.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return consts;
}

/** A string literal, a template, or a `+` concatenation with text in it. */
function isStringy(node: ts.Node): boolean {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return true;
  if (ts.isTemplateExpression(node)) return true;
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
    (isStringy(node.left) || isStringy(node.right))
  );
}

const COMPARISONS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.InKeyword,
]);

/** Text that never reaches a client: a log line, an alert, SQL, a key, an import. */
function isQuiet(node: ts.Node): boolean {
  const parent = node.parent;
  if (
    ts.isImportDeclaration(parent) ||
    ts.isExportDeclaration(parent) ||
    ts.isExternalModuleReference(parent) ||
    ts.isLiteralTypeNode(parent) ||
    ts.isTaggedTemplateExpression(parent) ||
    ts.isElementAccessExpression(parent) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isBinaryExpression(parent) && COMPARISONS.has(parent.operatorToken.kind))
  ) {
    return true;
  }
  for (let p: ts.Node | undefined = parent; p && !ts.isSourceFile(p); p = p.parent) {
    if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
      const callee = p.expression.getText();
      return /(^|\.)(log|debug|info|warn|error|verbose|raiseAlert|flag|logEvent)$|logger|console/i.test(
        callee,
      );
    }
    if (ts.isFunctionLike(p) || ts.isClassLike(p)) return false;
  }
  return false;
}

/** Two words or more ending as a sentence ends — not a label, a key or a URL. */
function isSentence(key: string): boolean {
  const words = key.replace(/\{\d+\}/g, 'X').trim();
  return hasText(key) && /^[A-Z{]/.test(words) && /\s/.test(words) && /[.!?)]$/.test(words);
}

/**
 * Files that BUILD client sentences for a thrower elsewhere — every sentence in
 * them is a message (see the sentence branch of the visitor).
 */
export const SENTENCE_FILES: readonly string[] = [
  'src/common/currency-limits.ts',
  'src/common/filters/all-exceptions.filter.ts',
  'src/common/payments/method-eligibility.ts',
  'src/common/payments/proof-fields.ts',
  'src/common/profile/client-profile.ts',
  'src/common/security/lockout-message.ts',
  'src/common/uploads/active-content.ts',
  'src/common/uploads/stored-files.service.ts',
  'src/modules/compliance/kyc-answers.ts',
  'src/modules/compliance/kyc-profile.ts',
  'src/modules/compliance/kyc.service.ts',
  'src/modules/compliance/upload-size.filter.ts',
  'src/modules/compliance/uploads.controller.ts',
  'src/modules/ib/ib-applications.service.ts',
  'src/modules/identity/auth.service.ts',
  'src/modules/payments/providers/rival/wish-phone.ts',
  'src/modules/payments/providers/threepay/threepay-address.ts',
];

export function scanServerMessages(
  root: string,
  dirs: readonly string[],
  sentenceFiles: readonly string[] = SENTENCE_FILES,
): { messages: ScannedMessage[]; unresolved: UnresolvedMessage[] } {
  const all: string[] = [];
  walkFiles(join(root, 'src'), all);
  const surfacing = makeSurfacing(classHeritage(all));

  const scanned: string[] = [];
  for (const dir of dirs) walkFiles(join(root, dir), scanned);

  const messages: ScannedMessage[] = [];
  const unresolved: UnresolvedMessage[] = [];

  for (const path of scanned) {
    const source = parse(path);
    const file = relative(root, path).replace(/\\/g, '/');
    const consts = constsOf(source);
    const sentences = sentenceFiles.includes(file);
    const lineOf = (node: ts.Node): number =>
      source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

    const take = (expr: ts.Expression, strict: boolean): void => {
      const inner = unwrap(expr);
      // `message: ['…']` — a Nest exception body may carry the validator's list shape.
      if (ts.isArrayLiteralExpression(inner)) {
        for (const element of inner.elements) take(element, strict);
        return;
      }
      const alts = alternatives(expr, consts);
      const usable = alts?.map(toKey).filter((k) => hasText(k.key)) ?? [];
      if (usable.length === 0) {
        if (strict) unresolved.push({ file, line: lineOf(expr), expression: expr.getText(source) });
        return;
      }
      for (const k of usable) messages.push({ ...k, file, line: lineOf(expr) });
    };

    const takeFields = (expr: ts.Expression): void => {
      const obj = unwrap(expr);
      if (!ts.isObjectLiteralExpression(obj)) {
        unresolved.push({ file, line: lineOf(expr), expression: expr.getText(source) });
        return;
      }
      for (const prop of obj.properties) {
        if (ts.isPropertyAssignment(prop)) take(prop.initializer, true);
        else unresolved.push({ file, line: lineOf(prop), expression: prop.getText(source) });
      }
    };

    const takeObject = (obj: ts.ObjectLiteralExpression, strict: boolean): void => {
      for (const prop of obj.properties) {
        if (!ts.isPropertyAssignment(prop) || !prop.name || !ts.isIdentifier(prop.name)) continue;
        if (prop.name.text === 'message') take(prop.initializer, strict);
        if (prop.name.text === 'fields') takeFields(prop.initializer);
      }
    };

    const visit = (node: ts.Node, inDecorator: boolean): void => {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
        const name = node.expression.text;
        const args = node.arguments ?? [];
        if (surfacing(name) && args.length > 0) {
          const first = unwrap(args[0]);
          if (ts.isObjectLiteralExpression(first)) takeObject(first, true);
          else take(args[0], true);
          if (FIELD_ERRORS.has(name) && args[1]) takeFields(args[1]);
        }
      }

      // A surfacing class's own sentence: `constructor(message = '…')`, `super('…')`.
      if (ts.isClassDeclaration(node) && node.name && surfacing(node.name.text)) {
        for (const member of node.members) {
          if (!ts.isConstructorDeclaration(member)) continue;
          for (const param of member.parameters) {
            if (param.initializer) take(param.initializer, false);
          }
          const visitSuper = (n: ts.Node): void => {
            if (
              ts.isCallExpression(n) &&
              n.expression.kind === ts.SyntaxKind.SuperKeyword &&
              n.arguments[0]
            ) {
              take(n.arguments[0], false);
            }
            ts.forEachChild(n, visitSuper);
          };
          if (member.body) visitSuper(member.body);
        }
      }

      // `@Matches(re, { message: '…' })` and custom validators' options.
      if (inDecorator && ts.isObjectLiteralExpression(node)) takeObject(node, false);
      if (
        ts.isMethodDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'defaultMessage' &&
        node.body
      ) {
        const visitReturn = (n: ts.Node): void => {
          if (ts.isReturnStatement(n) && n.expression) take(n.expression, true);
          if (!ts.isFunctionLike(n) || n === node) ts.forEachChild(n, visitReturn);
        };
        visitReturn(node.body);
      }
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'registerDecorator'
      ) {
        ts.forEachChild(node, (n) => visit(n, true));
        return;
      }

      /*
       * A HELPER's sentences: a file that builds client sentences and hands
       * them to a thrower elsewhere (`phoneProblem`, `tronAddressIssue`) has no
       * `new XError` to find. In those files every literal that reads as a
       * sentence is a message — except what goes to a log or an alert.
       */
      if (sentences && !inDecorator && isStringy(node) && !isQuiet(node)) {
        const alts = alternatives(node as ts.Expression, consts);
        for (const k of alts?.map(toKey) ?? []) {
          if (isSentence(k.key)) messages.push({ ...k, file, line: lineOf(node) });
        }
        return;
      }

      ts.forEachChild(node, (n) => visit(n, inDecorator || ts.isDecorator(node)));
    };
    visit(source, false);
  }

  return { messages, unresolved };
}
