const { Pool } = require('pg');
const axios = require('axios');
const skuMapping = require('./mapping'); // Add at top
const moment = require('moment');
const fs = require('fs');
require('dotenv').config();

// Amazon marketplace configurations
const AMAZON_MARKETPLACES = {
    'US': {
        region: 'NA',
        marketplaceId: process.env.AMAZON_US_MARKETPLACE_ID || 'ATVPDKIKX0DER',
        endpoint: 'https://sellingpartnerapi-na.amazon.com'
    },
    'CA': { region: 'NA', marketplaceId: 'A2EUQ1WTGCTBG2', endpoint: 'https://sellingpartnerapi-na.amazon.com' },
    'MX': { region: 'NA', marketplaceId: 'A1AM78C64UM0Y8', endpoint: 'https://sellingpartnerapi-na.amazon.com' },
    'BR': { region: 'NA', marketplaceId: 'A2Q3Y263D00KWC', endpoint: 'https://sellingpartnerapi-na.amazon.com' }
};

// Database connection
const pgPool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT
});

// File logging setup
const logStream = fs.createWriteStream('amazon_sync.log', { flags: 'a' });

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

class AmazonAPI {
    constructor() {
        this.refreshToken = process.env.AMAZON_REFRESH_TOKEN;
        this.clientId = process.env.AMAZON_CLIENT_ID;
        this.clientSecret = process.env.AMAZON_CLIENT_SECRET;
        this.accessToken = null;
        this.tokenExpiration = null;
        this.orderApiDelay = 2000; // 0.5 req/sec base throttle
        this.orderItemsApiDelay = 2000; // 0.5 req/sec base throttle
        this.lastApiCall = 0;
        this.maxRetries = 5;
    }

    async refreshAccessToken() {
        try {
            console.log('Refreshing Amazon API access token...');
            const response = await axios.post('https://api.amazon.com/auth/o2/token', {
                grant_type: 'refresh_token',
                refresh_token: this.refreshToken,
                client_id: this.clientId,
                client_secret: this.clientSecret
            });
            this.accessToken = response.data.access_token;
            this.tokenExpiration = Date.now() + (response.data.expires_in * 1000);
            console.log('Amazon access token refreshed successfully');
            return this.accessToken;
        } catch (error) {
            console.error('Error refreshing Amazon access token:', error);
            throw error;
        }
    }

    async getAccessToken() {
        if (!this.accessToken || Date.now() >= this.tokenExpiration) {
            await this.refreshAccessToken();
        }
        return this.accessToken;
    }

    async throttleApiCall(minDelay) {
        const now = Date.now();
        const timeSinceLastCall = now - this.lastApiCall;
        if (timeSinceLastCall < minDelay) {
            const waitTime = minDelay - timeSinceLastCall;
            console.log(`Throttling API call, waiting ${waitTime}ms...`);
            await delay(waitTime);
        }
        this.lastApiCall = Date.now();
    }

    async handleRateLimit(error, retryCount) {
        if (error?.response?.status === 429) {
            const retryAfterHeader = parseInt(error.response.headers['retry-after'] || '2', 10);
            const baseDelay = Math.max(retryAfterHeader * 1000, 2000);
            const exponentialDelay = baseDelay * Math.pow(2, retryCount);
            const retryAfter = Math.min(exponentialDelay, 30000);
            console.log(`429 Rate Limit. Retry ${retryCount + 1}/${this.maxRetries} after ${retryAfter}ms`);
            await delay(retryAfter);
            return true;
        }
        return false;
    }

