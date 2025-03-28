class ShopifyIntegration {
    constructor() {
        // ... existing code ...
    }

    async processOrders(orders, storeName, options = { skipInvalidSkus: true }) {
        console.log('Processing orders for store:', storeName, 'with options:', options);
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Get all SKUs from inventory with case-sensitive comparison
            const inventorySkus = await client.query('SELECT sku FROM InventoryItems');
            const validSkus = new Set(inventorySkus.rows.map(row => row.sku));
            console.log('Valid SKUs in inventory:', Array.from(validSkus).join(', '));

            // Keep track of missing SKUs we've already handled
            const handledMissingSkus = new Set();

            for (const order of orders) {
                // Log original SKUs for debugging
                console.log(`Order ${order.id} original SKUs:`, order.line_items.map(item => ({
                    sku: item.sku,
                    title: item.title,
                    variant_title: item.variant_title
                })));

                // Check if order already exists
                const existingOrder = await client.query(
                    'SELECT id FROM SalesOrders WHERE platform = $1 AND platform_order_id = $2',
                    ['shopify', order.id.toString()]
                );

                if (existingOrder.rows.length > 0) {
                    console.log(`Order ${order.id} already exists, skipping...`);
                    continue;
                }

                // Insert sales order
                const orderResult = await client.query(
                    `INSERT INTO SalesOrders 
                    (platform, platform_order_id, store_name, order_date, customer_id, total_amount, status)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                    RETURNING id`,
                    [
                        'shopify',
                        order.id.toString(),
                        storeName,
                        order.created_at,
                        order.customer?.id?.toString() || null,
                        parseFloat(order.total_price),
                        order.financial_status
                    ]
                );

                const salesOrderId = orderResult.rows[0].id;
                let skippedItems = 0;

                // Process line items
                for (const item of order.line_items) {
                    if (!item.sku) {
                        console.log(`Skipping item without SKU in order ${order.id}`);
                        skippedItems++;
                        continue;
                    }

                    // Skip P-NVDPROTECTION SKUs
                    if (item.sku.toUpperCase().includes('NVDPROTECTION')) {
                        console.log(`Skipping NVDPROTECTION SKU: ${item.sku}`);
                        skippedItems++;
                        continue;
                    }

                    // Special case for 15002.1 - always map to P-15002
                    let normalizedSku;
                    if (item.sku.trim().toUpperCase() === '15002.1' || item.sku.trim().toUpperCase() === 'P-15002.1') {
                        normalizedSku = 'P-15002';
                        console.log(`Special case: mapping ${item.sku} to ${normalizedSku}`);
                    } else {
                        // Normalize SKU using the normalizeSkuFormat method
                        normalizedSku = this.normalizeSkuFormat(item.sku, storeName);
                    }

                    // Log normalized SKUs for debugging
                    console.log(`Order ${order.id} normalized SKUs:`, [{
                        original: item.sku,
                        normalized: normalizedSku,
                        title: item.title,
                        variant_title: item.variant_title
                    }]);

                    // Test SKU existence and log details
                    console.log('Testing SKU existence:', {
                        original: item.sku,
                        normalized: normalizedSku,
                        title: item.title,
                        variant_title: item.variant_title,
                        exists: validSkus.has(normalizedSku),
                        store: storeName
                    });

                    // Try to find the SKU in inventory
                    if (!validSkus.has(normalizedSku)) {
                        console.log(`SKU ${normalizedSku} not found in inventory for order ${order.id}. Item details:`, {
                            original: item.sku,
                            normalized: normalizedSku,
                            title: item.title,
                            variant_title: item.variant_title,
                            store: storeName
                        });
                        
                        if (options.skipInvalidSkus) {
                            console.log(`Skipping invalid SKU: ${normalizedSku}`);
                            skippedItems++;
                            continue;
                        } else {
                            // Check if we've already handled this missing SKU
                            if (!handledMissingSkus.has(normalizedSku)) {
                                console.log(`Creating placeholder for SKU: ${normalizedSku}`);
                                // Create a placeholder entry in InventoryItems
                                await client.query(
                                    `INSERT INTO InventoryItems 
                                    (sku, name, type, price, reorder_point, reorder_quantity)
                                    VALUES ($1, $2, $3, $4, $5, $6)`,
                                    [
                                        normalizedSku,
                                        `Placeholder for ${item.title} (${item.variant_title || 'No variant'})`,
                                        'finished good',
                                        parseFloat(item.price),
                                        0,
                                        0
                                    ]
                                );
                                handledMissingSkus.add(normalizedSku);
                                validSkus.add(normalizedSku);
                            }
                        }
                    }

                    // Insert sales order item
                    await client.query(
                        `INSERT INTO SalesOrderItems 
                        (sales_order_id, product_sku, quantity, unit_price)
                        VALUES ($1, $2, $3, $4)`,
                        [
                            salesOrderId,
                            normalizedSku,
                            item.quantity,
                            parseFloat(item.price)
                        ]
                    );
                }

                console.log(`Successfully processed order ${order.id}, skipped ${skippedItems} items`);
            }

            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    normalizeSkuFormat(sku, storeName) {
        if (!sku) return null;
        
        // Trim and convert to uppercase
        let normalizedSku = sku.trim().toUpperCase();
        console.log(`Original SKU: ${sku} Store: ${storeName}`);
        console.log(`After trim and uppercase: ${normalizedSku}`);

        // Special case for 15002.1 - always map to P-15002
        if (normalizedSku === '15002.1' || normalizedSku === 'P-15002.1') {
            console.log(`Special case for ${normalizedSku}, mapping to P-15002`);
            return 'P-15002';
        }

        // Handle decimal points in SKUs by removing the decimal portion
        if (normalizedSku.includes('.')) {
            const baseSku = normalizedSku.split('.')[0];
            console.log(`SKU with decimal point detected: ${normalizedSku}, using base SKU: ${baseSku}`);
            normalizedSku = baseSku;
        }

        // Add P- prefix for CNPPet store or CNPUSA store
        if ((storeName === 'CNPPet' || storeName === 'CNPUSA') && !normalizedSku.startsWith('P-')) {
            console.log(`Adding P- prefix to SKU: ${normalizedSku} -> P-${normalizedSku}`);
            normalizedSku = `P-${normalizedSku}`;
        }

        // Check if it's a glass variant
        const isGlassVariant = normalizedSku.endsWith('-G');
        console.log(`Is glass variant: ${isGlassVariant}`);

        // Handle glass variants
        if (!isGlassVariant && normalizedSku.includes('GLASS')) {
            console.log(`Adding -G suffix for glass variant: ${normalizedSku} -> ${normalizedSku}-G`);
            normalizedSku = `${normalizedSku}-G`;
        }

        console.log(`Final normalized SKU: ${normalizedSku}`);
        return normalizedSku;
    }
} 