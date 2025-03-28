const express = require('express');
const router = express.Router();
const { authenticateToken, checkPermission } = require('../middleware/auth');

// Main inventory route - handles both type filtering and search
router.get('/', authenticateToken, checkPermission('view_inventory'), async (req, res) => {
    const { search, type } = req.query;
    
    // Debug logging
    console.log('GET /api/inventory request received with params:', { search, type });
    console.log('pgPool availability check:', req.pgPool ? 'Available' : 'Not available');
    
    // Ensure pgPool is available
    if (!req.pgPool) {
        console.error('Database connection pool not found in request object');
        return res.status(500).json({ 
            error: 'Database connection error', 
            details: 'Connection pool not available to the route handler'
        });
    }
    
    const pgPool = req.pgPool;
    
    try {
        // Handle search parameter - used by the merge inventory feature
        if (search) {
            console.log(`Processing inventory search for term: "${search}"`);
            
            const searchQuery = `
                SELECT 
                    ii.id,
                    ii.sku,
                    ii.name,
                    ii.type,
                    ii.unit_type,
                    ii.minimum_quantity,
                    CASE 
                        WHEN COUNT(ib.id) > 0 THEN COALESCE(SUM(ib.stock_level), 0)
                        ELSE COALESCE(ii.stock_level, 0)
                    END as current_stock,
                    CASE 
                        WHEN COUNT(ib.id) > 0 THEN COALESCE(SUM(ib.stock_level), 0)
                        ELSE COALESCE(ii.stock_level, 0)
                    END as total_stock,
                    COALESCE(
                        (SELECT json_agg(
                            json_build_object(
                                'id', b.id,
                                'batch_number', b.batch_number,
                                'stock_level', b.stock_level,
                                'supplier', r.supplier,
                                'delivery_date', r.delivery_date,
                                'expiration_date', r.expiration_date,
                                'receipt_number', r.receipt_number,
                                'notes', r.notes
                            )
                        ) FROM InventoryBatches b
                        LEFT JOIN InventoryReceipts r ON b.batch_number = r.batch_number
                        WHERE b.inventory_item_id = ii.id AND b.stock_level > 0
                        ),
                        '[]'
                    ) as batches
                FROM InventoryItems ii
                LEFT JOIN InventoryBatches ib ON ii.id = ib.inventory_item_id
                WHERE (ii.sku ILIKE $1 OR ii.name ILIKE $1)
                GROUP BY ii.id, ii.sku, ii.name, ii.type, ii.unit_type, ii.minimum_quantity
                ORDER BY ii.sku
                LIMIT 50
            `;
            
            const result = await pgPool.query(searchQuery, [`%${search}%`]);
            console.log(`Found ${result.rows.length} items for search term: "${search}"`);
            return res.json(result.rows);
        }
        
        // Handle type parameter - used by the product dropdown
        console.log(`Processing inventory request with type filter: "${type || 'all'}"`);
        
        let query = `
            SELECT
                ii.*,
                COALESCE(SUM(ib.stock_level), 0) as batch_stock,
                CASE 
                    WHEN COUNT(ib.id) > 0 THEN COALESCE(SUM(ib.stock_level), 0)
                    ELSE ii.stock_level
                END as current_stock,
                CASE 
                    WHEN COUNT(ib.id) > 0 THEN COALESCE(SUM(ib.stock_level), 0)
                    ELSE ii.stock_level
                END as total_stock,
                COALESCE(
                    (SELECT json_agg(
                        json_build_object(
                            'id', b.id,
                            'batch_number', b.batch_number,
                            'stock_level', b.stock_level,
                            'supplier', r.supplier,
                            'delivery_date', r.delivery_date,
                            'expiration_date', r.expiration_date,
                            'receipt_number', r.receipt_number,
                            'notes', r.notes
                        )
                    ) FROM InventoryBatches b
                    LEFT JOIN InventoryReceipts r ON b.batch_number = r.batch_number
                    WHERE b.inventory_item_id = ii.id AND b.stock_level > 0
                    ),
                    '[]'
                ) as batches
            FROM InventoryItems ii
            LEFT JOIN InventoryBatches ib ON ii.id = ib.inventory_item_id
        `;
        
        const queryParams = [];
        
        if (type) {
            query += ` WHERE ii.type = $1`;
            queryParams.push(type);
        }
        
        query += ` GROUP BY ii.id ORDER BY ii.name`;
        
        const result = await pgPool.query(query, queryParams);
        console.log(`Found ${result.rows.length} inventory items${type ? ` with type "${type}"` : ''}`);
        return res.json(result.rows);
    } catch (error) {
        console.error('Inventory query error:', error);
        return res.status(500).json({ 
            error: 'Internal server error',
            details: error.message
        });
    }
});

