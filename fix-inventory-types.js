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

async function standardizeInventoryTypes() {
  const client = await pgPool.connect();
  try {
    // Start a transaction
    await client.query('BEGIN');

    // Update "finished good" to "Finished Good"
    const finishedGoodResult = await client.query(
      "UPDATE inventoryitems SET type = 'Finished Good' WHERE LOWER(type) = 'finished good'"
    );
    console.log(`Updated ${finishedGoodResult.rowCount} records with "finished good" to "Finished Good"`);

    // Update "raw ingredient" to "Raw Ingredient"
    const rawIngredientResult = await client.query(
      "UPDATE inventoryitems SET type = 'Raw Ingredient' WHERE LOWER(type) = 'raw ingredient'"
    );
    console.log(`Updated ${rawIngredientResult.rowCount} records with "raw ingredient" to "Raw Ingredient"`);

    // Update "packaging" to "Packaging"
    const packagingResult = await client.query(
      "UPDATE inventoryitems SET type = 'Packaging' WHERE LOWER(type) = 'packaging'"
    );
    console.log(`Updated ${packagingResult.rowCount} records with "packaging" to "Packaging"`);

    // Update "label" to "Label"
    const labelResult = await client.query(
      "UPDATE inventoryitems SET type = 'Label' WHERE LOWER(type) = 'label'"
    );
    console.log(`Updated ${labelResult.rowCount} records with "label" to "Label"`);

    // Commit changes
    await client.query('COMMIT');
    console.log('All inventory type values have been standardized successfully');

    // Check the distinct types after updating
    const checkResult = await client.query('SELECT DISTINCT type FROM inventoryitems');
    console.log('Current inventory types in the database:');
    checkResult.rows.forEach(row => {
      console.log(`- "${row.type}"`);
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error standardizing inventory types:', error);
  } finally {
    client.release();
    await pgPool.end();
  }
}

// Run the function
standardizeInventoryTypes(); 