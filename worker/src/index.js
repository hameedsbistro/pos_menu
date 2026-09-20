// ============================================================
// RMP POS API
// Cloudflare Worker + Cloudflare D1
// Database: rmp_soloutions
// ============================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-RMP-API-Key",
};

function json(data, status = 200) {
  return Response.json(data, { status, headers: corsHeaders });
}

function isAuthorized(request, env) {
  const key = request.headers.get("X-RMP-API-Key");
  return Boolean(env.RMP_API_SECRET && key && key === env.RMP_API_SECRET);
}

function positiveInteger(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      // Health
      if (url.pathname === "/" || url.pathname === "/health") {
        return json({ ok: true, service: "RMP POS API", status: "running" });
      }

      // DB test
      if (url.pathname === "/api/db-test" && request.method === "GET") {
        const result = await env.DB.prepare(`
          SELECT COUNT(*) AS total_menu_items,
                 SUM(CASE WHEN image_url IS NOT NULL AND TRIM(image_url) <> '' THEN 1 ELSE 0 END) AS items_with_images
          FROM menu_items
        `).first();

        return json({
          ok: true,
          database: "rmp_soloutions",
          total_menu_items: result?.total_menu_items ?? 0,
          items_with_images: result?.items_with_images ?? 0,
        });
      }

      // Public menu list
      if (url.pathname === "/api/menu" && request.method === "GET") {
        const category = url.searchParams.get("category");
        const available = url.searchParams.get("available");

        let sql = `SELECT * FROM menu_items WHERE 1 = 1`;
        const params = [];

        if (category) {
          sql += ` AND category = ?`;
          params.push(category);
        }

        if (available === "1" || available === "true") {
          sql += ` AND is_available = 1`;
        }

        sql += `
          ORDER BY COALESCE(category_sort_order, 999999),
                   category,
                   COALESCE(item_sort_order, 999999),
                   id
        `;

        const stmt = env.DB.prepare(sql);
        const result = params.length
          ? await stmt.bind(...params).all()
          : await stmt.all();

        return json({
          ok: true,
          count: result.results?.length ?? 0,
          items: result.results ?? [],
        });
      }

      // Public single menu item
      if (/^\/api\/menu\/\d+$/.test(url.pathname) && request.method === "GET") {
        const id = positiveInteger(url.pathname.split("/").pop());
        if (!id) return json({ ok: false, error: "Invalid menu item ID" }, 400);

        const item = await env.DB.prepare(`
          SELECT * FROM menu_items WHERE id = ? LIMIT 1
        `).bind(id).first();

        if (!item) return json({ ok: false, error: "Menu item not found" }, 404);
        return json({ ok: true, item });
      }

      // IMPORTANT: availability route comes before generic admin menu route
      if (
        /^\/api\/admin\/menu\/\d+\/availability$/.test(url.pathname) &&
        request.method === "PATCH"
      ) {
        if (!isAuthorized(request, env)) {
          return json({ ok: false, error: "Unauthorized" }, 401);
        }

        const id = positiveInteger(url.pathname.split("/")[4]);
        if (!id) return json({ ok: false, error: "Invalid menu item ID" }, 400);

        const body = await request.json();
        if (typeof body.is_available !== "boolean") {
          return json({ ok: false, error: "is_available must be true or false" }, 400);
        }

        const result = await env.DB.prepare(`
          UPDATE menu_items SET is_available = ? WHERE id = ?
        `).bind(body.is_available ? 1 : 0, id).run();

        if (!result.meta?.changes) {
          return json({ ok: false, error: "Menu item not found" }, 404);
        }

        return json({ ok: true, id, is_available: body.is_available });
      }

      // Protected generic menu update
      if (
        /^\/api\/admin\/menu\/\d+$/.test(url.pathname) &&
        request.method === "PATCH"
      ) {
        if (!isAuthorized(request, env)) {
          return json({ ok: false, error: "Unauthorized" }, 401);
        }

        const id = positiveInteger(url.pathname.split("/").pop());
        if (!id) return json({ ok: false, error: "Invalid menu item ID" }, 400);

        const body = await request.json();
        const allowedFields = [
          "name_en","name_ms","name_en_us","name_bn","name_hi","name_ta","name_ar","name_zh",
          "category","category_ms","category_en_us","category_bn","category_hi","category_ta",
          "category_ar","category_zh","dine_in_price","takeaway_price","translations","image_url",
          "kitchen_section_id","is_popular","is_available","sold_quantity","translation_status",
          "translation_source_hash","translated_at","translation_error","category_sort_order",
          "item_sort_order","source_type","source_item_id"
        ];

        const updates = [];
        const values = [];

        for (const field of allowedFields) {
          if (Object.prototype.hasOwnProperty.call(body, field)) {
            updates.push(`${field} = ?`);
            if (field === "is_available" || field === "is_popular") {
              values.push(body[field] ? 1 : 0);
            } else {
              values.push(body[field]);
            }
          }
        }

        if (!updates.length) {
          return json({ ok: false, error: "No valid fields supplied" }, 400);
        }

        values.push(id);
        const result = await env.DB.prepare(`
          UPDATE menu_items SET ${updates.join(", ")} WHERE id = ?
        `).bind(...values).run();

        if (!result.meta?.changes) {
          return json({ ok: false, error: "Menu item not found or not updated" }, 404);
        }

        const item = await env.DB.prepare(`
          SELECT * FROM menu_items WHERE id = ?
        `).bind(id).first();

        return json({ ok: true, item });
      }

      // Protected Supabase Storage -> R2 image migration
      if (url.pathname === "/api/admin/migrate-images/status" && request.method === "GET") {
        if (!isAuthorized(request, env)) return json({ ok: false, error: "Unauthorized" }, 401);
        const status = await env.DB.prepare(`
          SELECT COUNT(*) AS total_items,
          SUM(CASE WHEN INSTR(image_url, 'supabase.co/storage/') > 0 THEN 1 ELSE 0 END) AS remaining_supabase,
          SUM(CASE WHEN INSTR(image_url, 'https://pub-404ee6980d804bcbba9aafdaf936ccb6.r2.dev/') = 1 THEN 1 ELSE 0 END) AS migrated_r2
          FROM menu_items
          WHERE image_url IS NOT NULL AND TRIM(image_url) <> ''
        `).first();
        return json({ ok: true, ...status });
      }

      if (url.pathname === "/api/admin/migrate-images" && request.method === "POST") {
        if (!isAuthorized(request, env)) return json({ ok: false, error: "Unauthorized" }, 401);
        if (!env.MENU_IMAGES) return json({ ok: false, error: "R2 binding MENU_IMAGES is missing" }, 500);

        const requestedLimit = Number(url.searchParams.get("limit") || 20);
        const limit = Math.max(1, Math.min(Number.isInteger(requestedLimit) ? requestedLimit : 20, 20));
        const R2_PUBLIC_BASE = "https://pub-404ee6980d804bcbba9aafdaf936ccb6.r2.dev";

        const rows = await env.DB.prepare(`
          SELECT id, name_en, image_url
          FROM menu_items
          WHERE image_url IS NOT NULL AND TRIM(image_url) <> ''
            AND INSTR(image_url, 'supabase.co/storage/') > 0
          ORDER BY id LIMIT ?
        `).bind(limit).all();

        const migrated = [];
        const failed = [];

        for (const row of (rows.results || [])) {
          const oldUrl = String(row.image_url || "").trim();
          try {
            const source = new URL(oldUrl);
            const rawName = decodeURIComponent(source.pathname.split("/").pop() || `image-${row.id}.jpg`);
            const safeName = rawName.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || `image-${row.id}.jpg`;
            const key = `menu/${row.id}-${safeName}`;

            const imageResponse = await fetch(oldUrl, {
              headers: { "User-Agent": "RMP-POS-R2-Migration/1.0" },
              redirect: "follow"
            });
            if (!imageResponse.ok || !imageResponse.body) throw new Error(`Source HTTP ${imageResponse.status}`);

            const contentType = imageResponse.headers.get("content-type") || "application/octet-stream";
            await env.MENU_IMAGES.put(key, imageResponse.body, {
              httpMetadata: { contentType, cacheControl: "public, max-age=31536000, immutable" },
              customMetadata: { menu_item_id: String(row.id), source_url: oldUrl }
            });

            const newUrl = `${R2_PUBLIC_BASE}/${key}`;
            const update = await env.DB.prepare(`
              UPDATE menu_items SET image_url = ?
              WHERE id = ? AND image_url = ?
            `).bind(newUrl, row.id, oldUrl).run();

            if (!update.meta?.changes) throw new Error("D1 image_url changed before migration update");
            migrated.push({ id: row.id, name_en: row.name_en, old_url: oldUrl, new_url: newUrl });
          } catch (error) {
            failed.push({
              id: row.id, name_en: row.name_en, image_url: oldUrl,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }

        const remaining = await env.DB.prepare(`
          SELECT COUNT(*) AS count FROM menu_items
          WHERE image_url IS NOT NULL AND TRIM(image_url) <> ''
            AND INSTR(image_url, 'supabase.co/storage/') > 0
        `).first();

        return json({
          ok: failed.length === 0,
          attempted: (rows.results || []).length,
          migrated_count: migrated.length,
          failed_count: failed.length,
          remaining_supabase: Number(remaining?.count || 0),
          migrated, failed
        }, failed.length ? 207 : 200);
      }

      // Customer order creation
      if (url.pathname === "/api/customer/orders" && request.method === "POST") {
        const body = await request.json();

        const customerId = Number(body.customer_id);
        const customerName = String(body.customer_name || "").trim();
        const customerPhone = String(body.customer_phone || "").trim();
        const orderType = String(body.order_type || "").trim();
        const section = body.section == null ? null : String(body.section).trim();
        const tableId = body.table_id == null ? null : String(body.table_id).trim();
        const tableNo = body.table_no == null ? null : String(body.table_no).trim();
        const subtotal = String(body.subtotal ?? "0");
        const sstTax = String(body.sst_tax ?? "0");
        const totalAmount = Number(body.total_amount);
        const orderNote = body.order_note == null ? null : String(body.order_note);
        const items = Array.isArray(body.items) ? body.items : [];

        if (!Number.isInteger(customerId) || customerId <= 0) {
          return json({ ok: false, error: "Customer login is required." }, 400);
        }
        if (!customerName) {
          return json({ ok: false, error: "Customer name is required." }, 400);
        }
        if (!orderType) {
          return json({ ok: false, error: "Order type is required." }, 400);
        }
        if (!Number.isFinite(totalAmount) || totalAmount < 0) {
          return json({ ok: false, error: "Invalid total amount." }, 400);
        }
        if (!items.length) {
          return json({ ok: false, error: "Order cart is empty." }, 400);
        }

        const customer = await env.DB.prepare(`
          SELECT id FROM customers WHERE id = ? LIMIT 1
        `).bind(customerId).first();

        if (!customer) {
          return json({ ok: false, error: "Customer not found." }, 404);
        }

        for (const item of items) {
          const menuItemId = Number(item.menu_item_id);
          const quantity = Number(item.quantity ?? 1);
          const price = Number(item.price);

          if (
            !Number.isInteger(menuItemId) || menuItemId <= 0 ||
            !Number.isInteger(quantity) || quantity <= 0 ||
            !Number.isFinite(price) || price < 0
          ) {
            return json({ ok: false, error: "Invalid order item." }, 400);
          }
        }

        const uniqueMenuIds = [...new Set(items.map(i => Number(i.menu_item_id)))];
        const placeholders = uniqueMenuIds.map(() => "?").join(",");

        const menuCheck = await env.DB.prepare(`
          SELECT id FROM menu_items WHERE id IN (${placeholders})
        `).bind(...uniqueMenuIds).all();

        const existingIds = new Set(
          (menuCheck.results || []).map(row => Number(row.id))
        );

        for (const id of uniqueMenuIds) {
          if (!existingIds.has(id)) {
            return json({ ok: false, error: `Menu item ${id} not found.` }, 400);
          }
        }

        const orderInsert = await env.DB.prepare(`
          INSERT INTO orders (
            customer_id, customer_name, customer_phone,
            order_type, section, table_id, table_no,
            status, payment_status,
            subtotal, sst_tax, total_amount, order_note
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'unpaid', ?, ?, ?, ?)
          RETURNING id
        `).bind(
          customerId,
          customerName,
          customerPhone || null,
          orderType,
          section,
          tableId,
          tableNo,
          subtotal,
          sstTax,
          totalAmount,
          orderNote
        ).first();

        const orderId = Number(orderInsert?.id);
        if (!Number.isInteger(orderId) || orderId <= 0) {
          throw new Error("Order ID could not be created.");
        }

        const itemStatements = items.map(item => {
          let modifiers = item.modifiers ?? [];
          if (typeof modifiers !== "string") modifiers = JSON.stringify(modifiers);

          return env.DB.prepare(`
            INSERT INTO order_items (
              order_id, menu_item_id, price, quantity, modifiers
            )
            VALUES (?, ?, ?, ?, ?)
          `).bind(
            orderId,
            Number(item.menu_item_id),
            Number(item.price),
            Number(item.quantity ?? 1),
            modifiers
          );
        });

        try {
          if (itemStatements.length) await env.DB.batch(itemStatements);
        } catch (err) {
          await env.DB.prepare(`DELETE FROM orders WHERE id = ?`).bind(orderId).run();
          throw err;
        }

        return json({
          ok: true,
          order_id: orderId,
          status: "pending",
          payment_status: "unpaid",
        }, 201);
      }

      // Protected orders list
      if (url.pathname === "/api/orders" && request.method === "GET") {
        if (!isAuthorized(request, env)) {
          return json({ ok: false, error: "Unauthorized" }, 401);
        }

        const status = url.searchParams.get("status");
        const paymentStatus = url.searchParams.get("payment_status");
        const tableId = url.searchParams.get("table_id");

        let sql = `SELECT * FROM orders WHERE 1 = 1`;
        const params = [];

        if (status) {
          sql += ` AND status = ?`;
          params.push(status);
        }
        if (paymentStatus) {
          sql += ` AND payment_status = ?`;
          params.push(paymentStatus);
        }
        if (tableId) {
          sql += ` AND table_id = ?`;
          params.push(tableId);
        }

        sql += ` ORDER BY created_at DESC, id DESC LIMIT 500`;

        const stmt = env.DB.prepare(sql);
        const result = params.length
          ? await stmt.bind(...params).all()
          : await stmt.all();

        return json({
          ok: true,
          count: result.results?.length ?? 0,
          orders: result.results ?? [],
        });
      }

      // Protected order items
      if (
        /^\/api\/orders\/\d+\/items$/.test(url.pathname) &&
        request.method === "GET"
      ) {
        if (!isAuthorized(request, env)) {
          return json({ ok: false, error: "Unauthorized" }, 401);
        }

        const orderId = positiveInteger(url.pathname.split("/")[3]);
        if (!orderId) return json({ ok: false, error: "Invalid order ID" }, 400);

        const order = await env.DB.prepare(`
          SELECT id FROM orders WHERE id = ? LIMIT 1
        `).bind(orderId).first();

        if (!order) return json({ ok: false, error: "Order not found" }, 404);

        const result = await env.DB.prepare(`
          SELECT oi.*, mi.name_en, mi.category, mi.image_url
          FROM order_items oi
          LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
          WHERE oi.order_id = ?
          ORDER BY oi.id
        `).bind(orderId).all();

        return json({
          ok: true,
          count: result.results?.length ?? 0,
          items: result.results ?? [],
        });
      }

      // Protected single order
      if (/^\/api\/orders\/\d+$/.test(url.pathname) && request.method === "GET") {
        if (!isAuthorized(request, env)) {
          return json({ ok: false, error: "Unauthorized" }, 401);
        }

        const orderId = positiveInteger(url.pathname.split("/").pop());
        if (!orderId) return json({ ok: false, error: "Invalid order ID" }, 400);

        const order = await env.DB.prepare(`
          SELECT * FROM orders WHERE id = ? LIMIT 1
        `).bind(orderId).first();

        if (!order) return json({ ok: false, error: "Order not found" }, 404);

        const items = await env.DB.prepare(`
          SELECT oi.*, mi.name_en, mi.category, mi.image_url
          FROM order_items oi
          LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
          WHERE oi.order_id = ?
          ORDER BY oi.id
        `).bind(orderId).all();

        return json({ ok: true, order, items: items.results ?? [] });
      }

      // Protected order update
      if (/^\/api\/orders\/\d+$/.test(url.pathname) && request.method === "PATCH") {
        if (!isAuthorized(request, env)) {
          return json({ ok: false, error: "Unauthorized" }, 401);
        }

        const orderId = positiveInteger(url.pathname.split("/").pop());
        if (!orderId) return json({ ok: false, error: "Invalid order ID" }, 400);

        const body = await request.json();
        const allowedFields = [
          "status","payment_status","customer_name","customer_phone","section",
          "table_id","table_no","subtotal","sst_tax","total_amount","decline_reason",
          "order_note","accepted_by_id","accepted_by_name","accepted_by_email",
          "accepted_by_role","accepted_at","declined_by_id","declined_by_name",
          "declined_by_email","declined_by_role","declined_at","cancelled_by_id",
          "cancelled_by_name","cancelled_by_email","cancelled_by_role","cancelled_at",
          "cancel_reason"
        ];

        const updates = [];
        const values = [];

        for (const field of allowedFields) {
          if (Object.prototype.hasOwnProperty.call(body, field)) {
            updates.push(`${field} = ?`);
            values.push(body[field]);
          }
        }

        if (!updates.length) {
          return json({ ok: false, error: "No valid fields supplied" }, 400);
        }

        values.push(orderId);

        const result = await env.DB.prepare(`
          UPDATE orders SET ${updates.join(", ")} WHERE id = ?
        `).bind(...values).run();

        if (!result.meta?.changes) {
          return json({ ok: false, error: "Order not found or not updated" }, 404);
        }

        const order = await env.DB.prepare(`
          SELECT * FROM orders WHERE id = ?
        `).bind(orderId).first();

        return json({ ok: true, order });
      }

      return json({ ok: false, error: "Route not found" }, 404);

    } catch (error) {
      return json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }, 500);
    }
  },
};
