import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const twoEffects = `import React, { useEffect } from "react";
export function Panel() {
  useEffect(() => {}, []);
  React.useLayoutEffect(() => {});
  return null;
}
`;

const threeEffects = `import React, { useEffect, useInsertionEffect } from "react";
export function Panel() {
  useEffect(() => {}, []);
  React.useLayoutEffect(() => {});
  useInsertionEffect(() => {});
  React.useEffect(() => {});
  return null;
}
`;

const reports = (output: string) => output.match(/t3code\(react-effect-budget\)/g)?.length ?? 0;

const budgeted = (filename: string) =>
  createOxlintRuleHarness("t3code/react-effect-budget", {
    filename,
    ruleOptions: (fixtureDir) => [{ root: fixtureDir }],
    files: { "scripts/effect-budget.json": JSON.stringify({ "src/Panel.tsx": 2 }) },
  });

const rule = budgeted("src/Panel.tsx");

describe("t3code/react-effect-budget", () => {
  rule.valid("passes a file at its budget", twoEffects);

  rule.invalid(
    "reports only the calls past the budget, in source order",
    threeEffects,
    (output) => {
      assert.strictEqual(reports(output), 2);
      assert.include(output, "has 4 React effects against a budget of 2");
      assert.include(output, "src/Panel.tsx:5:");
      assert.include(output, "src/Panel.tsx:6:");
      assert.notInclude(output, "src/Panel.tsx:3:");
      assert.notInclude(output, "src/Panel.tsx:4:");
    },
  );

  rule.valid(
    "ignores comments, strings and lookalike names",
    `${twoEffects}
// useEffect(() => {}) in a comment
/* React.useLayoutEffect(() => {}) */
const label = "useEffect(() => {})";
const template = \`useInsertionEffect(\${label})\`;
const pipeline = Effect.matchCauseEffect(effect, {});
const alias = useEffect;
`,
  );

  budgeted("src/New.tsx").invalid(
    "gives a file without an entry a budget of 0, counting member calls",
    `export function New() { React.useEffect(() => {}); return null; }`,
    (output) => {
      assert.strictEqual(reports(output), 1);
      assert.include(output, "has 1 React effect against a budget of 0");
    },
  );

  budgeted("src/Panel.test.tsx").valid("skips test files", threeEffects);

  budgeted("src/test/fixtures.tsx").valid("skips test directories", threeEffects);
});
