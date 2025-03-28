const Shopify = require('shopify-api-node');
const { Pool } = require('pg');
const skuMapping = require('./mapping');
const moment = require('moment');
require('dotenv').config();

// Shopify store configurations
const SHOPIFY_STORES = {
    'CNPPet': {
        shopName: 'complete-natural-products.myshopify.com',
        accessToken: process.env.SHOPIFY_PET_ACCESS_TOKEN
    },
    'CNPUSA': {
        shopName: 'cnpusa.myshopify.com',
        accessToken: process.env.SHOPIFY_USA_ACCESS_TOKEN
    },
    'Wholesale': {
        shopName: 'cnpusa-wholesale.myshopify.com',
        accessToken: process.env.SHOPIFY_WHOLESALE_ACCESS_TOKEN
    }
};

// Database connection
const pgPool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT
});

class ShopifyIntegration {
    constructor() {
        this.stores = {};
        this.initializeStores();
    }

    initializeStores() {
        for (const [storeName, config] of Object.entries(SHOPIFY_STORES)) {
            this.stores[storeName] = new Shopify({
                shopName: config.shopName,
                accessToken: config.accessToken,
                apiVersion: '2024-01'
            });
        }
    }

    async fetchOrders(storeName, hoursBack = 1) { // Default to 1 hour
        const store = this.stores[storeName];
        if (!store) throw new Error(`Store ${storeName} not found`);

        console.log(`Fetching Shopify orders from ${storeName} for the last ${hoursBack} hour(s)...`);

        const endDate = moment().utc();
        const startDate = moment(endDate).subtract(hoursBack, 'hours');
        const created_at_min = startDate.format('YYYY-MM-DD[T]HH:mm:ss[Z]');
        const created_at_max = endDate.format('YYYY-MM-DD[T]HH:mm:ss[Z]');

        console.log(`Date range: ${created_at_min} to ${created_at_max}`);

        const query = `
            query {
                orders(first: 250, query: "updated_at:>=${created_at_min} updated_at:<=${created_at_max}") {
                    edges {
                        node {
                            id
                            name
                            createdAt
                            customer {
                                id
                                email
                                firstName
                                lastName
                            }
                            totalPriceSet {
                                shopMoney {
                                    amount
                                    currencyCode
                                }
                            }
                            lineItems(first: 50) {
                                edges {
                                    node {
                                        id
                                        quantity
                                        sku
                                        title
                                        variant {
                                            id
                                            sku
                                            title
                                            price
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        `;

        try {
            const response = await store.graphql(query);
            console.log('Raw GraphQL response:', JSON.stringify(response, null, 2)); // Debug log

            const orders = response.orders.edges.map(edge => {
                const order = edge.node;
                return {
                    id: order.name,
                    created_at: order.createdAt,
                    customer: order.customer,
                    total_price: order.totalPriceSet.shopMoney.amount,
                    currency: order.totalPriceSet.shopMoney.currencyCode,
                    line_items: order.lineItems.edges.map(item => ({
                        id: item.node.id,
                        quantity: item.node.quantity,
                        sku: item.node.sku || item.node.variant?.sku,
                        title: item.node.title,
                        variant_title: item.node.variant?.title,
                        price: item.node.variant?.price
                    }))
                };
            });

            console.log(`Retrieved ${orders.length} orders from ${storeName}`);
            if (orders.length > 0) {
                console.log('First order details:', JSON.stringify(orders[0], null, 2));
            }
            return orders;
        } catch (error) {
            console.error(`Error fetching orders from ${storeName}:`, error);
            throw error;
        }
    }