    async fetchOrders(marketplace, hoursBack) {
        const marketplaceConfig = AMAZON_MARKETPLACES[marketplace];
        if (!marketplaceConfig) throw new Error(`Marketplace ${marketplace} not configured`);

        const accessToken = await this.getAccessToken();
        const endDate = moment().utc().subtract(2, 'minutes').format('YYYY-MM-DDTHH:mm:ss[Z]'); // 2 minutes before now
        const startDate = moment(endDate).subtract(hoursBack, 'hours').format('YYYY-MM-DDTHH:mm:ss[Z]');

        console.log(`Fetching Amazon orders from ${marketplace} between ${startDate} and ${endDate}...`);
        console.log(`Marketplace ID: ${marketplaceConfig.marketplaceId}`);

        const endpoint = `${marketplaceConfig.endpoint}/orders/v0/orders`;
        const orders = [];
        let nextToken = null;

        do {
            await this.throttleApiCall(this.orderApiDelay);
            const params = {
                MarketplaceIds: marketplaceConfig.marketplaceId,
                CreatedAfter: startDate,
                CreatedBefore: endDate,
                MaxResultsPerPage: 100
            };
            if (nextToken) params.NextToken = nextToken;

            console.log(`Request params: ${JSON.stringify(params)}`);

            let response;
            let retryCount = 0;

            while (retryCount <= this.maxRetries) {
                try {
                    response = await axios.get(endpoint, {
                        headers: {
                            'x-amz-access-token': accessToken,
                            'Content-Type': 'application/json'
                        },
                        params
                    });
                    console.log(`Response status: ${response.status}`);
                    break;
                } catch (error) {
                    const errorDetails = {
                        status: error.response?.status,
                        statusText: error.response?.statusText,
                        data: error.response?.data,
                        message: error.message
                    };
                    console.log(`Error fetching orders from ${marketplace}: ${JSON.stringify(errorDetails)}`);
                    if (await this.handleRateLimit(error, retryCount)) {
                        retryCount++;
                        continue;
                    }
                    throw error;
                }
            }

            const fetchedOrders = response.data.payload.Orders || [];
            console.log(`Fetched ${fetchedOrders.length} orders from ${marketplace}`);
            
            for (const order of fetchedOrders) {
                await this.throttleApiCall(this.orderItemsApiDelay);
                let itemsResponse;
                retryCount = 0;

                while (retryCount <= this.maxRetries) {
                    try {
                        itemsResponse = await axios.get(
                            `${marketplaceConfig.endpoint}/orders/v0/orders/${order.AmazonOrderId}/orderItems`,
                            {
                                headers: {
                                    'x-amz-access-token': accessToken,
                                    'Content-Type': 'application/json'
                                }
                            }
                        );
                        break;
                    } catch (error) {
                        const errorDetails = {
                            status: error.response?.status,
                            data: error.response?.data,
                            message: error.message
                        };
                        console.log(`Error fetching items for order ${order.AmazonOrderId}: ${JSON.stringify(errorDetails)}`);
                        if (await this.handleRateLimit(error, retryCount)) {
                            retryCount++;
                            continue;
                        }
                        order.OrderItems = [];
                        break;
                    }
                }
                order.OrderItems = itemsResponse?.data.payload.OrderItems || [];
                orders.push(order);
            }

            nextToken = response.data.payload.NextToken;
            console.log(`Fetched ${orders.length} orders so far from ${marketplace}`);
        } while (nextToken);

        if (orders.length > 0) {
            console.log('First order SKUs: ' + orders[0].OrderItems.map(item => item.SellerSKU).filter(Boolean).join(', '));
        }
        console.log(`Completed fetching ${orders.length} orders from ${marketplace}`);
        return orders;
    }

