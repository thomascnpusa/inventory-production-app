const express = require('express');
const router = express.Router();
const { authenticateToken, checkPermission } = require('../middleware/auth');

// Merge multiple inventory items into one
router.post('/', authenticateToken, checkPermission('edit_inventory'), async (req, res) => {
    const { primarySku, skusToMerge } = req.body;
    const pgPool = req.app.get('pgPool');
    
    if (!primarySku || !skusToMerge || !Array.isArray(skusToMerge) || skusToMerge.length === 0) {
        return res.status(400).json({ error: 'Invalid request parameters. Provide primarySku and skusToMerge array.' });
    }
    
    if (!skusToMerge.includes(primarySku)) {
        return res.status(400).json({ error: 'primarySku must be included in the skusToMerge array.' });
    }
    
    const client = await pgPool.connect();
    try {
        await client.query('BEGIN');
        
        // 1. Get all items to be merged
        const itemsResult = await client.query(
            'SELECT id, sku, name, stock_level FROM InventoryItems WHERE sku = ANY($1)',
            [skusToMerge]
        );
        
        if (itemsResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'No inventory items found with the provided SKUs.' });
        }
        
        // 2. Calculate total stock level
        let totalStockLevel = 0;
        let primaryItemId = null;
        const itemsToDelete = [];
        const primaryItemName = itemsResult.rows.find(item => item.sku === primarySku)?.name || '';
        
        for (const item of itemsResult.rows) {
            totalStockLevel += parseFloat(item.stock_level);
            
            if (item.sku === primarySku) {
                primaryItemId = item.id;
            } else {
                itemsToDelete.push(item.id);
            }
        }
        
        if (!primaryItemId) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Primary item not found.' });
        }
        
        // 3. Get all inventory batches for the items to be merged
        const batchesResult = await client.query(
            'SELECT id, inventory_item_id, batch_number, stock_level FROM InventoryBatches WHERE inventory_item_id = ANY($1)',
            [itemsToDelete]
        );
        
        // 4. Update primary item stock level
        await client.query(
            'UPDATE InventoryItems SET stock_level = $1 WHERE id = $2',
            [totalStockLevel, primaryItemId]
        );
        
        // 5. Move all batches to the primary item
        for (const batch of batchesResult.rows) {
            // Check if a batch with the same number already exists for the primary item
            const existingBatchResult = await client.query(
                'SELECT id, stock_level FROM InventoryBatches WHERE inventory_item_id = $1 AND batch_number = $2',
                [primaryItemId, batch.batch_number]
            );
            
            if (existingBatchResult.rows.length > 0) {
                // Update existing batch
                const existingBatch = existingBatchResult.rows[0];
                const newStockLevel = parseFloat(existingBatch.stock_level) + parseFloat(batch.stock_level);
                
                await client.query(
                    'UPDATE InventoryBatches SET stock_level = $1 WHERE id = $2',
                    [newStockLevel, existingBatch.id]
                );
                
                // Delete the old batch
                await client.query('DELETE FROM InventoryBatches WHERE id = $1', [batch.id]);
            } else {
                // Move batch to primary item
                await client.query(
                    'UPDATE InventoryBatches SET inventory_item_id = $1 WHERE id = $2',
                    [primaryItemId, batch.id]
                );
            }
        }
        
        // 6. Update SKU references in other tables
        
        // Update SKU mappings
        await client.query(
            'UPDATE SkuMapping SET internal_sku = $1 WHERE internal_sku = ANY($2)',
            [primarySku, skusToMerge.filter(sku => sku !== primarySku)]
        );
        
        // Update MMRs
        await client.query(
            'UPDATE MMRIngredients SET ingredient_sku = $1 WHERE ingredient_sku = ANY($2)',
            [primarySku, skusToMerge.filter(sku => sku !== primarySku)]
        );
        
        // Update Production Orders
        await client.query(
            'UPDATE ProductionOrders SET product_sku = $1 WHERE product_sku = ANY($2)',
            [primarySku, skusToMerge.filter(sku => sku !== primarySku)]
        );
        
        // 7. Move inventory receipts to the primary item
        await client.query(
            'UPDATE InventoryReceipts SET sku = $1 WHERE sku = ANY($2)',
            [primarySku, skusToMerge.filter(sku => sku !== primarySku)]
        );
        
        // 8. Delete the merged inventory items
        for (const itemId of itemsToDelete) {
            await client.query('DELETE FROM InventoryItems WHERE id = $1', [itemId]);
        }
        
        await client.query('COMMIT');
        
        res.status(200).json({ 
            success: true, 
            message: `Successfully merged ${skusToMerge.length} items into ${primarySku}`,
            primary_sku: primarySku,
            primary_name: primaryItemName,
            merged_skus: skusToMerge.filter(sku => sku !== primarySku),
            total_stock: totalStockLevel
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error merging inventory items:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

module.exports = router; 