import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { defineConfig, type Plugin } from "vite";

/**
 * Builds sw.js (from src/sw.js) with the list of files to keep for offline play: everything
 * the build emits plus public/, except the admin page. Its version changes whenever any of them does.
 */
function offlineServiceWorker(): Plugin {
  return {
    name: "pocket-cloud:service-worker",
    apply: "build",
    enforce: "post",
    applyToEnvironment: (environment) => environment.name === "client",
    generateBundle(_options, bundle) {
      const hash = createHash("sha256");
      const urls = ["/"];
      for (const [fileName, output] of Object.entries(bundle).sort(([a], [b]) => a.localeCompare(b))) {
        hash.update(fileName);
        // Build files that aren't served (the Cloudflare plugin's .assetsignore).
        if (fileName.startsWith(".")) continue;
        // Only admins open it; players' devices shouldn't keep it.
        if (fileName === "admin.html" || fileName.startsWith("assets/admin-")) continue;
        if (fileName === "index.html") hash.update(output.type === "asset" ? output.source : "");
        else urls.push(`/${fileName}`);
      }
      for (const file of listFiles("public")) {
        const path = relative("public", file).split("\\").join("/");
        if (path === "_headers") continue;
        hash.update(path).update(readFileSync(file));
        urls.push(`/${path}`);
      }
      const source = readFileSync("src/sw.js", "utf8")
        .replace("__VERSION__", hash.digest("hex").slice(0, 12))
        .replace("__PRECACHE__", JSON.stringify(urls));
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listFiles(join(dir, entry.name)) : entry.name === ".DS_Store" ? [] : [join(dir, entry.name)],
  );
}

export default defineConfig({
  plugins: [react(), cloudflare(), offlineServiceWorker()],
  environments: {
    client: {
      // The app, and the admin dashboard (/admin) as a page of its own.
      build: { rolldownOptions: { input: { main: "index.html", admin: "admin.html" } } },
    },
  },
});