    normalizeSkuFormat(sku, marketplace) {
        if (!sku) return null;
        let normalizedSku = sku.trim().toUpperCase();
        console.log(`Original SKU: ${sku} Marketplace: ${marketplace}`);

        if (normalizedSku === '15002.1' || normalizedSku === 'P-15002.1') {
            console.log(`Special case for ${normalizedSku}, mapping to P-15002`);
            return 'P-15002';
        }

        if (normalizedSku.includes('.')) {
            const baseSku = normalizedSku.split('.')[0];
            console.log(`SKU with decimal point detected: ${normalizedSku}, using base SKU: ${baseSku}`);
            normalizedSku = baseSku;
        }

        if (!normalizedSku.startsWith('P-')) {
            console.log(`Adding P- prefix to SKU: ${normalizedSku} -> P-${normalizedSku}`);
            normalizedSku = `P-${normalizedSku}`;
        }

        if (normalizedSku.includes('GLASS') && !normalizedSku.endsWith('-G')) {
            console.log(`Adding -G suffix for glass variant: ${normalizedSku} -> ${normalizedSku}-G`);
            normalizedSku = `${normalizedSku}-G`;
        }

        console.log(`Final normalized SKU: ${normalizedSku}`);
        return normalizedSku;
    }

    async processOrders(orders, marketplace, options = { skipInvalidSkus: true }) {
        console.log(`Processing ${orders.length} orders for Amazon marketplace: ${marketplace}`);
        const client = await pgPool.connect();
        try {
            await client.query('BEGIN');

            const inventoryResult = await client.query('SELECT sku FROM InventoryItems');
            const validSkus = new Set(inventoryResult.rows.map(row => row.sku));
            console.log(`Loaded ${validSkus.size} existing SKUs from inventory`);

            for (const order of orders) {
                let salesOrderId = null;
                let skippedItems = 0;

                try {
                    const existingOrder = await client.query(
                        'SELECT id FROM SalesOrders WHERE platform = $1 AND platform_order_id = $2',
                        ['amazon', order.AmazonOrderId]
                    );
                    if (existingOrder.rows.length > 0) {
                        console.log(`Order ${order.AmazonOrderId} already exists, skipping...`);
                        continue;
                    }

                    const orderResult = await client.query(
                        `INSERT INTO SalesOrders 
                        (platform, platform_order_id, store_name, order_date, customer_id, total_amount, status)
                        VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
                        [
                            'amazon',
                            order.AmazonOrderId,
                            `Amazon ${marketplace}`,
                            order.PurchaseDate,
                            order.BuyerInfo?.BuyerEmail || null,
                            parseFloat(order.OrderTotal?.Amount || 0),
                            order.OrderStatus
                        ]
                    );
                    salesOrderId = orderResult.rows[0].id;

                    for (const item of order.OrderItems) {
                        if (!item.SellerSKU) {
                            console.log(`Skipping item without SKU in order ${order.AmazonOrderId}`);
                            skippedItems++;
                            continue;
                        }
                        let internalSku = await skuMapping.getInternalSku(item.SellerSKU, 'amazon') || this.normalizeSkuFormat(item.SellerSKU, marketplace);
                        if (!validSkus.has(internalSku)) {
                            console.log(`SKU ${internalSku} not found in inventory, adding...`);
                            try {
                                const quantity = parseInt(item.QuantityOrdered) || 1;
                                const totalPrice = parseFloat(item.ItemPrice?.Amount || 0);
                                const unitPrice = quantity > 0 ? totalPrice / quantity : totalPrice;
                                await client.query(
                                    `INSERT INTO InventoryItems 
                                    (sku, name, type, stock_level, minimum_quantity, unit_type)
                                    VALUES ($1, $2, $3, $4, $5, $6)`,
                                    [internalSku, item.Title || `Amazon Product (${marketplace})`, 'finished good', 0, 0, 'units']
                                );
                                validSkus.add(internalSku);
                                console.log(`Added SKU ${internalSku} to inventory`);
                            } catch (createError) {
                                console.error(`Error adding SKU ${internalSku} to inventory:`, createError);
                                if (options.skipInvalidSkus) {
                                    console.log(`Skipping SKU ${internalSku} due to inventory add error`);
                                    skippedItems++;
                                    continue;
                                }
                                throw createError;
                            }
                        }
                        try {
                            // Define unit price from item price or default to 0
                            const totalPrice = parseFloat(item.ItemPrice?.Amount || 0);
                            const quantity = parseInt(item.QuantityOrdered) || 1;
                            const unitPrice = quantity > 0 ? totalPrice / quantity : totalPrice;
                            
                            await client.query(
                                `INSERT INTO SalesOrderItems 
                                (sales_order_id, product_sku, original_platform_sku, quantity, unit_price)
                                VALUES ($1, $2, $3, $4, $5)`,
                                [salesOrderId, internalSku, item.SellerSKU, quantity, unitPrice]
                            );

                            // Get the ID of the inserted sales order item
                            const salesOrderItemResult = await client.query(
                                `SELECT id FROM SalesOrderItems 
                                WHERE sales_order_id = $1 AND product_sku = $2`,
                                [salesOrderId, internalSku]
                            );
                            const salesOrderItemId = salesOrderItemResult.rows[0].id;

                            // Allocate inventory for this order item
                            await this.allocateInventoryBatches(client, salesOrderItemId, internalSku, quantity);
                        } catch (itemError) {
                            if (itemError.code === '23503' && options.skipInvalidSkus) {
                                console.log(`Skipping invalid SKU: ${internalSku}`);
                                skippedItems++;
                                continue;
                            }
                            throw itemError;
                        }
                    }
                    console.log(`Successfully processed order ${order.AmazonOrderId}, skipped ${skippedItems} items`);
                } catch (orderError) {
                    console.error(`Error processing order ${order.AmazonOrderId}:`, orderError);
                    if (salesOrderId) {
                        await client.query('DELETE FROM SalesOrderItems WHERE sales_order_id = $1', [salesOrderId]);
                        await client.query('DELETE FROM SalesOrders WHERE id = $1', [salesOrderId]);
                    }
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

    async syncAllMarketplaces(hoursBack = 1) {
        console.log(`Starting Amazon sync for the last ${hoursBack} hour(s)...`);
        const results = { success: [], failed: [] };
        
        for (const marketplace of Object.keys(AMAZON_MARKETPLACES)) {
            try {
                console.log(`Syncing Amazon ${marketplace} marketplace for the last ${hoursBack} hour...`);
                const orders = await this.fetchOrders(marketplace, hoursBack);
                await this.processOrders(orders, marketplace);
                results.success.push(marketplace);
            } catch (error) {
                console.error(`Error syncing Amazon ${marketplace}:`, error);
                results.failed.push({ marketplace, error: error.message });
            }
        }
        
        console.log('Amazon sync completed with results:', results);
        return results;
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

    async fetchFBAInventory() {
        try {
            console.log('Starting FBA inventory sync');
            const accessToken = await this.getAccessToken();
            const client = await pgPool.connect();
            
            try {
                // Get all SKU mappings for Amazon
                const mappingsResult = await client.query(
                    `SELECT internal_sku, platform_sku 
                    FROM SkuMapping
                    WHERE platform = 'amazon' 
                    AND confidence = 1`
                );
                
                if (mappingsResult.rows.length === 0) {
                    console.log('No SKU mappings found for Amazon');
                    return { success: false, message: 'No SKU mappings found' };
                }
                
                console.log(`Found ${mappingsResult.rows.length} SKU mappings for Amazon`);
                
                // Process in batches of 50 SKUs
                const batchSize = 50;
                const batches = [];
                for (let i = 0; i < mappingsResult.rows.length; i += batchSize) {
                    batches.push(mappingsResult.rows.slice(i, i + batchSize));
                }
                
                console.log(`Processing ${batches.length} batches of SKUs`);
                
                let totalUpdated = 0;
                let totalSkipped = 0;
                
                // Process each batch
                for (const batch of batches) {
                    // We'll only check the US marketplace since that's where our FBA inventory is
                    const marketplaceConfig = AMAZON_MARKETPLACES['US'];
                    console.log(`Fetching FBA inventory for US marketplace - Batch of ${batch.length} SKUs`);
                    
                    try {
                        // Get inventory summary first
                        const endpoint = `${marketplaceConfig.endpoint}/fba/inventory/v1/summaries`;
                        const response = await axios.get(endpoint, {
                            headers: {
                                'x-amz-access-token': accessToken,
                                'Content-Type': 'application/json'
                            },
                            params: {
                                marketplaceIds: marketplaceConfig.marketplaceId,
                                sellerSkus: batch.map(m => m.platform_sku).join(','),
                                granularityType: 'Marketplace',
                                granularityId: marketplaceConfig.marketplaceId
                            },
                            paramsSerializer: params => {
                                return Object.entries(params)
                                    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
                                    .join('&');
                            }
                        });
                        
                        console.log(`Retrieved FBA inventory data for US - Batch of ${batch.length} SKUs`);
                        
                        // Process inventory data
                        const inventoryItems = response.data?.payload?.inventorySummaries || [];
                        
                        for (const mapping of batch) {
                            const item = inventoryItems.find(item => item.sellerSku === mapping.platform_sku);
                            
                            let fbaInventory = 0;
                            let fbaAvailable = 0;
                            let fbaInbound = 0;
                            let fbaReserved = 0;
                            let fbaUnfulfillable = 0;
                            let asin = null;
                            let condition = null;
                            let productName = null;
                            
                            if (item) {
                                // Item found in API response, parse inventory metrics
                                fbaInventory = parseInt(item.totalQuantity || 0);
                                fbaAvailable = fbaInventory; // Assume available = total for summaries endpoint
                                asin = item.asin || null;
                                condition = item.condition || null;
                                productName = item.productName || null;
                                
                                console.log(`Found FBA inventory for ${mapping.internal_sku} (${mapping.platform_sku}):`, {
                                    Total: fbaInventory,
                                    Available: fbaAvailable,
                                    ASIN: asin
                                });
                                totalUpdated++;
                            } else {
                                // Item not found in API response for this batch
                                console.log(`No inventory found via API for Amazon SKU ${mapping.platform_sku} (Internal: ${mapping.internal_sku}). Setting FBA fields to 0.`);
                                // FBA fields remain 0 as initialized above
                                totalSkipped++; // Or maybe rename this counter? This is an update, just to zero.
                            }
                            
                            // Log values just before DB update
                            console.log(`DB UPDATE PREP for ${mapping.internal_sku}: Setting fba_inventory=${fbaInventory}, fba_available=${fbaAvailable}`);
                            
                            // Update the database regardless of whether the item was found in the API response
                            await client.query(
                                `UPDATE InventoryItems 
                                SET fba_inventory = $1, 
                                    fba_available = $2,
                                    fba_inbound = $3,
                                    fba_reserved = $4,
                                    fba_unfulfillable = $5,
                                    fba_asin = $6,
                                    fba_condition = $7,
                                    fba_product_name = $8,
                                    last_fba_update = CURRENT_TIMESTAMP 
                                WHERE sku = $9`,
                                [
                                    fbaInventory, 
                                    fbaAvailable,
                                    fbaInbound, // Still 0 based on summaries endpoint limitations
                                    fbaReserved, // Still 0 based on summaries endpoint limitations
                                    fbaUnfulfillable, // Still 0 based on summaries endpoint limitations
                                    asin,
                                    condition,
                                    productName,
                                    mapping.internal_sku
                                ]
                            );
                        }
                        
                        // Add a small delay to avoid rate limiting
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        
                    } catch (error) {
                        console.error(`Error fetching FBA inventory for batch:`, error.message);
                        console.error('Error response:', error.response?.data);
                        // Continue with next batch even if this one failed
                        continue;
                    }
                }
                
                console.log(`FBA inventory sync complete. Updated: ${totalUpdated}, Skipped: ${totalSkipped}`);
                return { success: true, updated: totalUpdated, skipped: totalSkipped };
                
            } finally {
                client.release();
            }
        } catch (error) {
            console.error('Error in fetchFBAInventory:', error);
            return { success: false, error: error.message };
        }
    }

    async updateSingleFbaInventory(internalSku, amazonSku) {
        try {
            console.log(`Updating FBA inventory for internal SKU ${internalSku} with Amazon SKU ${amazonSku}`);
            const accessToken = await this.getAccessToken();
            const client = await pgPool.connect();
            
            try {
                // We'll only check the US marketplace since that's where our FBA inventory is
                const marketplaceConfig = AMAZON_MARKETPLACES['US'];
                console.log(`Fetching FBA inventory for US marketplace`);
                
                try {
                    // Get inventory summary first
                    const endpoint = `${marketplaceConfig.endpoint}/fba/inventory/v1/summaries`;
                    const response = await axios.get(endpoint, {
                        headers: {
                            'x-amz-access-token': accessToken,
                            'Content-Type': 'application/json'
                        },
                        params: {
                            marketplaceIds: marketplaceConfig.marketplaceId,
                            sellerSkus: amazonSku,
                            granularityType: 'Marketplace',
                            granularityId: marketplaceConfig.marketplaceId
                        },
                        paramsSerializer: params => {
                            return Object.entries(params)
                                .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
                                .join('&');
                        }
                    });
                    
                    console.log(`Retrieved FBA inventory data for US`);
                    console.log('Raw response:', JSON.stringify(response.data, null, 2));
                    
                    // Process inventory data
                    const inventoryItems = response.data?.payload?.inventorySummaries || [];
                    const item = inventoryItems.find(item => item.sellerSku === amazonSku);
                    
                    if (!item) {
                        console.log(`No inventory found for SKU ${amazonSku}`);
                        return { success: false, message: 'No FBA inventory found for this SKU' };
                    }
                    
                    // Parse inventory metrics
                    const fbaInventory = parseInt(item.totalQuantity || 0);
                    const fbaAvailable = fbaInventory; // Set available to total quantity since we don't have detailed breakdown
                    const fbaInbound = 0; // Not available in summaries endpoint
                    const fbaReserved = 0; // Not available in summaries endpoint
                    const fbaUnfulfillable = 0; // Not available in summaries endpoint
                    
                    console.log(`Updating FBA inventory for ${internalSku} (${amazonSku}):`, {
                        Total: fbaInventory,
                        Available: fbaAvailable,
                        Inbound: fbaInbound,
                        Reserved: fbaReserved,
                        Unfulfillable: fbaUnfulfillable
                    });
                    
                    // Update the database
                    await client.query(
                        `UPDATE InventoryItems 
                        SET fba_inventory = $1, 
                            fba_available = $2,
                            fba_inbound = $3,
                            fba_reserved = $4,
                            fba_unfulfillable = $5,
                            fba_asin = $6,
                            fba_condition = $7,
                            fba_product_name = $8,
                            last_fba_update = CURRENT_TIMESTAMP 
                        WHERE sku = $9`,
                        [
                            fbaInventory, 
                            fbaAvailable,
                            fbaInbound,
                            fbaReserved,
                            fbaUnfulfillable,
                            item.asin || null,
                            item.condition || null,
                            item.productName || null,
                            internalSku
                        ]
                    );
                    
                    return { 
                        success: true, 
                        fbaInventory,
                        fbaAvailable,
                        fbaInbound,
                        fbaReserved,
                        fbaUnfulfillable
                    };
                } catch (error) {
                    console.error(`Error fetching FBA inventory:`, error.message);
                    console.error('Error response:', error.response?.data);
                    return { success: false, error: error.message };
                }
            } finally {
                client.release();
            }
        } catch (error) {
            console.error('Error updating single FBA inventory:', error);
            return { success: false, error: error.message };
        }
    }
}

// Export the AmazonAPI class and a singleton instance
module.exports = AmazonAPI;
// Create a singleton instance
const amazonInstance = new AmazonAPI();
// Export the singleton instance
module.exports.amazonInstance = amazonInstance;
// Export the AMAZON_MARKETPLACES constant
module.exports.AMAZON_MARKETPLACES = AMAZON_MARKETPLACES;