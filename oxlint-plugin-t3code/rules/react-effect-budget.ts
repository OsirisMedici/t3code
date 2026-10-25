// @effect-diagnostics nodeBuiltinImport:off
import { defineRule, type ESTree } from "@oxlint/plugins";
import * as Option from "effect/Option";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { getPropertyName, unwrapExpression } from "../utils.ts";

export type EffectBudget = Readonly<Record<string, number>>;

export const EFFECT_BUDGET_FILE = "scripts/effect-budget.json";
export const REPO_ROOT = NodePath.resolve(import.meta.dirname, "..", "..");

const EFFECT_HOOKS = new Set(["useEffect", "useLayoutEffect", "useInsertionEffect"]);
const EFFECT_HOOK_TEXT = /use(?:Layout|Insertion)?Effect/;
const UNBUDGETED_FILE = /\.test\.[cm]?[jt]sx?$|(?:^|\/)(?:test|__tests__)\//;

/** Matches `useEffect(...)` and member calls such as `React.useEffect(...)`. */
export function isEffectHookCall(node: { readonly callee: unknown }): boolean {
  const callee = unwrapExpression(node.callee);
  if (Option.isNone(callee)) return false;
  const expression = callee.value;
  if (expression.type === "Identifier") return EFFECT_HOOKS.has(expression.name);
  if (expression.type === "MemberExpression" && !expression.computed) {
    return Option.exists(getPropertyName(expression.property), (name) => EFFECT_HOOKS.has(name));
  }
  return false;
}

export function isBudgetedFile(repoPath: string): boolean {
  return !repoPath.startsWith("..") && !UNBUDGETED_FILE.test(repoPath);
}

export function repoPathOf(root: string, fileName: string): string {
  return NodePath.relative(root, fileName).split(NodePath.sep).join("/");
}

export function readEffectBudget(root: string): EffectBudget {
  return JSON.parse(NodeFS.readFileSync(NodePath.join(root, EFFECT_BUDGET_FILE), "utf8"));
}

const budgets = new Map<string, EffectBudget>();
const cachedBudget = (root: string): EffectBudget => {
  let budget = budgets.get(root);
  if (budget === undefined) {
    budget = readEffectBudget(root);
    budgets.set(root, budget);
  }
  return budget;
};

const readRoot = (options: ReadonlyArray<unknown>): string => {
  const [first] = options;
  return typeof first === "object" &&
    first !== null &&
    "root" in first &&
    typeof first.root === "string"
    ? first.root
    : REPO_ROOT;
};

export default defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description: `Hold each file to the React effect hooks it is allowed in ${EFFECT_BUDGET_FILE}; a missing entry allows none.`,
    },
    schema: [
      {
        type: "object",
        properties: {
          root: {
            type: "string",
            description: `Directory that budget keys are relative to and that holds ${EFFECT_BUDGET_FILE}. Defaults to the repository root.`,
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const root = readRoot(context.options);
    const repoPath = repoPathOf(root, context.filename);
    if (!isBudgetedFile(repoPath) || !EFFECT_HOOK_TEXT.test(context.sourceCode.text)) return {};

    const calls: Array<ESTree.CallExpression> = [];
    return {
      CallExpression(node) {
        if (isEffectHookCall(node)) calls.push(node);
      },
      "Program:exit"() {
        const budget = cachedBudget(root)[repoPath] ?? 0;
        if (calls.length <= budget) return;
        const message =
          `This file has ${calls.length} React ${calls.length === 1 ? "effect" : "effects"} against a budget of ${budget}. ` +
          "Prefer deriving in render, event handlers, a `key` reset, an element-owned ref callback, or a store. " +
          `If an effect is genuinely right, raise this file's entry in ${EFFECT_BUDGET_FILE} in the same PR.`;
        for (const node of calls.slice(budget)) context.report({ node, message });
      },
    };
  },
});
