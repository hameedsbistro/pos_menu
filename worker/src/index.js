// RMP POS API - Cloudflare D1

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-RMP-API-Key",
};

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: corsHeaders,
  });
}

function isAuthorized(request, env) {
  const key = request.headers.get("X-RMP-API-Key");
  return Boolean(env.RMP_API_SECRET && key === env.RMP_API_SECRET);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    try {
      // --------------------------------------------------
      // HEALTH
      // --------------------------------------------------

      if (url.pathname === "/" || url.pathname === "/health") {
        return json({
          ok: true,
          service: "RMP POS API",
          status: "running",
        });
      }

      // --------------------------------------------------
      // DATABASE TEST
      // --------------------------------------------------

      if (url.pathname === "/api/db-test" && request.method === "GET") {
        const result = await env.DB.prepare(`
          SELECT
            COUNT(*) AS total_menu_items,
            SUM(
              CASE
                WHEN image_url IS NOT NULL
                 AND TRIM(image_url) <> ''
                THEN 1 ELSE 0
              END
            ) AS items_with_images
          FROM menu_items
        `).first();

        return json({
          ok: true,
          database: "rmp_soloutions",
          total_menu_items: result?.total_menu_items ?? 0,
          items_with_images: result?.items_with_images ?? 0,
        });
      }

      // --------------------------------------------------
      // PUBLIC MENU LIST
      // --------------------------------------------------

      if (url.pathname === "/api/menu" && request.method === "GET") {
        const category = url.searchParams.get("category");
        const available = url.searchParams.get("available");

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

        if (available === "1" || available === "true") {
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

      // --------------------------------------------------
      // PUBLIC SINGLE MENU ITEM
      // --------------------------------------------------

      if (
        url.pathname.startsWith("/api/menu/") &&
        request.method === "GET"
      ) {
        const id = Number(url.pathname.split("/").pop());

        if (!Number.isInteger(id) || id <= 0) {
          return json({
            ok: false,
            error: "Invalid menu item ID",
          }, 400);
        }

        const item = await env.DB
          .prepare(`SELECT * FROM menu_items WHERE id = ? LIMIT 1`)
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

      // --------------------------------------------------
      // PROTECTED MENU UPDATE
      // --------------------------------------------------

      if (
        url.pathname.startsWith("/api/admin/menu/") &&
        request.method === "PATCH"
      ) {
        if (!isAuthorized(request, env)) {
          return json({
            ok: false,
            error: "Unauthorized",
          }, 401);
        }

        const id = Number(url.pathname.split("/").pop());

        if (!Number.isInteger(id) || id <= 0) {
          return json({
            ok: false,
            error: "Invalid menu item ID",
          }, 400);
        }

        const body = await request.json();

        const allowedFields = [
          "name_en",
          "name_ms",
          "category",
          "category_ms",
          "price",
          "takeaway_price",
          "image_url",
          "is_available",
          "is_popular",
          "kitchen_section_id",
          "category_sort_order",
          "item_sort_order",
          "source_type",
          "source_item_id",
        ];

        const updates = [];
        const values = [];

        for (const field of allowedFields) {
          if (Object.prototype.hasOwnProperty.call(body, field)) {
            updates.push(`${field} = ?`);

            if (
              field === "is_available" ||
              field === "is_popular"
            ) {
              values.push(body[field] ? 1 : 0);
            } else {
              values.push(body[field]);
            }
          }
        }

        if (updates.length === 0) {
          return json({
            ok: false,
            error: "No valid fields supplied",
          }, 400);
        }

        values.push(id);

        const result = await env.DB
          .prepare(`
            UPDATE menu_items
            SET ${updates.join(", ")}
            WHERE id = ?
          `)
          .bind(...values)
          .run();

        if (!result.meta?.changes) {
          return json({
            ok: false,
            error: "Menu item not found or not updated",
          }, 404);
        }

        const item = await env.DB
          .prepare(`SELECT * FROM menu_items WHERE id = ?`)
          .bind(id)
          .first();

        return json({
          ok: true,
          item,
        });
      }

      // --------------------------------------------------
      // PROTECTED MENU AVAILABILITY
      // --------------------------------------------------

      if (
        url.pathname.startsWith("/api/admin/menu/") &&
        url.pathname.endsWith("/availability") &&
        request.method === "PATCH"
      ) {
        if (!isAuthorized(request, env)) {
          return json({
            ok: false,
            error: "Unauthorized",
          }, 401);
        }

        const parts = url.pathname.split("/");
        const id = Number(parts[4]);

        if (!Number.isInteger(id) || id <= 0) {
          return json({
            ok: false,
            error: "Invalid menu item ID",
          }, 400);
        }

        const body = await request.json();

        if (typeof body.is_available !== "boolean") {
          return json({
            ok: false,
            error: "is_available must be true or false",
          }, 400);
        }

        const result = await env.DB
          .prepare(`
            UPDATE menu_items
            SET is_available = ?
            WHERE id = ?
          `)
          .bind(body.is_available ? 1 : 0, id)
          .run();

        if (!result.meta?.changes) {
          return json({
            ok: false,
            error: "Menu item not found",
          }, 404);
        }

        return json({
          ok: true,
          id,
          is_available: body.is_available,
        });
      }

      // --------------------------------------------------
      // NOT FOUND
      // --------------------------------------------------

      return json({
        ok: false,
        error: "Route not found",
      }, 404);

    } catch (error) {
      return json({
        ok: false,
        error: error instanceof Error
          ? error.message
          : String(error),
      }, 500);
    }
  },
};
