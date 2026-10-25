// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a synchronous git and parser report.
// Counts effect hooks and the effect patterns that synchronize state, per file and
// per package, in the non-test sources of the React clients.
//
//   node scripts/effect-report.ts                  report the working tree
//   node scripts/effect-report.ts --compare <ref>  markdown before/after against <ref>
//
// The base side of --compare is read with `git cat-file`, so nothing is checked out.
// Heuristics are syntactic and per function; see LEGEND for what each column counts.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
// The TypeScript 7 drop-in no longer exports the compiler API.
import ts from "typescript-legacy";

const root = NodePath.resolve(import.meta.dirname, "..");

export const PACKAGES = ["apps/web/src", "apps/mobile/src", "packages/client-runtime/src"] as const;

export const METRICS = ["effects", "syncEffects", "noDeps", "chained", "renderRefWrites"] as const;
export type Metric = (typeof METRICS)[number];
export type Counts = Record<Metric, number>;

const LEGEND = [
  "- **effects**: `useEffect`, `useLayoutEffect` and `useInsertionEffect` calls, including `React.useEffect`.",
  "- **syncEffects**: effects whose body, outside nested functions and the returned cleanup, calls a `useState`/`useReducer` setter of the same function, `*.setState(...)`, a non-getter `*.getState().action(...)`, or `<registry>.set(...)`.",
  "- **noDeps**: effects without a dependency array (they run after every render).",
  "- **chained**: effects whose dependency array names state that another effect in the same function sets.",
  "- **renderRefWrites**: `x.current = ...` in a component or hook body, outside nested functions (a write during render).",
].join("\n");

const EFFECT_HOOKS = new Set(["useEffect", "useLayoutEffect", "useInsertionEffect"]);
const STATE_HOOKS = new Set(["useState", "useReducer"]);

const emptyCounts = (): Counts => ({
  effects: 0,
  syncEffects: 0,
  noDeps: 0,
  chained: 0,
  renderRefWrites: 0,
});

export function isSourceFile(path: string): boolean {
  return (
    PACKAGES.some((prefix) => path.startsWith(`${prefix}/`)) &&
    /\.(ts|tsx)$/.test(path) &&
    !/\.d\.ts$/.test(path) &&
    !/\.(test|spec|bench)\.(ts|tsx)$/.test(path) &&
    !/(^|\/)(__tests__|__mocks__|test|testing)\//.test(path) &&
    !/(^|\/)test-fixtures\.(ts|tsx)$/.test(path)
  );
}

function hookName(callee: ts.Expression): string | null {
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

function isFunctionLike(node: ts.Node): node is ts.SignatureDeclaration & { body?: ts.Node } {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

// `function Foo`, `const Foo = () =>`, and `const Foo = memo(function () {})` all name `Foo`.
function functionName(node: ts.Node): string | null {
  if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name) {
    return node.name.text;
  }
  let parent = node.parent;
  while (parent && ts.isCallExpression(parent)) parent = parent.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  return null;
}

const isComponentOrHook = (name: string | null) =>
  name !== null && (/^[A-Z]/.test(name) || /^use[A-Z0-9]/.test(name));

/** Visits `node`'s descendants without entering nested functions. */
function forEachInline(node: ts.Node, visit: (node: ts.Node) => void) {
  ts.forEachChild(node, (child) => {
    if (isFunctionLike(child)) return;
    visit(child);
    forEachInline(child, visit);
  });
}

function forEachDeep(node: ts.Node, visit: (node: ts.Node) => void) {
  ts.forEachChild(node, (child) => {
    visit(child);
    forEachDeep(child, visit);
  });
}

function rootIdentifier(expression: ts.Expression): string | null {
  let current: ts.Expression = expression;
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isCallExpression(current)
  ) {
    current = current.expression;
  }
  return ts.isIdentifier(current) ? current.text : null;
}

function isStoreWrite(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const method = callee.name.text;
  if (method === "setState") return true;
  if (method === "set" && /registry$/i.test(rootIdentifier(callee.expression) ?? "")) return true;
  const target = callee.expression;
  return (
    ts.isCallExpression(target) &&
    ts.isPropertyAccessExpression(target.expression) &&
    target.expression.name.text === "getState" &&
    !/^(get|select|is|has)/.test(method)
  );
}