    normalizeSkuFormat(sku, storeName) {
        if (!sku) return null;
        let normalizedSku = sku.trim().toUpperCase();
        console.log(`Original SKU: ${sku} Store: ${storeName}`);
        
        if (normalizedSku === '15002.1' || normalizedSku === 'P-15002.1') {
            console.log(`Special case for ${normalizedSku}, mapping to P-15002`);
            return 'P-15002';
        }

        if (normalizedSku.includes('.')) {
            const baseSku = normalizedSku.split('.')[0];
            console.log(`SKU with decimal point detected: ${normalizedSku}, using base SKU: ${baseSku}`);
            normalizedSku = baseSku;
        }

        if ((storeName === 'CNPPet' || storeName === 'CNPUSA') && !normalizedSku.startsWith('P-')) {
            console.log(`Adding P- prefix to SKU: ${normalizedSku} -> P-${normalizedSku}`);
            normalizedSku = `P-${normalizedSku}`;
        }

        const isGlassVariant = normalizedSku.endsWith('-G');
        if (!isGlassVariant && normalizedSku.includes('GLASS')) {
            console.log(`Adding -G suffix for glass variant: ${normalizedSku} -> ${normalizedSku}-G`);
            normalizedSku = `${normalizedSku}-G`;
        }

        console.log(`Final normalized SKU: ${normalizedSku}`);
        return normalizedSku;
    }

