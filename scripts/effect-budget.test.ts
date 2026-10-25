import { expect, it } from "vite-plus/test";

import { countEffects, formatBudget, lowerBudget } from "./effect-budget.ts";

it("counts with the lint rule's matcher", () => {
  const source = `
    // useEffect(() => {})
    const label = "useLayoutEffect(() => {})";
    export function Panel() {
      useEffect(() => {}, []);
      React.useInsertionEffect(() => {});
      return <div title="useEffect(x)" />;
    }
  `;
  expect(countEffects("Panel.tsx", source)).toBe(2);
});

it("only lowers entries, drops the ones that reach zero, and never adds files", () => {
  const budget = { "b.tsx": 3, "a.tsx": 2, "deleted.tsx": 1 };
  expect(lowerBudget(budget, { "a.tsx": 5, "b.tsx": 1, "new.tsx": 2 })).toEqual({
    "a.tsx": 2,
    "b.tsx": 1,
  });
});

it("writes one sorted entry per line", () => {
  expect(formatBudget(lowerBudget({ "z.tsx": 1, "a.tsx": 2 }, { "z.tsx": 1, "a.tsx": 2 }))).toBe(
    '{\n  "a.tsx": 2,\n  "z.tsx": 1\n}\n',
  );
});