// Merge endpoint
router.post('/merge', authenticateToken, checkPermission('edit_inventory'), async (req, res) => {
    const { primarySku, skusToMerge } = req.body;
    const pgPool = req.pgPool;
    
    if (!primarySku || !skusToMerge || !Array.isArray(skusToMerge) || skusToMerge.length < 2) {
        return res.status(400).json({ error: 'Invalid parameters' });
    }
    
    if (!skusToMerge.includes(primarySku)) {
        return res.status(400).json({ error: 'primarySku must be in skusToMerge' });
    }
    
    const client = await pgPool.connect();
    try {
        await client.query('BEGIN');
        
        const itemsResult = await client.query(
            'SELECT id, sku, name, stock_level FROM InventoryItems WHERE sku = ANY($1)',
            [skusToMerge]
        );
        
        if (itemsResult.rows.length !== skusToMerge.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Some items not found' });
        }
        
        let totalStockLevel = 0;
        let primaryItemId = null;
        const itemsToDelete = [];
        const primaryItemName = itemsResult.rows.find(item => item.sku === primarySku)?.name || '';
        
        for (const item of itemsResult.rows) {
            totalStockLevel += Number(item.stock_level) || 0;
            if (item.sku === primarySku) {
                primaryItemId = item.id;
            } else {
                itemsToDelete.push(item.id);
            }
        }
        
        if (!primaryItemId) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Primary item not found' });
        }
        
        const batchesResult = await client.query(
            'SELECT id, inventory_item_id, batch_number, stock_level FROM InventoryBatches WHERE inventory_item_id = ANY($1)',
            [itemsResult.rows.map(item => item.id)]
        );
        
        await client.query(
            'UPDATE InventoryItems SET stock_level = $1 WHERE id = $2',
            [totalStockLevel, primaryItemId]
        );
        
        for (const batch of batchesResult.rows) {
            const existingBatchResult = await client.query(
                'SELECT id, stock_level FROM InventoryBatches WHERE inventory_item_id = $1 AND batch_number = $2',
                [primaryItemId, batch.batch_number]
            );
            
            const batchStockLevel = Number(batch.stock_level) || 0;
            if (existingBatchResult.rows.length > 0) {
                const existingStockLevel = Number(existingBatchResult.rows[0].stock_level) || 0;
                await client.query(
                    'UPDATE InventoryBatches SET stock_level = $1 WHERE id = $2',
                    [existingStockLevel + batchStockLevel, existingBatchResult.rows[0].id]
                );
                await client.query('DELETE FROM InventoryBatches WHERE id = $1', [batch.id]);
            } else {
                await client.query(
                    'UPDATE InventoryBatches SET inventory_item_id = $1 WHERE id = $2',
                    [primaryItemId, batch.id]
                );
            }
        }
        
        await client.query(
            'UPDATE SkuMapping SET internal_sku = $1 WHERE internal_sku = ANY($2)',
            [primarySku, skusToMerge.filter(sku => sku !== primarySku)]
        );
        
        await client.query(
            'UPDATE MMRIngredients SET ingredient_sku = $1 WHERE ingredient_sku = ANY($2)',
            [primarySku, skusToMerge.filter(sku => sku !== primarySku)]
        );
        
        await client.query(
            'UPDATE ProductionOrders SET product_sku = $1 WHERE product_sku = ANY($2)',
            [primarySku, skusToMerge.filter(sku => sku !== primarySku)]
        );
        
        await client.query(
            'UPDATE InventoryReceipts SET sku = $1 WHERE sku = ANY($2)',
            [primarySku, skusToMerge.filter(sku => sku !== primarySku)]
        );
        
        // Update references in SalesOrderItems to prevent foreign key constraint violations
        await client.query(
            'UPDATE SalesOrderItems SET product_sku = $1 WHERE product_sku = ANY($2)',
            [primarySku, skusToMerge.filter(sku => sku !== primarySku)]
        );
        
        for (const itemId of itemsToDelete) {
            await client.query('DELETE FROM InventoryItems WHERE id = $1', [itemId]);
        }
        
        await client.query('COMMIT');
        res.json({ 
            success: true,
            primary_sku: primarySku,
            primary_name: primaryItemName,
            merged_skus: skusToMerge.filter(sku => sku !== primarySku),
            total_stock: totalStockLevel
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Merge error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

module.exports = router; 