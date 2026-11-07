/**
 * The risk-rule language (ADR 0022 D1): Radar's shape, parsed into an AST and
 * compiled into a tree of closures over a fact record.
 *
 * ```
 * predicate  := or
 * or         := and ( "or" and )*
 * and        := not ( "and" not )*
 * not        := "not" not | primary
 * primary    := "(" predicate ")" | "is_missing" "(" fact ")" | comparison
 * comparison := fact op literal
 *             | fact [ "not" ] "in" "(" literal ( "," literal )* ")"
 *             | fact [ "not" ] "like" string
 * fact       := ":" name ":"
 * op         := "=" | "!=" | "<" | "<=" | ">" | ">="
 * literal    := string | integer
 * ```
 *
 * Nothing here is ever executed as code: there is no `eval`, no `new
 * Function`, no regular expression built from the merchant's text, and no SQL.
 * Every name is checked against the closed fact registry (`RADAR_FACTS`), every
 * literal against its fact's type, and the size of a rule is bounded
 * (`RADAR_LIMITS`). An error names the 0-based position it is about.
 *
 * Evaluation is three-valued (Kleene): a comparison with an unknown fact is
 * UNKNOWN (`null`), `not UNKNOWN` is UNKNOWN, `false and UNKNOWN` is false and
 * `true or UNKNOWN` is true. A rule matches only when its predicate is TRUE,
 * so an absent fact never makes a rule match in either polarity.
 */
import {
  RADAR_FACTS,
  RADAR_LIMITS,
  type RadarFact,
  type RadarFactType,
} from '@peable.to/shared-types';

/** A predicate the merchant must fix, and where. */
export class RadarRuleError extends Error {
  constructor(
    readonly reason: string,
    readonly position: number,
  ) {
    super(`${reason} (at position ${String(position)})`);
    this.name = 'RadarRuleError';
  }
}

/** What a fact holds when judged: an integer, a string, or unknown. */
export type FactValue = bigint | string | null;
export type FactValues = Readonly<Partial<Record<RadarFact, FactValue>>>;

/** Kleene's three values. */
type Truth = boolean | null;

type Literal =
  | { readonly kind: 'integer'; readonly value: bigint; readonly position: number }
  | {
      readonly kind: 'string';
      /** Lowercased: strings compare case-insensitively. */
      readonly value: string;
      /** As written: a customer id compares exactly. */
      readonly raw: string;
      readonly position: number;
    };

/** One step of a `like` pattern: `%`, `_`, or a character (an escaped `\%` / `\_` is a character). */
type LikeStep =
  | { readonly kind: 'any' }
  | { readonly kind: 'one' }
  | { readonly kind: 'char'; readonly ch: string };

type Operator = '=' | '!=' | '<' | '<=' | '>' | '>=';

type Node =
  | { readonly kind: 'and' | 'or'; readonly left: Node; readonly right: Node }
  | { readonly kind: 'not'; readonly operand: Node }
  | {
      readonly kind: 'compare';
      readonly fact: RadarFact;
      readonly op: Operator;
      readonly value: Literal;
    }
  | {
      readonly kind: 'in';
      readonly fact: RadarFact;
      readonly negated: boolean;
      readonly values: readonly Literal[];
    }
  | {
      readonly kind: 'like';
      readonly fact: RadarFact;
      readonly negated: boolean;
      readonly pattern: readonly LikeStep[];
    }
  | { readonly kind: 'missing'; readonly fact: RadarFact };

type Token =
  | { readonly kind: 'fact'; readonly name: string; readonly position: number }
  | {
      readonly kind: 'string';
      readonly value: string;
      /** Which characters were written escaped (`\x`): a `like` reads `\%` and `\_` literally. */
      readonly escaped: readonly boolean[];
      readonly position: number;
    }
  | { readonly kind: 'integer'; readonly value: string; readonly position: number }
  | { readonly kind: 'op'; readonly value: Operator; readonly position: number }
  | { readonly kind: '(' | ')' | ','; readonly position: number }
  | { readonly kind: 'word'; readonly value: string; readonly position: number }
  | { readonly kind: 'end'; readonly position: number };