interface StateBinding {
  readonly setterToState: Map<string, string>;
}

function stateBindings(fn: ts.Node): StateBinding {
  const setterToState = new Map<string, string>();
  forEachInline(fn, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isArrayBindingPattern(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      STATE_HOOKS.has(hookName(node.initializer.expression) ?? "")
    ) {
      const [value, setter] = node.name.elements;
      if (setter && ts.isBindingElement(setter) && ts.isIdentifier(setter.name)) {
        const state =
          value && ts.isBindingElement(value) && ts.isIdentifier(value.name) ? value.name.text : "";
        setterToState.set(setter.name.text, state);
      }
    }
  });
  return { setterToState };
}

function calledSetter(call: ts.CallExpression, bindings: StateBinding): string | null {
  return ts.isIdentifier(call.expression) && bindings.setterToState.has(call.expression.text)
    ? call.expression.text
    : null;
}

export function analyzeSource(path: string, text: string): Counts {
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const counts = emptyCounts();

  const analyzeFunction = (fn: ts.Node & { body?: ts.Node }) => {
    if (!fn.body) return;
    const bindings = stateBindings(fn.body);
    const effects: Array<{ setStates: Set<string>; deps: Set<string> | null }> = [];

    forEachInline(fn.body, (node) => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.left) &&
        node.left.name.text === "current" &&
        isComponentOrHook(functionName(fn))
      ) {
        counts.renderRefWrites += 1;
      }
      if (!ts.isCallExpression(node) || !EFFECT_HOOKS.has(hookName(node.expression) ?? "")) return;

      counts.effects += 1;
      const [callback, depsArgument] = node.arguments;
      if (!depsArgument) counts.noDeps += 1;
      const deps =
        depsArgument && ts.isArrayLiteralExpression(depsArgument)
          ? new Set(depsArgument.elements.map((element) => rootIdentifier(element) ?? ""))
          : null;
      const setStates = new Set<string>();
      let sync = false;
      if (callback && isFunctionLike(callback) && callback.body) {
        const body = callback.body;
        forEachInline(body, (inner) => {
          if (
            ts.isCallExpression(inner) &&
            (calledSetter(inner, bindings) || isStoreWrite(inner))
          ) {
            sync = true;
          }
        });
        forEachDeep(body, (inner) => {
          const setter = ts.isCallExpression(inner) ? calledSetter(inner, bindings) : null;
          if (setter) setStates.add(bindings.setterToState.get(setter) ?? "");
        });
      }
      if (sync) counts.syncEffects += 1;
      setStates.delete("");
      effects.push({ setStates, deps });
    });

    for (const [index, effect] of effects.entries()) {
      const chained = effects.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          [...other.setStates].some((state) => effect.deps?.has(state) === true),
      );
      if (chained) counts.chained += 1;
    }
  };

  const walk = (node: ts.Node) => {
    if (isFunctionLike(node)) analyzeFunction(node);
    ts.forEachChild(node, walk);
  };
  walk(source);
  return counts;
}

export type FileCounts = ReadonlyMap<string, Counts>;

const git = (args: ReadonlyArray<string>, input?: string) =>
  NodeChildProcess.execFileSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd: root,
    encoding: "utf8",
    input,
    maxBuffer: 512 * 1024 * 1024,
  });

function readWorkingTree(): Map<string, string> {
  const files = git(["ls-files", "--cached", "--others", "--exclude-standard", "--", ...PACKAGES])
    .split("\n")
    .filter((path) => isSourceFile(path) && NodeFS.existsSync(NodePath.join(root, path)));
  return new Map(
    files.map((path) => [path, NodeFS.readFileSync(NodePath.join(root, path), "utf8")]),
  );
}

