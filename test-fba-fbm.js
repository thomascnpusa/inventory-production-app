const AmazonAPI = require('./amazon').amazonInstance;

// Generate unique order IDs
const timestamp = Date.now();
const FBA_ORDER_ID = `TEST-FBA-${timestamp}`;
const FBM_ORDER_ID = `TEST-FBM-${timestamp}`;

// Mock order data
const mockFBAOrder = {
    AmazonOrderId: FBA_ORDER_ID,
    OrderStatus: 'Shipped',
    FulfillmentChannel: 'AFN', // Amazon Fulfilled Network = FBA
    PurchaseDate: new Date().toISOString(),
    OrderTotal: { Amount: '29.99' },
    BuyerInfo: { BuyerEmail: 'test@example.com' },
    OrderItems: [
        {
            SellerSKU: '15013',
            QuantityOrdered: '1',
            ItemPrice: { Amount: '29.99' },
            Title: 'Test FBA Product'
        }
    ]
};

const mockFBMOrder = {
    AmazonOrderId: FBM_ORDER_ID,
    OrderStatus: 'Shipped',
    FulfillmentChannel: 'MFN', // Merchant Fulfilled Network = FBM
    PurchaseDate: new Date().toISOString(),
    OrderTotal: { Amount: '19.99' },
    BuyerInfo: { BuyerEmail: 'test@example.com' },
    OrderItems: [
        {
            SellerSKU: '15008',
            QuantityOrdered: '1',
            ItemPrice: { Amount: '19.99' },
            Title: 'Test FBM Product'
        }
    ]
};

async function runTest() {
    try {
        console.log('Testing FBA Order Processing...');
        await AmazonAPI.processOrders([mockFBAOrder], 'US');
        console.log('FBA order processed successfully');

        console.log('\nTesting FBM Order Processing...');
        await AmazonAPI.processOrders([mockFBMOrder], 'US');
        console.log('FBM order processed successfully');

        // Verify the results
        const { Pool } = require('pg');
        const pool = new Pool({
            user: process.env.PG_USER,
            host: process.env.PG_HOST,
            database: process.env.PG_DATABASE,
            password: process.env.PG_PASSWORD,
            port: process.env.PG_PORT
        });

        const client = await pool.connect();
        try {
            // Check FBA order
            const fbaResult = await client.query(
                `SELECT so.*, soi.* 
                FROM salesorders so 
                JOIN salesorderitems soi ON so.id = soi.sales_order_id 
                WHERE so.platform_order_id = $1`,
                [FBA_ORDER_ID]
            );
            console.log('\nFBA Order Results:', fbaResult.rows[0]);

            // Check if any inventory was allocated for FBA order
            const fbaInventoryAllocation = await client.query(
                `SELECT * FROM salesinventorymapping sim
                JOIN salesorderitems soi ON sim.sales_order_item_id = soi.id
                JOIN salesorders so ON soi.sales_order_id = so.id
                WHERE so.platform_order_id = $1`,
                [FBA_ORDER_ID]
            );
            console.log('FBA Inventory Allocations:', fbaInventoryAllocation.rows.length);

            // Check FBM order
            const fbmResult = await client.query(
                `SELECT so.*, soi.* 
                FROM salesorders so 
                JOIN salesorderitems soi ON so.id = soi.sales_order_id 
                WHERE so.platform_order_id = $1`,
                [FBM_ORDER_ID]
            );
            console.log('\nFBM Order Results:', fbmResult.rows[0]);

            // Check inventory allocation for FBM order
            const fbmInventoryAllocation = await client.query(
                `SELECT * FROM salesinventorymapping sim
                JOIN salesorderitems soi ON sim.sales_order_item_id = soi.id
                JOIN salesorders so ON soi.sales_order_id = so.id
                WHERE so.platform_order_id = $1`,
                [FBM_ORDER_ID]
            );
            console.log('FBM Inventory Allocations:', fbmInventoryAllocation.rows.length);

            // Clean up test orders
            await client.query('DELETE FROM salesinventorymapping WHERE sales_order_item_id IN (SELECT id FROM salesorderitems WHERE sales_order_id IN (SELECT id FROM salesorders WHERE platform_order_id = $1 OR platform_order_id = $2))', [FBA_ORDER_ID, FBM_ORDER_ID]);
            await client.query('DELETE FROM salesorderitems WHERE sales_order_id IN (SELECT id FROM salesorders WHERE platform_order_id = $1 OR platform_order_id = $2)', [FBA_ORDER_ID, FBM_ORDER_ID]);
            await client.query('DELETE FROM salesorders WHERE platform_order_id = $1 OR platform_order_id = $2', [FBA_ORDER_ID, FBM_ORDER_ID]);
            console.log('\nTest orders cleaned up');

        } finally {
            client.release();
        }

    } catch (error) {
        console.error('Test failed:', error);
    }
}

// Run the test
require('dotenv').config();
runTest().then(() => console.log('Test complete')); 