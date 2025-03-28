// test_sku.js - Script to test SKU mapping functionality
require('dotenv').config();
const { Pool } = require('pg');

const pgPool = new Pool({
  user: process.env.PG_USER,
  host: process.env.PG_HOST,
  database: process.env.PG_DATABASE,
  password: process.env.PG_PASSWORD,
  port: process.env.PG_PORT || 5432,
});

console.log('Connecting with params:', {
  user: process.env.PG_USER,
  host: process.env.PG_HOST,
  database: process.env.PG_DATABASE,
  port: process.env.PG_PORT
});

async function testSkuMapping() {
  const client = await pgPool.connect();
  try {
    console.log('Connected to database!');
    
    // Check existing SKU mappings
    console.log('Checking if skumapping table exists...');
    const tableCheck = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'skumapping'
      );
    `);
    
    console.log('Table exists:', tableCheck.rows[0].exists);
    
    // Check table structure
    console.log('Checking table structure...');
    const tableInfo = await client.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'skumapping'
      ORDER BY ordinal_position;
    `);
    
    console.log('Table columns:', tableInfo.rows.map(r => r.column_name).join(', '));
    
    // Check if P-1000 already exists
    const checkSku = await client.query(`
      SELECT * FROM skumapping WHERE platform_sku = 'P-1000';
    `);
    
    console.log('Found SKU P-1000 entries:', checkSku.rowCount);
    
    if (checkSku.rowCount === 0) {
      // Insert a test SKU
      console.log('Inserting test SKU P-1000...');
      await client.query(`
        INSERT INTO skumapping 
        (platform_sku, internal_sku, platform, product_name, confidence, status) 
        VALUES ('P-1000', NULL, 'shopify', 'Test Papaya Powder', 0, 'unmapped')
        ON CONFLICT (platform_sku, platform) DO NOTHING;
      `);
      
      // Verify insertion
      const verifyInsert = await client.query(`
        SELECT * FROM skumapping WHERE platform_sku = 'P-1000';
      `);
      
      console.log('Verification after insert - Found entries:', verifyInsert.rowCount);
      console.log('SKU data:', JSON.stringify(verifyInsert.rows, null, 2));
    } else {
      console.log('SKU data:', JSON.stringify(checkSku.rows, null, 2));
    }
    
    // Count total mappings
    const countQuery = await client.query('SELECT COUNT(*) FROM skumapping;');
    console.log('Total SKU mappings in database:', countQuery.rows[0].count);
    
  } catch (err) {
    console.error('Error in test script:', err);
  } finally {
    client.release();
    pgPool.end();
  }
}

testSkuMapping().catch(err => {
  console.error('Unhandled error in main execution:', err);
  process.exit(1);
}); 