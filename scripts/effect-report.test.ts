import { describe, expect, it } from "vite-plus/test";

import { analyzeSource, isSourceFile, renderComparison } from "./effect-report.ts";

const counts = (text: string) => analyzeSource("apps/web/src/Example.tsx", text);

describe("analyzeSource", () => {
  it("counts effect hooks, including member calls, and those without deps", () => {
    expect(
      counts(`
        function Example() {
          useEffect(() => {}, []);
          React.useLayoutEffect(() => {});
          useInsertionEffect(() => {}, [a]);
          useMemo(() => 1, []);
        }
      `),
    ).toMatchObject({ effects: 3, noDeps: 1 });
  });

  it("flags effects that synchronously set state or write a store, but not in callbacks or cleanup", () => {
    expect(
      counts(`
        function Example({ value }) {
          const [copy, setCopy] = useState(value);
          useEffect(() => { setCopy(value); }, [value]);
          useEffect(() => { useStore.getState().openPanel(value); }, [value]);
          useEffect(() => { appAtomRegistry.set(atom, value); }, [value]);
          useEffect(() => { store.setState({ value }); }, [value]);
          useEffect(() => { const id = setTimeout(() => setCopy(1)); return () => setCopy(0); }, []);
          useEffect(() => { useStore.getState().getValue(); }, []);
        }
      `),
    ).toMatchObject({ effects: 6, syncEffects: 4 });
  });

  it("does not treat another function's setter as this component's", () => {
    expect(
      counts(`
        function Outer() { const [, setValue] = useState(0); }
        function Inner() { useEffect(() => { setValue(1); }, []); }
      `),
    ).toMatchObject({ syncEffects: 0 });
  });

  it("counts an effect whose deps name state another effect sets", () => {
    expect(
      counts(`
        function Example({ value }) {
          const [first, setFirst] = useState(0);
          const [second, setSecond] = useState(0);
          useEffect(() => { setFirst(value); }, [value]);
          useEffect(() => { setSecond(first + 1); }, [first]);
          useEffect(() => {}, [second]);
        }
      `),
    ).toMatchObject({ chained: 2 });
  });

  it("counts ref writes in component and hook bodies only", () => {
    expect(
      counts(`
        function Example({ value }) {
          const ref = useRef(value);
          ref.current = value;
          useEffect(() => { ref.current = value; });
          const onClick = () => { ref.current = 0; };
        }
        function useLatest(value) { const ref = useRef(value); ref.current = value; return ref; }
        function helper(ref) { ref.current = 1; }
      `),
    ).toMatchObject({ renderRefWrites: 2 });
  });
});

describe("isSourceFile", () => {
  it("keeps client sources and drops tests, fixtures and other packages", () => {
    expect(isSourceFile("apps/web/src/components/ChatView.tsx")).toBe(true);
    expect(isSourceFile("packages/client-runtime/src/state/threads.ts")).toBe(true);
    expect(isSourceFile("apps/web/src/components/ChatView.browser.test.tsx")).toBe(false);
    expect(isSourceFile("apps/web/src/test-fixtures.ts")).toBe(false);
    expect(isSourceFile("apps/server/src/ws.ts")).toBe(false);
  });
});

describe("renderComparison", () => {
  it("prints package deltas and only the files whose counts changed", () => {
    const zero = { effects: 0, syncEffects: 0, noDeps: 0, chained: 0, renderRefWrites: 0 };
    const before = new Map([
      ["apps/web/src/A.tsx", { ...zero, effects: 3, syncEffects: 1 }],
      ["apps/web/src/B.tsx", { ...zero, effects: 1 }],
    ]);
    const after = new Map([
      ["apps/web/src/A.tsx", { ...zero, effects: 1 }],
      ["apps/web/src/B.tsx", { ...zero, effects: 1 }],
    ]);
    const output = renderComparison("main", before, after);
    expect(output).toContain("| apps/web/src | 4 → 2 (-2) | 1 → 0 (-1) | 0 | 0 | 0 |");
    expect(output).toContain("`apps/web/src/A.tsx`");
    expect(output).not.toContain("`apps/web/src/B.tsx`");
  });
});
