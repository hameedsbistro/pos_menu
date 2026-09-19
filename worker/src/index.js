export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Basic CORS
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    };

    // Handle browser preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    try {
      // API health check
      if (url.pathname === "/" || url.pathname === "/health") {
        return Response.json(
          {
            ok: true,
            service: "RMP POS API",
            status: "running"
          },
          {
            headers: corsHeaders
          }
        );
      }

      // D1 connection test
      if (url.pathname === "/api/db-test" && request.method === "GET") {
        const result = await env.DB
          .prepare(`
            SELECT
              COUNT(*) AS total_menu_items,
              SUM(CASE WHEN image_url IS NOT NULL
                        AND TRIM(image_url) <> ''
                       THEN 1 ELSE 0 END) AS items_with_images
            FROM menu_items
          `)
          .first();

        return Response.json(
          {
            ok: true,
            database: "rmp_soloutions",
            total_menu_items: result?.total_menu_items ?? 0,
            items_with_images: result?.items_with_images ?? 0
          },
          {
            headers: corsHeaders
          }
        );
      }

      return Response.json(
        {
          ok: false,
          error: "Route not found"
        },
        {
          status: 404,
          headers: corsHeaders
        }
      );

    } catch (error) {
      return Response.json(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        },
        {
          status: 500,
          headers: corsHeaders
        }
      );
    }
  }
};
