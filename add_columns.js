// Script to add columns to ProductionOrders and ProductionSteps tables
require('dotenv').config();
const { Pool } = require('pg');

// Create database connection pool
const pgPool = new Pool({
  user: process.env.PG_USER,
  host: process.env.PG_HOST,
  database: process.env.PG_DATABASE,
  password: process.env.PG_PASSWORD,
  port: process.env.PG_PORT
});

async function addColumns() {
  try {
    console.log('Running ALTER TABLE statements...');
    
    // Add columns to ProductionOrders
    await pgPool.query(`
      ALTER TABLE ProductionOrders 
      ADD COLUMN IF NOT EXISTS actual_yield DECIMAL,
      ADD COLUMN IF NOT EXISTS completed_by VARCHAR(50),
      ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP
    `);
    console.log('✅ Added columns to ProductionOrders table');
    
    // Add columns to ProductionSteps
    await pgPool.query(`
      ALTER TABLE ProductionSteps 
      ADD COLUMN IF NOT EXISTS completed BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS completed_by VARCHAR(50),
      ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP
    `);
    console.log('✅ Added columns to ProductionSteps table');
    
    console.log('All columns added successfully!');
  } catch (error) {
    console.error('Error adding columns:', error);
  } finally {
    // Close the pool
    await pgPool.end();
  }
}

// Run the function
addColumns(); 