const WORDS = new Set(['and', 'or', 'not', 'in', 'like', 'is_missing']);
const FACT_NAME = /^[a-z_][a-z0-9_]*$/;

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i] ?? '';
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    const start = i;
    if (ch === '(' || ch === ')' || ch === ',') {
      tokens.push({ kind: ch, position: start });
      i += 1;
      continue;
    }
    if (ch === ':') {
      const end = text.indexOf(':', i + 1);
      if (end === -1) throw new RadarRuleError('a fact is written :name:', start);
      const name = text.slice(i + 1, end);
      if (!FACT_NAME.test(name)) throw new RadarRuleError(`'${name}' is not a fact name`, start);
      tokens.push({ kind: 'fact', name, position: start });
      i = end + 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let value = '';
      const escaped: boolean[] = [];
      i += 1;
      for (;;) {
        if (i >= text.length) throw new RadarRuleError('unterminated string', start);
        const c = text[i] ?? '';
        if (c === '\\') {
          if (i + 1 >= text.length) throw new RadarRuleError('unterminated string', start);
          value += text[i + 1] ?? '';
          escaped.push(true);
          i += 2;
          continue;
        }
        if (c === ch) {
          i += 1;
          break;
        }
        value += c;
        escaped.push(false);
        i += 1;
      }
      if (value.length > RADAR_LIMITS.stringMax) {
        throw new RadarRuleError(
          `a string is at most ${String(RADAR_LIMITS.stringMax)} characters`,
          start,
        );
      }
      tokens.push({ kind: 'string', value, escaped, position: start });
      continue;
    }
    if (/[0-9]/.test(ch)) {
      while (i < text.length && /[0-9]/.test(text[i] ?? '')) i += 1;
      const digits = text.slice(start, i);
      if (digits.length > RADAR_LIMITS.integerDigitsMax) {
        throw new RadarRuleError(
          `an integer is at most ${String(RADAR_LIMITS.integerDigitsMax)} digits`,
          start,
        );
      }
      if (i < text.length && /[A-Za-z_.]/.test(text[i] ?? '')) {
        throw new RadarRuleError('integers only, in base units: no decimals or suffixes', i);
      }
      tokens.push({ kind: 'integer', value: digits, position: start });
      continue;
    }
    const two = text.slice(i, i + 2);
    if (two === '!=' || two === '<=' || two === '>=') {
      tokens.push({ kind: 'op', value: two, position: start });
      i += 2;
      continue;
    }
    if (ch === '=' || ch === '<' || ch === '>') {
      tokens.push({ kind: 'op', value: ch, position: start });
      i += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      while (i < text.length && /[A-Za-z0-9_]/.test(text[i] ?? '')) i += 1;
      const word = text.slice(start, i).toLowerCase();
      if (!WORDS.has(word)) {
        throw new RadarRuleError(
          `unexpected '${text.slice(start, i)}': strings are quoted and facts are :name:`,
          start,
        );
      }
      tokens.push({ kind: 'word', value: word, position: start });
      continue;
    }
    throw new RadarRuleError(`unexpected '${ch}'`, start);
  }
  tokens.push({ kind: 'end', position: text.length });
  return tokens;
}

class Parser {
  private index = 0;
  private comparisons = 0;
  readonly facts = new Set<RadarFact>();

  constructor(private readonly tokens: readonly Token[]) {}

  private peek(): Token {
    return this.tokens[this.index] ?? { kind: 'end', position: 0 };
  }

  private next(): Token {
    const token = this.peek();
    this.index += 1;
    return token;
  }

  private isWord(word: string): boolean {
    const token = this.peek();
    return token.kind === 'word' && token.value === word;
  }

  private expect(kind: '(' | ')', what: string): void {
    const token = this.next();
    if (token.kind !== kind) throw new RadarRuleError(`expected ${what}`, token.position);
  }

  parse(): Node {
    const node = this.or(0);
    const rest = this.peek();
    if (rest.kind !== 'end') {
      throw new RadarRuleError('expected "and", "or" or the end of the rule', rest.position);
    }
    return node;
  }

  private enter(depth: number, position: number): number {
    if (depth >= RADAR_LIMITS.depthMax) {
      throw new RadarRuleError(
        `a rule nests at most ${String(RADAR_LIMITS.depthMax)} levels`,
        position,
      );
    }
    return depth + 1;
  }

  private or(depth: number): Node {
    let left = this.and(depth);
    while (this.isWord('or')) {
      this.next();
      left = { kind: 'or', left, right: this.and(depth) };
    }
    return left;
  }

  private and(depth: number): Node {
    let left = this.not(depth);
    while (this.isWord('and')) {
      this.next();
      left = { kind: 'and', left, right: this.not(depth) };
    }
    return left;
  }

  private not(depth: number): Node {
    if (this.isWord('not')) {
      const token = this.next();
      return { kind: 'not', operand: this.not(this.enter(depth, token.position)) };
    }
    return this.primary(depth);
  }

