export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
}

const worker: ExportedHandler<Env> = {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/api/health") {
      return Response.json({ ok: true, service: "switch-price-monitor" });
    }

    return env.ASSETS.fetch(request);
  },
};

export default worker;