// One `git cat-file --batch` reads every blob at `ref` without a checkout.
function readRef(ref: string): Map<string, string> {
  const files = git(["ls-tree", "-r", "--name-only", ref, "--", ...PACKAGES])
    .split("\n")
    .filter(isSourceFile);
  const output = NodeChildProcess.execFileSync("git", ["cat-file", "--batch"], {
    cwd: root,
    input: files.map((path) => `${ref}:${path}`).join("\n") + "\n",
    maxBuffer: 512 * 1024 * 1024,
  });
  const contents = new Map<string, string>();
  let offset = 0;
  for (const path of files) {
    const headerEnd = output.indexOf(0x0a, offset);
    const size = Number(output.subarray(offset, headerEnd).toString("utf8").split(" ")[2]);
    contents.set(path, output.subarray(headerEnd + 1, headerEnd + 1 + size).toString("utf8"));
    offset = headerEnd + 1 + size + 1;
  }
  return contents;
}

export function analyzeFiles(contents: ReadonlyMap<string, string>): FileCounts {
  return new Map([...contents].map(([path, text]) => [path, analyzeSource(path, text)]));
}

const packageOf = (path: string) => PACKAGES.find((prefix) => path.startsWith(`${prefix}/`))!;

export function totals(files: FileCounts): Map<string, Counts> {
  const result = new Map<string, Counts>(PACKAGES.map((name) => [name, emptyCounts()]));
  const all = emptyCounts();
  for (const [path, counts] of files) {
    const total = result.get(packageOf(path))!;
    for (const metric of METRICS) {
      total[metric] += counts[metric];
      all[metric] += counts[metric];
    }
  }
  result.set("total", all);
  return result;
}

const row = (cells: ReadonlyArray<string | number>) => `| ${cells.join(" | ")} |`;
const header = (first: string) =>
  [row([first, ...METRICS]), row([":--", ...METRICS.map(() => "--:")])].join("\n");
const isEmpty = (counts: Counts) => METRICS.every((metric) => counts[metric] === 0);

export function renderReport(files: FileCounts): string {
  const lines = ["### Effect report", "", header("package")];
  for (const [name, counts] of totals(files)) {
    lines.push(row([name, ...METRICS.map((metric) => counts[metric])]));
  }
  lines.push("", header("file"));
  const sorted = [...files]
    .filter(([, counts]) => !isEmpty(counts))
    .sort(([a, x], [b, y]) => y.effects - x.effects || a.localeCompare(b));
  for (const [path, counts] of sorted) {
    lines.push(row([`\`${path}\``, ...METRICS.map((metric) => counts[metric])]));
  }
  lines.push("", LEGEND);
  return lines.join("\n");
}

const delta = (before: number, after: number) =>
  before === after
    ? `${after}`
    : `${before} → ${after} (${after > before ? "+" : ""}${after - before})`;

export function renderComparison(ref: string, before: FileCounts, after: FileCounts): string {
  const lines = [`### Effect report: \`${ref}\` → working tree`, "", header("package")];
  const beforeTotals = totals(before);
  for (const [name, counts] of totals(after)) {
    const base = beforeTotals.get(name)!;
    lines.push(row([name, ...METRICS.map((metric) => delta(base[metric], counts[metric]))]));
  }
  const changed = [...new Set([...before.keys(), ...after.keys()])].toSorted().flatMap((path) => {
    const base = before.get(path) ?? emptyCounts();
    const next = after.get(path) ?? emptyCounts();
    return METRICS.some((metric) => base[metric] !== next[metric])
      ? [[path, base, next] as const]
      : [];
  });
  lines.push("", changed.length ? header("changed file") : "No file changed any count.");
  for (const [path, base, next] of changed) {
    lines.push(row([`\`${path}\``, ...METRICS.map((metric) => delta(base[metric], next[metric]))]));
  }
  lines.push("", LEGEND);
  return lines.join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "Usage: node scripts/effect-report.ts [--compare <git-ref>]\n\n" +
        "Without --compare, prints per-package totals and per-file counts for the working tree.\n" +
        "With --compare, prints a markdown before/after table against <git-ref>.\n\n" +
        LEGEND,
    );
  } else {
    const compareIndex = args.indexOf("--compare");
    const after = analyzeFiles(readWorkingTree());
    if (compareIndex === -1) {
      console.log(renderReport(after));
    } else {
      const ref = args[compareIndex + 1];
      if (!ref) throw new Error("--compare needs a git ref");
      console.log(renderComparison(ref, analyzeFiles(readRef(ref)), after));
    }
  }
}
