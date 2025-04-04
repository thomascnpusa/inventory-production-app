require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');

// Create a database connection
const pgPool = new Pool({
  user: process.env.PG_USER,
  host: process.env.PG_HOST,
  database: process.env.PG_DATABASE,
  password: process.env.PG_PASSWORD,
  port: process.env.PG_PORT
});

async function debugProductsList() {
  try {
    console.log('Checking all Finished Good products in database...');
    const dbResult = await pgPool.query(
      "SELECT id, sku, name, type, is_active FROM inventoryitems WHERE type = 'Finished Good' AND is_active = true ORDER BY name"
    );
    
    // Create a map for easy comparison later
    const dbProducts = {};
    dbResult.rows.forEach(product => {
      dbProducts[product.sku] = product;
    });
    
    // Save the full product list to a file for reference
    fs.writeFileSync('db-products.json', JSON.stringify(dbResult.rows, null, 2));
    
    console.log(`Found ${dbResult.rows.length} Finished Good products in database`);
    
    // Check if specific products are in the DB results
    const maitakeProducts = dbResult.rows.filter(p => 
      p.name.toLowerCase().includes('maitake') || 
      p.sku === 'FG-2001'
    );
    
    console.log(`\nFound ${maitakeProducts.length} Maitake products in database:`);
    maitakeProducts.forEach(p => {
      console.log(`- ${p.name} (${p.sku}) [Type: ${p.type}, Active: ${p.is_active}]`);
    });
    
    // Create mock server query using same SQL logic as in the routes/inventory.js file
    // This simulates what the API endpoint would return
    console.log('\nSimulating API query for Finished Good products...');
    
    const apiSimQuery = `
      SELECT
        ii.id,
        ii.sku,
        ii.name,
        ii.type,
        ii.is_active,
        CASE 
          WHEN COUNT(ib.id) > 0 THEN COALESCE(SUM(ib.stock_level), 0)
          ELSE ii.stock_level
        END as total_stock
      FROM inventoryitems ii
      LEFT JOIN inventorybatches ib ON ii.id = ib.inventory_item_id
      WHERE ii.is_active = true
      AND LOWER(ii.type) = LOWER('Finished Good')
      GROUP BY ii.id, ii.sku, ii.name, ii.type, ii.is_active
      ORDER BY ii.name
    `;
    
    const apiSimResult = await pgPool.query(apiSimQuery);
    
    // Save the API simulation result to a file for comparison
    fs.writeFileSync('api-sim-products.json', JSON.stringify(apiSimResult.rows, null, 2));
    
    console.log(`API simulation returned ${apiSimResult.rows.length} Finished Good products`);
    
    // Check if specific products are in the API simulation results
    const apiMaitakeProducts = apiSimResult.rows.filter(p => 
      p.name.toLowerCase().includes('maitake') || 
      p.sku === 'FG-2001'
    );
    
    console.log(`\nFound ${apiMaitakeProducts.length} Maitake products in API simulation:`);
    apiMaitakeProducts.forEach(p => {
      console.log(`- ${p.name} (${p.sku}) [Type: ${p.type}, Active: ${p.is_active}]`);
    });
    
    // Compare DB products with API simulation results
    const dbSkus = new Set(dbResult.rows.map(p => p.sku));
    const apiSkus = new Set(apiSimResult.rows.map(p => p.sku));
    
    // Find products in DB but not in API results
    const missingFromApi = [...dbSkus].filter(sku => !apiSkus.has(sku));
    
    console.log('\nProducts in database but missing from API results:');
    if (missingFromApi.length > 0) {
      missingFromApi.forEach(sku => {
        const product = dbProducts[sku];
        console.log(`- ${product.name} (${product.sku}) [Type: ${product.type}, Active: ${product.is_active}]`);
      });
    } else {
      console.log('None - all database products are returned by the API query');
    }
    
    // Check for is_active=true products
    const activeDbProducts = dbResult.rows.filter(p => p.is_active);
    const activeApiProducts = apiSimResult.rows.filter(p => p.is_active);
    
    console.log(`\nActive products in DB: ${activeDbProducts.length}`);
    console.log(`Active products in API results: ${activeApiProducts.length}`);
    
    if (activeDbProducts.length !== activeApiProducts.length) {
      console.log('\nThere is a discrepancy in active products!');
    }
    
  } catch (error) {
    console.error('Error debugging product list:', error);
  } finally {
    await pgPool.end();
  }
}

// Run the function
debugProductsList(); 