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

class AmazonIntegration {
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
}

module.exports = new AmazonIntegration();
module.exports.AMAZON_MARKETPLACES = AMAZON_MARKETPLACES;