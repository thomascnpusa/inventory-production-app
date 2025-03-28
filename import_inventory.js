const fs = require('fs');
const csv = require('csv-parse');
const { Pool } = require('pg');
const path = require('path');

// Database configuration
const pool = new Pool({
    user: process.env.DB_USER || 'thomaspoole',
    host: process.env.DB_HOST || 'localhost',
    database: 'inventory_production_db',
    password: process.env.DB_PASSWORD || '',
    port: process.env.DB_PORT || 5432,
});

// Function to process the CSV file
async function importInventory() {
    const csvFilePath = path.join(__dirname, 'InventoryList_2025-02-27 to upload.csv');
    
    // Read and parse CSV file
    const records = [];
    const parser = fs
        .createReadStream(csvFilePath)
        .pipe(csv.parse({
            columns: true,
            skip_empty_lines: true
        }));

    for await (const record of parser) {
        records.push(record);
    }

    // Start a transaction
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Process each record
        for (const record of records) {
            const {
                product_id,
                product_name,
                type,
                quantity,
                minimum_quantity,
                location,
                batch_number,
                default_unit_of_measure,
                Sellable
            } = record;

            // Insert into InventoryItems table
            const itemResult = await client.query(
                `INSERT INTO InventoryItems 
                (sku, name, type, stock_level, unit_type, location, minimum_quantity, sellable, batch_number)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                ON CONFLICT (sku) 
                DO UPDATE SET
                    name = EXCLUDED.name,
                    type = EXCLUDED.type,
                    stock_level = EXCLUDED.stock_level,
                    unit_type = EXCLUDED.unit_type,
                    location = EXCLUDED.location,
                    minimum_quantity = EXCLUDED.minimum_quantity,
                    sellable = EXCLUDED.sellable,
                    batch_number = EXCLUDED.batch_number,
                    updated_at = CURRENT_TIMESTAMP
                RETURNING id`,
                [
                    product_id,
                    product_name,
                    type,
                    parseInt(quantity) || 0,
                    default_unit_of_measure,
                    location,
                    parseFloat(minimum_quantity) || 0,
                    Sellable.toLowerCase() === 'true',
                    batch_number || null
                ]
            );

            // If batch number is provided, add it to the InventoryBatches table
            if (batch_number && batch_number !== 'None') {
                await client.query(
                    `INSERT INTO InventoryBatches 
                    (inventory_item_id, batch_number, stock_level)
                    VALUES ($1, $2, $3)
                    ON CONFLICT (inventory_item_id, batch_number) 
                    DO UPDATE SET
                        stock_level = EXCLUDED.stock_level,
                        updated_at = CURRENT_TIMESTAMP`,
                    [itemResult.rows[0].id, batch_number, parseInt(quantity) || 0]
                );
            }
        }

        await client.query('COMMIT');
        console.log(`Successfully imported ${records.length} inventory items`);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error importing inventory:', error);
        throw error;
    } finally {
        client.release();
    }
}

// Run the import
importInventory().then(() => {
    console.log('Import completed');
    process.exit(0);
}).catch(error => {
    console.error('Import failed:', error);
    process.exit(1);
}); 