  private primary(depth: number): Node {
    const token = this.peek();
    if (token.kind === '(') {
      this.next();
      const inner = this.or(this.enter(depth, token.position));
      this.expect(')', '")"');
      return inner;
    }
    if (token.kind === 'word' && token.value === 'is_missing') {
      this.next();
      this.expect('(', '"(" after is_missing');
      const fact = this.fact();
      this.expect(')', '")"');
      this.count(token.position);
      return { kind: 'missing', fact: fact.name };
    }
    return this.comparison();
  }

  private count(position: number): void {
    this.comparisons += 1;
    if (this.comparisons > RADAR_LIMITS.comparisonsMax) {
      throw new RadarRuleError(
        `a rule has at most ${String(RADAR_LIMITS.comparisonsMax)} conditions`,
        position,
      );
    }
  }

  private fact(): { name: RadarFact; type: RadarFactType; position: number } {
    const token = this.next();
    if (token.kind !== 'fact') {
      throw new RadarRuleError('expected a fact, written :name:', token.position);
    }
    if (!Object.hasOwn(RADAR_FACTS, token.name)) {
      throw new RadarRuleError(`unknown fact :${token.name}:`, token.position);
    }
    const name = token.name as RadarFact;
    this.facts.add(name);
    return { name, type: RADAR_FACTS[name].type, position: token.position };
  }

  private literal(type: RadarFactType, factName: string): Literal {
    const token = this.next();
    if (token.kind === 'integer') {
      if (type !== 'integer') {
        throw new RadarRuleError(
          `:${factName}: is a string; compare it with a quoted string`,
          token.position,
        );
      }
      return { kind: 'integer', value: BigInt(token.value), position: token.position };
    }
    if (token.kind === 'string') {
      if (type !== 'string') {
        throw new RadarRuleError(
          `:${factName}: is an integer; compare it with an integer`,
          token.position,
        );
      }
      return {
        kind: 'string',
        value: token.value.toLowerCase(),
        raw: token.value,
        position: token.position,
      };
    }
    throw new RadarRuleError('expected a value', token.position);
  }

  private comparison(): Node {
    const fact = this.fact();
    this.count(fact.position);
    let negated = false;
    if (this.isWord('not')) {
      this.next();
      negated = true;
      if (!this.isWord('in') && !this.isWord('like')) {
        throw new RadarRuleError('expected "in" or "like" after "not"', this.peek().position);
      }
    }
    if (this.isWord('in')) {
      this.next();
      this.expect('(', '"(" after in');
      const values: Literal[] = [this.literal(fact.type, fact.name)];
      while (this.peek().kind === ',') {
        const comma = this.next();
        if (values.length >= RADAR_LIMITS.listValuesMax) {
          throw new RadarRuleError(
            `a list holds at most ${String(RADAR_LIMITS.listValuesMax)} values`,
            comma.position,
          );
        }
        values.push(this.literal(fact.type, fact.name));
      }
      this.expect(')', '")" or ","');
      return { kind: 'in', fact: fact.name, negated, values };
    }
    if (this.isWord('like')) {
      const like = this.next();
      if (fact.type !== 'string') {
        throw new RadarRuleError(`:${fact.name}: is not a string; like needs one`, like.position);
      }
      const token = this.next();
      if (token.kind !== 'string') {
        throw new RadarRuleError('like takes a quoted pattern', token.position);
      }
      const pattern: LikeStep[] = [...token.value.toLowerCase()].map((ch, index) => {
        if (token.escaped[index] === true) return { kind: 'char', ch };
        if (ch === '%') return { kind: 'any' };
        if (ch === '_') return { kind: 'one' };
        return { kind: 'char', ch };
      });
      return { kind: 'like', fact: fact.name, negated, pattern };
    }
    const op = this.next();
    if (op.kind !== 'op') {
      throw new RadarRuleError('expected =, !=, <, <=, >, >=, in or like', op.position);
    }
    if (fact.type === 'string' && op.value !== '=' && op.value !== '!=') {
      throw new RadarRuleError(`:${fact.name}: is a string; compare it with = or !=`, op.position);
    }
    return {
      kind: 'compare',
      fact: fact.name,
      op: op.value,
      value: this.literal(fact.type, fact.name),
    };
  }
}

/**
 * `like`: `%` is any run of characters, `_` exactly one, `\%` and `\_` the
 * characters themselves, everything else itself. A dynamic-programming match
 * over the two strings — linear memory, no backtracking, no regular expression.
 */
