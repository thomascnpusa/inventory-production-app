require('dotenv').config();
const { Pool } = require('pg');

const pgPool = new Pool({
  user: process.env.PG_USER,
  host: process.env.PG_HOST,
  database: process.env.PG_DATABASE,
  password: process.env.PG_PASSWORD,
  port: process.env.PG_PORT
});

async function testStockLevels() {
  try {
    // Test the original inventory query
    const originalQuery = `
      SELECT sku, type, stock_level
      FROM InventoryItems
      WHERE sku = 'P-1011';
    `;
    
    // Test the new updated inventory query with batch sums
    const updatedQuery = `
      SELECT 
        ii.sku, 
        ii.type, 
        ii.stock_level as original_stock_level,
        CASE 
          WHEN COUNT(ib.id) > 0 THEN COALESCE(SUM(ib.stock_level), 0)
          ELSE ii.stock_level
        END as calculated_stock_level
      FROM InventoryItems ii
      LEFT JOIN InventoryBatches ib ON ii.id = ib.inventory_item_id
      WHERE ii.sku = 'P-1011'
      GROUP BY ii.sku, ii.type, ii.stock_level;
    `;
    
    // Test both queries
    const [originalResult, updatedResult] = await Promise.all([
      pgPool.query(originalQuery),
      pgPool.query(updatedQuery)
    ]);
    
    console.log("Original inventory query result:");
    console.log(originalResult.rows[0]);
    
    console.log("\nUpdated inventory query result:");
    console.log(updatedResult.rows[0]);
    
    // Get all batch details for P-1011
    const batchesQuery = `
      SELECT ib.*
      FROM InventoryBatches ib
      JOIN InventoryItems ii ON ib.inventory_item_id = ii.id
      WHERE ii.sku = 'P-1011';
    `;
    
    const batchesResult = await pgPool.query(batchesQuery);
    
    console.log("\nInventory batches for P-1011:");
    console.log(batchesResult.rows);
    
    // Calculate total batch stock manually
    let totalBatchStock = 0;
    batchesResult.rows.forEach(batch => {
      totalBatchStock += parseInt(batch.stock_level);
    });
    
    console.log(`\nManually calculated total batch stock: ${totalBatchStock}`);
    
  } catch (error) {
    console.error("Error:", error);
  } finally {
    pgPool.end();
  }
}

testStockLevels(); 