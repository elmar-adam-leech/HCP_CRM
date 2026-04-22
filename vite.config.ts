import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

export default defineConfig({
  plugins: [
    react(),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  root: path.resolve(import.meta.dirname, "client"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler|wouter|react-is|prop-types|use-sync-external-store|mitt|regexparam)[\\/]/.test(id)) return "react-vendor";
          if (/[\\/]node_modules[\\/](@radix-ui|@floating-ui|aria-hidden|react-remove-scroll|react-remove-scroll-bar|react-style-singleton|use-callback-ref|use-sidecar|get-nonce|tslib|detect-node-es)[\\/]/.test(id)) return "radix-vendor";
          if (/[\\/]node_modules[\\/]@tanstack[\\/]/.test(id)) return "query-vendor";
          if (/[\\/]node_modules[\\/](recharts|d3-|victory-vendor)/.test(id)) return "charts-vendor";
          if (/[\\/]node_modules[\\/](reactflow|@reactflow)[\\/]/.test(id)) return "flow-vendor";
          if (/[\\/]node_modules[\\/]date-fns/.test(id)) return "date-vendor";
          if (/[\\/]node_modules[\\/](lucide-react|react-icons)[\\/]/.test(id)) return "icons-vendor";
          if (/[\\/]node_modules[\\/](react-markdown|micromark|micromark-.*|mdast-.*|hast-.*|unified|vfile|vfile-.*|unist-.*|property-information|bail|trough|is-plain-obj|character-entities|character-entities-html4|character-reference-invalid|decode-named-character-reference|html-void-elements|space-separated-tokens|comma-separated-tokens|ccount|escape-string-regexp|markdown-table|zwitch|longest-streak|stringify-entities|remark-.*|rehype-.*|dompurify)[\\/]/.test(id)) return "markdown-vendor";
          if (/[\\/]node_modules[\\/](react-hook-form|@hookform)[\\/]/.test(id)) return "form-vendor";
          if (/[\\/]node_modules[\\/]@dnd-kit[\\/]/.test(id)) return "dnd-vendor";
          if (/[\\/]node_modules[\\/](react-day-picker|vaul|cmdk)[\\/]/.test(id)) return "overlay-vendor";
          if (/[\\/]node_modules[\\/](zod|drizzle-orm|drizzle-zod)[\\/]/.test(id)) return "zod-vendor";
          if (/[\\/]node_modules[\\/]lodash([._-]|[\\/])/.test(id)) return "lodash-vendor";
          return "vendor";
        },
      },
    },
  },
  server: {
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});