function likeMatch(value: string, pattern: readonly LikeStep[]): boolean {
  let row = new Array<boolean>(value.length + 1).fill(false);
  row[0] = true;
  for (const p of pattern) {
    const next = new Array<boolean>(value.length + 1).fill(false);
    if (p.kind === 'any') {
      let any = false;
      for (let j = 0; j <= value.length; j += 1) {
        any = any || (row[j] ?? false);
        next[j] = any;
      }
    } else {
      for (let j = 1; j <= value.length; j += 1) {
        next[j] = (row[j - 1] ?? false) && (p.kind === 'one' || value[j - 1] === p.ch);
      }
    }
    row = next;
  }
  return row[value.length] ?? false;
}

/** Ids are compared exactly; every other string case-insensitively. */
const CASE_SENSITIVE: ReadonlySet<RadarFact> = new Set<RadarFact>(['customer']);

function equalValue(fact: FactValue, literal: Literal, name: RadarFact): boolean {
  if (literal.kind === 'integer') return typeof fact === 'bigint' && fact === literal.value;
  if (typeof fact !== 'string') return false;
  return CASE_SENSITIVE.has(name) ? fact === literal.raw : fact.toLowerCase() === literal.value;
}

/** What a judgment knows: the values, and the facts that cannot be known in this phase. */
interface Context {
  readonly facts: FactValues;
  /** Not knowable here: comparisons AND `is_missing` are UNKNOWN for these. */
  readonly unknowable: ReadonlySet<RadarFact>;
}

function judge(node: Node, ctx: Context): Truth {
  const facts = ctx.facts;
  switch (node.kind) {
    case 'and': {
      const left = judge(node.left, ctx);
      if (left === false) return false;
      const right = judge(node.right, ctx);
      if (right === false) return false;
      return left === true && right === true ? true : null;
    }
    case 'or': {
      const left = judge(node.left, ctx);
      if (left === true) return true;
      const right = judge(node.right, ctx);
      if (right === true) return true;
      return left === false && right === false ? false : null;
    }
    case 'not': {
      const operand = judge(node.operand, ctx);
      return operand === null ? null : !operand;
    }
    case 'missing':
      // A fact this phase cannot know is not "missing": it is unknown.
      if (ctx.unknowable.has(node.fact)) return null;
      return (facts[node.fact] ?? null) === null;
    case 'compare': {
      const value = facts[node.fact] ?? null;
      if (value === null) return null;
      if (node.op === '=') return equalValue(value, node.value, node.fact);
      if (node.op === '!=') return !equalValue(value, node.value, node.fact);
      if (typeof value !== 'bigint' || node.value.kind !== 'integer') return null;
      const literal = node.value.value;
      switch (node.op) {
        case '<':
          return value < literal;
        case '<=':
          return value <= literal;
        case '>':
          return value > literal;
        case '>=':
          return value >= literal;
      }
      return null;
    }
    case 'in': {
      const value = facts[node.fact] ?? null;
      if (value === null) return null;
      const found = node.values.some((literal) => equalValue(value, literal, node.fact));
      return node.negated ? !found : found;
    }
    case 'like': {
      const value = facts[node.fact] ?? null;
      if (typeof value !== 'string') return null;
      const found = likeMatch(value.toLowerCase(), node.pattern);
      return node.negated ? !found : found;
    }
  }
}

const NOTHING_UNKNOWABLE: ReadonlySet<RadarFact> = new Set();

export interface CompiledRule {
  /**
   * `true` only when the predicate is TRUE on these facts. A fact in
   * `unknowable` is UNKNOWN even to `is_missing` (ADR 0022 D1): the card before
   * the payer entered one, the provider's risk before authorization.
   */
  readonly matches: (facts: FactValues, unknowable?: ReadonlySet<RadarFact>) => boolean;
  /** The facts the predicate names. */
  readonly facts: ReadonlySet<RadarFact>;
}

/**
 * Parse, check and compile a predicate.
 *
 * @throws {RadarRuleError} naming what is wrong and where.
 */
export function compileRule(text: string): CompiledRule {
  if (text.length > RADAR_LIMITS.predicateMax) {
    throw new RadarRuleError(
      `a predicate is at most ${String(RADAR_LIMITS.predicateMax)} characters`,
      RADAR_LIMITS.predicateMax,
    );
  }
  if (text.trim() === '') throw new RadarRuleError('the predicate is empty', 0);
  const parser = new Parser(tokenize(text));
  const tree = parser.parse();
  return {
    matches: (facts, unknowable = NOTHING_UNKNOWABLE) =>
      judge(tree, { facts, unknowable }) === true,
    facts: parser.facts,
  };
}
