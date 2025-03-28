require('dotenv').config();
const { Pool } = require('pg');

// Create a new pool instance using credentials from .env
const pgPool = new Pool({
  user: process.env.PG_USER,
  host: process.env.PG_HOST,
  database: process.env.PG_DATABASE,
  password: process.env.PG_PASSWORD,
  port: process.env.PG_PORT
});

async function testForecastInventoryMapping() {
  try {
    // Fetch inventory data
    const inventoryQuery = `
      SELECT sku, name, type, stock_level
      FROM InventoryItems
      WHERE sku IS NOT NULL AND sku != '';
    `;
    
    const inventoryResult = await pgPool.query(inventoryQuery);
    
    console.log(`Found ${inventoryResult.rows.length} inventory items`);
    
    // Log raw inventory data for a few items
    console.log("Raw inventory data (first 5 items):");
    inventoryResult.rows.slice(0, 5).forEach(item => {
      console.log(`  ${item.sku} (${item.type}): ${item.stock_level} [${typeof item.stock_level}]`);
    });
    
    // Check types
    const types = [...new Set(inventoryResult.rows.map(r => r.type))];
    console.log("Inventory types:", types);
    
    // Count finished goods by type (ignoring case)
    const finishedGoodsCount = inventoryResult.rows.filter(
      r => r.type.toLowerCase() === 'finished good'
    ).length;
    console.log(`Finished goods count (case insensitive): ${finishedGoodsCount}`);
    
    // Test the original mapping logic
    const inventory = {
      products: inventoryResult.rows
        .filter(r => r.type === 'finished good')
        .reduce((acc, r) => ({ ...acc, [r.sku]: parseInt(r.stock_level) }), {}),
      materials: inventoryResult.rows
        .filter(r => ['raw ingredient', 'packaging', 'label'].includes(r.type))
        .reduce((acc, r) => ({ ...acc, [r.sku]: parseInt(r.stock_level) }), {}),
    };
    
    // Test the updated mapping logic with case-insensitive comparison
    const updatedInventory = {
      products: inventoryResult.rows
        .filter(r => r.type.toLowerCase() === 'finished good')
        .reduce((acc, r) => ({ ...acc, [r.sku]: parseInt(r.stock_level) }), {}),
      materials: inventoryResult.rows
        .filter(r => ['raw ingredient', 'packaging', 'label'].includes(r.type.toLowerCase()))
        .reduce((acc, r) => ({ ...acc, [r.sku]: parseInt(r.stock_level) }), {}),
    };
    
    console.log(`Original mapping: ${Object.keys(inventory.products).length} products`);
    console.log(`Updated mapping: ${Object.keys(updatedInventory.products).length} products`);
    
    // Compare specific products
    const skusToCheck = ['P-1011', 'P-1010', 'P-1013', 'P-15018', 'P-35000'];
    console.log("\nChecking specific product stock levels:");
    
    skusToCheck.forEach(sku => {
      console.log(`${sku}:`);
      console.log(`  Original mapping: ${inventory.products[sku] || 'not found'}`);
      console.log(`  Updated mapping: ${updatedInventory.products[sku] || 'not found'}`);
      
      // Find the raw stock level
      const rawItem = inventoryResult.rows.find(r => r.sku === sku);
      console.log(`  Raw data: ${rawItem ? `${rawItem.stock_level} (${rawItem.type})` : 'not found'}`);
    });
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await pgPool.end();
  }
}

// Run the test
testForecastInventoryMapping(); 