    async processOrders(orders, storeName, options = { skipInvalidSkus: true }) {
        console.log('Processing orders for store:', storeName);
        const client = await pgPool.connect();
        try {
            await client.query('BEGIN');

            const uniqueSkus = new Set();
            const productNames = {};
            
            for (const order of orders) {
                if (order.line_items && order.line_items.length > 0) {
                    for (const item of order.line_items) {
                        if (item.sku && !item.sku.toUpperCase().includes('NVDPROTECTION')) {
                            uniqueSkus.add(item.sku);
                            let productName = item.title;
                            if (item.variant_title && item.variant_title !== 'Default Title') {
                                productName += ` - ${item.variant_title}`;
                            }
                            productNames[item.sku] = productName;
                        }
                    }
                }
            }

            if (uniqueSkus.size > 0) {
                console.log(`Found ${uniqueSkus.size} unique Shopify SKUs to add to mapping table`);
                const result = await skuMapping.batchAddToMappingTable(Array.from(uniqueSkus), 'shopify', productNames);
                console.log(`Batch add result: ${JSON.stringify(result)}`);
            }

            for (const order of orders) {
                let orderProcessed = false;
                let salesOrderId = null;
                let skippedItems = 0;

                try {
                    const existingOrder = await client.query(
                        'SELECT id FROM SalesOrders WHERE platform = $1 AND platform_order_id = $2',
                        ['shopify', order.id.toString()]
                    );

                    if (existingOrder.rows.length > 0) {
                        console.log(`Order ${order.id} already exists, skipping...`);
                        continue;
                    }

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
                            order.financial_status || 'pending'
                        ]
                    );

                    salesOrderId = orderResult.rows[0].id;

                    for (const item of order.line_items) {
                        if (!item.sku) {
                            console.log(`Skipping item without SKU in order ${order.id}`);
                            skippedItems++;
                            continue;
                        }
                        if (item.sku.toUpperCase().includes('NVDPROTECTION')) {
                            console.log(`Skipping NVDPROTECTION SKU: ${item.sku}`);
                            skippedItems++;
                            continue;
                        }
                        let internalSku = await skuMapping.getInternalSku(item.sku, 'shopify') || this.normalizeSkuFormat(item.sku, storeName);
                        try {
                            await client.query(
                                `INSERT INTO SalesOrderItems 
                                (sales_order_id, product_sku, original_platform_sku, quantity, unit_price)
                                VALUES ($1, $2, $3, $4, $5)`,
                                [salesOrderId, internalSku, item.sku, item.quantity, parseFloat(item.price)]
                            );

                            // Get the ID of the inserted sales order item
                            const salesOrderItemResult = await client.query(
                                `SELECT id FROM SalesOrderItems 
                                WHERE sales_order_id = $1 AND product_sku = $2`,
                                [salesOrderId, internalSku]
                            );
                            const salesOrderItemId = salesOrderItemResult.rows[0].id;

                            // Allocate inventory for this order item
                            await this.allocateInventoryBatches(client, salesOrderItemId, internalSku, item.quantity);
                        } catch (itemError) {
                            console.error(`Error processing item ${item.sku} in order ${order.id}:`, itemError);
                            if (itemError.code === '23503' && options.skipInvalidSkus) {
                                console.log(`Skipping invalid SKU: ${internalSku}`);
                                skippedItems++;
                                continue;
                            }
                            throw itemError;
                        }
                    }

                    console.log(`Successfully processed order ${order.id}, skipped ${skippedItems} items`);
                    orderProcessed = true;
                } catch (orderError) {
                    console.error(`Error processing order ${order.id}:`, orderError);
                    if (salesOrderId && !orderProcessed) {
                        try {
                            // First delete sales-inventory mappings
                            await client.query('DELETE FROM SalesInventoryMapping WHERE sales_order_item_id IN (SELECT id FROM SalesOrderItems WHERE sales_order_id = $1)', [salesOrderId]);
                            // Then delete sales order items
                            await client.query('DELETE FROM SalesOrderItems WHERE sales_order_id = $1', [salesOrderId]);
                            // Finally delete the sales order
                            await client.query('DELETE FROM SalesOrders WHERE id = $1', [salesOrderId]);
                        } catch (cleanupError) {
                            console.error(`Error cleaning up after failed order ${order.id}:`, cleanupError);
                        }
                    }
                    throw orderError; // Re-throw to trigger rollback
                }
            }

            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Transaction error:', error);
            throw error;
        } finally {
            client.release();
        }
    }

    async allocateInventoryBatches(client, salesOrderItemId, sku, quantity) {
        console.log(`Attempting to allocate ${quantity} units of ${sku} for order item ${salesOrderItemId}`);
        
        // Get available inventory batches for the SKU
        const batches = await client.query(
            `SELECT ib.id, ib.inventory_item_id, ib.batch_number, ib.stock_level 
            FROM InventoryBatches ib
            JOIN InventoryItems ii ON ib.inventory_item_id = ii.id
            WHERE ii.sku = $1 AND ib.stock_level > 0 
            ORDER BY ib.created_at ASC`,
            [sku]
        );

        console.log(`Found ${batches.rows.length} inventory batches for SKU ${sku}`);
        console.log(`Batch details: ${JSON.stringify(batches.rows)}`);

        let remainingQuantity = quantity;
        let allocatedQuantity = 0;

        for (const batch of batches.rows) {
            if (remainingQuantity <= 0) break;

            const availableQuantity = Math.min(batch.stock_level, remainingQuantity);
            
            console.log(`Allocating ${availableQuantity} units from batch ${batch.batch_number} (ID: ${batch.id}) for SKU ${sku} (order quantity: ${quantity})`);
            
            try {
                // Insert sales-inventory mapping
                await client.query(
                    `INSERT INTO SalesInventoryMapping 
                    (sales_order_item_id, inventory_batch_number, quantity)
                    VALUES ($1, $2, $3)`,
                    [salesOrderItemId, batch.batch_number, availableQuantity]
                );

                // Update inventory stock level - fix by adding inventory_item_id to WHERE clause
                await client.query(
                    `UPDATE InventoryBatches 
                    SET stock_level = stock_level - $1 
                    WHERE batch_number = $2 AND inventory_item_id = $3`,
                    [availableQuantity, batch.batch_number, batch.inventory_item_id]
                );

                console.log(`Successfully updated inventory for batch ${batch.batch_number} (ID: ${batch.id})`);
                
                remainingQuantity -= availableQuantity;
                allocatedQuantity += availableQuantity;
            } catch (error) {
                console.error(`Error allocating inventory: ${error.message}`);
                throw error;
            }
        }

        if (allocatedQuantity < quantity) {
            console.error(`Insufficient inventory for SKU ${sku}: needed ${quantity}, allocated ${allocatedQuantity}`);
            throw new Error(`Insufficient inventory for SKU ${sku}`);
        }
        
        console.log(`Successfully allocated ${allocatedQuantity} units of ${sku}`);
    }
}

module.exports = new ShopifyIntegration();