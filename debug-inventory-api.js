require('dotenv').config();
const { Pool } = require('pg');

// Create a database connection
const pgPool = new Pool({
  user: process.env.PG_USER,
  host: process.env.PG_HOST,
  database: process.env.PG_DATABASE,
  password: process.env.PG_PASSWORD,
  port: process.env.PG_PORT
});

async function debugInventoryApi() {
  try {
    // 1. First check directly from the database for Maitake products
    console.log('Checking database for Maitake products...');
    const maitakeResult = await pgPool.query(
      "SELECT id, sku, name, type, is_active FROM inventoryitems WHERE name ILIKE '%maitake%' AND type = 'Finished Good' AND is_active = true"
    );
    
    console.log(`Found ${maitakeResult.rows.length} Maitake products in database:`);
    maitakeResult.rows.forEach(row => {
      console.log(`- ${row.name} (${row.sku})`);
    });
    
    // 2. Check for all "Finished Good" products
    console.log('\nChecking all Finished Good products...');
    const finishedGoodResult = await pgPool.query(
      "SELECT id, sku, name, type, is_active FROM inventoryitems WHERE type = 'Finished Good' AND is_active = true ORDER BY sku LIMIT 10"
    );
    
    console.log(`Found ${finishedGoodResult.rowCount} total Finished Good products (showing first 10):`);
    finishedGoodResult.rows.forEach(row => {
      console.log(`- ${row.name} (${row.sku})`);
    });

    // 3. Check how the query would work with LOWER() function for case-insensitive matching
    console.log('\nComparing case-sensitive vs case-insensitive matching...');
    const [exactResult, lowerResult] = await Promise.all([
      pgPool.query("SELECT COUNT(*) FROM inventoryitems WHERE type = 'Finished Good' AND is_active = true"),
      pgPool.query("SELECT COUNT(*) FROM inventoryitems WHERE LOWER(type) = LOWER('Finished Good') AND is_active = true")
    ]);
    
    console.log(`Case-sensitive match (type = 'Finished Good'): ${exactResult.rows[0].count} products`);
    console.log(`Case-insensitive match (LOWER(type) = LOWER('Finished Good')): ${lowerResult.rows[0].count} products`);
    
    // 4. Check distinct types
    console.log('\nDistinct types in database:');
    const typeResult = await pgPool.query("SELECT DISTINCT type FROM inventoryitems");
    typeResult.rows.forEach(row => {
      console.log(`- "${row.type}"`);
    });
    
    // 5. Check if the specific FG-2001 is flagged as active
    console.log('\nChecking specific product FG-2001:');
    const specificResult = await pgPool.query(
      "SELECT id, sku, name, type, is_active FROM inventoryitems WHERE sku = 'FG-2001'"
    );
    
    if (specificResult.rows.length > 0) {
      const product = specificResult.rows[0];
      console.log(`SKU: ${product.sku}`);
      console.log(`Name: ${product.name}`);
      console.log(`Type: "${product.type}"`);
      console.log(`Active: ${product.is_active}`);
    } else {
      console.log('Product FG-2001 not found');
    }
    
    // 6. Check for MMR
    console.log('\nChecking for MMR records for FG-2001:');
    const mmrResult = await pgPool.query(
      "SELECT * FROM mmrs WHERE product_sku = 'FG-2001' AND is_active = true"
    );
    
    console.log(`Found ${mmrResult.rows.length} active MMR records`);
    mmrResult.rows.forEach(row => {
      console.log(`- Version ${row.version} (Base quantity: ${row.base_quantity} ${row.base_unit})`);
    });

  } catch (error) {
    console.error('Error debugging inventory:', error);
  } finally {
    await pgPool.end();
  }
}

// Run the function
debugInventoryApi(); 