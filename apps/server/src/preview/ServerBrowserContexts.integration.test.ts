// @effect-diagnostics nodeBuiltinImport:off - This fixture runs real Chromium against a loopback login server.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { it } from "@effect/vitest";
import { INCOGNITO_BROWSER_PROFILE_ID } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { chromium, type BrowserContext } from "playwright-core";
import { expect } from "vite-plus/test";

import { ServerBrowserContexts } from "./ServerBrowserContexts.ts";

it.live(
  "keeps fixture logins across refresh, tabs and host restart only in the same persistent profile",
  () =>
    Effect.promise(async () => {
      const directory = await NodeFSP.mkdtemp(
        NodePath.join(NodeOS.tmpdir(), "t3-profile-fixture-"),
      );
      const server = NodeHttp.createServer((request, response) => {
        if (request.url === "/login") {
          response.setHeader(
            "Set-Cookie",
            "fixture-session=signed-in; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400",
          );
        }
        response.setHeader("Content-Type", "text/html");
        response.end(
          request.url === "/login" || request.headers.cookie?.includes("fixture-session=signed-in")
            ? "<title>Fixture account</title><p>Signed in</p>"
            : "<title>Fixture login</title><p>Signed out</p>",
        );
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No fixture server port");
      const origin = `http://127.0.0.1:${address.port}`;
      const options = {
        profilesDir: directory,
        executable: async () => chromium.executablePath(),
        // CI's container cannot create Chromium's user namespaces.
        env: { ...process.env, T3CODE_SERVER_BROWSER_SANDBOX: "0" },
      };
      let pool = new ServerBrowserContexts(options);
      const expectSignedIn = async (context: BrowserContext, signedIn: boolean) => {
        const page = await context.newPage();
        await page.goto(origin);
        expect(await page.locator("p").innerText()).toBe(signedIn ? "Signed in" : "Signed out");
        await page.close();
      };
      try {
        const context = await pool.contextFor("fixture-profile");
        const page = await context.newPage();
        await page.goto(`${origin}/login`);
        await page.evaluate(() => localStorage.setItem("fixture-storage", "retained"));
        await page.reload();
        expect(await page.locator("p").innerText()).toBe("Signed in");
        await expectSignedIn(context, true);
        await page.close();
        await expectSignedIn(context, true);
        await pool.close();

        pool = new ServerBrowserContexts(options);
        const reopened = await pool.contextFor("fixture-profile");
        await expectSignedIn(reopened, true);
        const storage = await reopened.newPage();
        await storage.goto(origin);
        expect(await storage.evaluate(() => localStorage.getItem("fixture-storage"))).toBe(
          "retained",
        );
        await storage.close();
        await expectSignedIn(await pool.contextFor("different-profile"), false);
        await expectSignedIn(await pool.contextFor("fixture-profile", "isolated-agent"), false);
        const incognito = await pool.contextFor(INCOGNITO_BROWSER_PROFILE_ID);
        const privatePage = await incognito.newPage();
        await privatePage.goto(`${origin}/login`);
        await privatePage.close();
        await incognito.close();
        await expectSignedIn(await pool.contextFor(INCOGNITO_BROWSER_PROFILE_ID), false);
      } finally {
        await pool.close();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await NodeFSP.rm(directory, { recursive: true, force: true });
      }
    }),
);
