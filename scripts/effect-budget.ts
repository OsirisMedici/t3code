// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Lowers each scripts/effect-budget.json entry to the file's current React effect
// count and drops entries that reach 0. It never adds or raises one: that is a
// deliberate edit in the PR that needs the effect. `t3code/react-effect-budget`
// enforces the budget.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { parseSync, Visitor } from "oxc-parser";

import {
  EFFECT_BUDGET_FILE,
  type EffectBudget,
  isEffectHookCall,
  readEffectBudget,
  REPO_ROOT,
} from "@t3tools/oxlint-plugin-t3code/react-effect-budget";

export function countEffects(fileName: string, source: string): number {
  let count = 0;
  new Visitor({
    CallExpression(node) {
      if (isEffectHookCall(node)) count += 1;
    },
  }).visit(parseSync(fileName, source).program);
  return count;
}

/** Lowers each entry to its current count and drops entries that reach 0. Never adds or raises. */
export function lowerBudget(budget: EffectBudget, counts: EffectBudget): EffectBudget {
  return Object.fromEntries(
    Object.entries(budget)
      .map(([file, allowed]) => [file, Math.min(allowed, counts[file] ?? 0)] as const)
      .filter(([, allowed]) => allowed > 0)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

export function formatBudget(budget: EffectBudget): string {
  return `${JSON.stringify(budget, null, 2)}\n`;
}

const total = (budget: EffectBudget) => Object.values(budget).reduce((sum, n) => sum + n, 0);

if (import.meta.main) {
  const budget = readEffectBudget(REPO_ROOT);
  const counts = Object.fromEntries(
    Object.keys(budget).map((file) => {
      const path = NodePath.join(REPO_ROOT, file);
      return [
        file,
        NodeFS.existsSync(path) ? countEffects(file, NodeFS.readFileSync(path, "utf8")) : 0,
      ];
    }),
  );
  const lowered = lowerBudget(budget, counts);
  NodeFS.writeFileSync(NodePath.join(REPO_ROOT, EFFECT_BUDGET_FILE), formatBudget(lowered));
  console.log(
    `effect-budget: lowered the budget by ${total(budget) - total(lowered)} to ${total(lowered)}.`,
  );
}
