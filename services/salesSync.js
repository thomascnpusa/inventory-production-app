const shopifyIntegration = require('../shopify');
const amazonIntegration = require('../amazon');
const mapping = require('../mapping'); // Add at top
const { Pool } = require('pg');
require('dotenv').config();

// Import AMAZON_MARKETPLACES from the amazon.js module
const { AMAZON_MARKETPLACES } = require('../amazon');

class SalesSyncService {
    constructor() {
        this.pgPool = new Pool({
            user: process.env.PG_USER,
            host: process.env.PG_HOST,
            database: process.env.PG_DATABASE,
            password: process.env.PG_PASSWORD,
            port: process.env.PG_PORT
        });
    }

    

    async syncShopify() {
        console.log('Starting Shopify sync for the last 24 hours...');
        try {
            const client = await this.pgPool.connect();
            try {
                await client.query('BEGIN');

                const hoursBack = 24;
                let totalSuccess = 0;
                let totalFailures = 0;
                
                for (const [storeName] of Object.entries(shopifyIntegration.stores)) {
                    console.log(`Fetching orders from ${storeName} for the last ${hoursBack} hours...`);
                    const daysBack = hoursBack / 24;
                    
                    try {
                        const orders = await shopifyIntegration.fetchOrders(storeName, daysBack);
                        console.log(`Retrieved ${orders.length} orders from ${storeName}`);
                        
                        for (const order of orders) {
                            try {
                                console.log(`Processing individual order ${order.id} from ${storeName}`);
                                await shopifyIntegration.processOrders([order], storeName);
                                totalSuccess++;
                            } catch (orderError) {
                                console.error(`Error processing order ${order.id} from ${storeName}:`, orderError);
                                totalFailures++;
                            }
                        }
                    } catch (storeError) {
                        console.error(`Error fetching orders from ${storeName}:`, storeError);
                    }
                }

                await client.query('COMMIT');
                console.log(`Shopify sync completed: ${totalSuccess} orders processed successfully, ${totalFailures} failures`);

                // Explicitly call and log the SKU mapping step
                console.log('Attempting to set Shopify SKUs as internal...');
                const mappingResult = await mapping.setShopifySkusAsInternal();
                console.log(`Mapping result: ${JSON.stringify(mappingResult)}`);

                return { success: true, processed: totalSuccess, failed: totalFailures };
            } catch (error) {
                await client.query('ROLLBACK');
                console.error('Sync error:', error);
                throw error;
            } finally {
                client.release();
                console.log('Database client released');
            }
        } catch (error) {
            console.error('Shopify sync failed:', error);
            throw error;
        }
    }
    
    async syncAmazon() {
        console.log('Starting Amazon sync for the last hour...');
        try {
            const client = await this.pgPool.connect();
            try {
                await client.query('BEGIN');
                const hoursBack = 1;
                const amazonClient = new amazonIntegration();
                const result = await amazonClient.syncAllMarketplaces(hoursBack);
                for (const marketplace of Object.keys(AMAZON_MARKETPLACES)) {
                    const orders = await amazonClient.fetchOrders(marketplace, hoursBack);
                    for (const order of orders) {
                        for (const item of order.OrderItems) {
                            if (item.SellerSKU) {
                                await client.query(
                                    `INSERT INTO skumapping (platform, platform_sku, product_name, status)
                                     VALUES ($1, $2, $3, $4)
                                     ON CONFLICT (platform, platform_sku) DO NOTHING`,
                                    ['amazon', item.SellerSKU, item.Title, 'unmapped']
                                );
                            }
                        }
                    }
                }
                await client.query('COMMIT');
                await mapping.suggestMappings('amazon'); // Suggest after sync
                console.log('Amazon sync completed successfully');
                return { success: true, message: 'Amazon sync completed successfully' };
            } catch (error) {
                await client.query('ROLLBACK');
                throw error;
            } finally {
                client.release();
            }
        } catch (error) {
            console.error('Amazon sync failed:', error);
            throw error;
        }
    }
    
    async syncAllPlatforms() {
        const startTime = new Date();
        console.log('Starting sales sync at:', startTime);
        try {
            await this.syncShopify();
            await this.syncAmazon();
            await mapping.suggestMappings('shopify');
            
            // Add FBA inventory sync
            console.log('Starting FBA inventory sync...');
            const amazonClient = new amazonIntegration();
            await amazonClient.fetchFBAInventory();
            console.log('FBA inventory sync completed');
            
        } catch (error) {
            console.error('Sales sync failed:', error);
            throw error;
        }
    }

    async allocateInventoryBatches(client, salesOrderItemId, sku, quantity) {
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

        let remainingQuantity = quantity;
        let allocatedQuantity = 0;

        for (const batch of batches.rows) {
            if (remainingQuantity <= 0) break;

            const availableQuantity = Math.min(batch.stock_level, remainingQuantity);
            
            console.log(`Allocating ${availableQuantity} units from batch ${batch.batch_number} for SKU ${sku}`);
            
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

            remainingQuantity -= availableQuantity;
            allocatedQuantity += availableQuantity;
        }

        if (allocatedQuantity < quantity) {
            throw new Error(`Insufficient inventory for SKU ${sku}`);
        }
    }

    async getSyncStatus() {
        try {
            console.log('Getting sync status...');
            const result = await this.pgPool.query(`
                SELECT 
                    platform,
                    COUNT(*) as total_orders,
                    COUNT(DISTINCT customer_id) as total_customers,
                    SUM(total_amount) as total_sales,
                    MIN(order_date) as earliest_order,
                    MAX(order_date) as latest_order
                FROM SalesOrders
                GROUP BY platform
            `);
            return result.rows;
        } catch (error) {
            console.error('Error getting sync status:', error);
            throw error;
        }
    }
}

module.exports = new SalesSyncService(); 