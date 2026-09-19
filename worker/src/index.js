// ============================================================
// RMP POS API
// Cloudflare Worker + Cloudflare D1
// Database: rmp_soloutions
// ============================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-RMP-API-Key",
};


// ============================================================
// RESPONSE HELPER
// ============================================================

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: corsHeaders,
  });
}


// ============================================================
// ADMIN / POS AUTHORIZATION
// ============================================================

function isAuthorized(request, env) {
  const key = request.headers.get("X-RMP-API-Key");

  return Boolean(
    env.RMP_API_SECRET &&
    key &&
    key === env.RMP_API_SECRET
  );
}


// ============================================================
// MAIN WORKER
// ============================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // --------------------------------------------------------
    // CORS PREFLIGHT
    // --------------------------------------------------------

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    try {

      // ======================================================
      // HEALTH CHECK
      // GET /
      // GET /health
      // ======================================================

      if (
        url.pathname === "/" ||
        url.pathname === "/health"
      ) {
        return json({
          ok: true,
          service: "RMP POS API",
          status: "running",
        });
      }


      // ======================================================
      // DATABASE TEST
      // GET /api/db-test
      // ======================================================

      if (
        url.pathname === "/api/db-test" &&
        request.method === "GET"
      ) {
        const result = await env.DB
          .prepare(`
            SELECT
              COUNT(*) AS total_menu_items,

              SUM(
                CASE
                  WHEN image_url IS NOT NULL
                   AND TRIM(image_url) <> ''
                  THEN 1
                  ELSE 0
                END
              ) AS items_with_images

            FROM menu_items
          `)
          .first();

        return json({
          ok: true,
          database: "rmp_soloutions",
          total_menu_items:
            result?.total_menu_items ?? 0,
          items_with_images:
            result?.items_with_images ?? 0,
        });
      }


      // ======================================================
      // PUBLIC MENU LIST
      // GET /api/menu
      //
      // Optional:
      // ?category=AIR
      // ?available=1
      // ======================================================

      if (
        url.pathname === "/api/menu" &&
        request.method === "GET"
      ) {
        const category =
          url.searchParams.get("category");

        const available =
          url.searchParams.get("available");

        let sql = `
          SELECT *
          FROM menu_items
          WHERE 1 = 1
        `;

        const params = [];

        if (category) {
          sql += ` AND category = ?`;
          params.push(category);
        }

        if (
          available === "1" ||
          available === "true"
        ) {
          sql += ` AND is_available = 1`;
        }

        sql += `
          ORDER BY
            COALESCE(category_sort_order, 999999),
            category,
            COALESCE(item_sort_order, 999999),
            id
        `;

        const statement = env.DB.prepare(sql);

        const result = params.length
          ? await statement.bind(...params).all()
          : await statement.all();

        return json({
          ok: true,
          count: result.results?.length ?? 0,
          items: result.results ?? [],
        });
      }


      // ======================================================
      // PUBLIC SINGLE MENU ITEM
      // GET /api/menu/:id
      // ======================================================

      if (
        /^\/api\/menu\/\d+$/.test(url.pathname) &&
        request.method === "GET"
      ) {
        const id =
          Number(url.pathname.split("/").pop());

        if (
          !Number.isInteger(id) ||
          id <= 0
        ) {
          return json({
            ok: false,
            error: "Invalid menu item ID",
          }, 400);
        }

        const item = await env.DB
          .prepare(`
            SELECT *
            FROM menu_items
            WHERE id = ?
            LIMIT 1
          `)
          .bind(id)
          .first();

        if (!item) {
          return json({
            ok: false,
            error: "Menu item not found",
          }, 404);
        }

        return json({
          ok: true,
          item,
        });
      }


      // ======================================================
      // PROTECTED MENU UPDATE
      // PATCH /api/admin/menu/:id
      // ======================================================

      if (
        /^\/api\/admin\/menu\/\d+$/.test(
          url.pathname
        ) &&
        request.method === "PATCH"
      ) {
        if (!isAuthorized(request, env)) {
          return json({
            ok: false,
            error: "Unauthorized",
          }, 401);
        }

        const id =
          Number(url.pathname.split("/").pop());

        if (
          !Number.isInteger(id) ||
          id <= 0
        ) {
          return json({
            ok: false,
            error: "Invalid menu item ID",
          }, 400);
        }

        const body = await request.json();

        const allowedFields = [
          "name_en",
          "name_ms",
          "name_en_us",
         
