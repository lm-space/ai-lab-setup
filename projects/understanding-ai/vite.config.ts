import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API = process.env.API_PORT || "4188";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.PORT || 4186),
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${API}`,
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: Number(process.env.PORT || 4186),
  },
});
