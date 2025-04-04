const express = require('express');
const router = express.Router();
const { authenticateToken, checkPermission } = require('../middleware/auth');

// Main inventory route - handles both type filtering and search
router.get('/', authenticateToken, checkPermission('view_inventory'), async (req, res) => {
    const { search, type, page = 1, limit = 50, sortBy = 'sku', sortDir = 'asc' } = req.query;
    
    // Debug logging
    console.log('GET /api/inventory request received with params:', { search, type, page, limit, sortBy, sortDir });
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
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const offset = (pageNum - 1) * limitNum;
    
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
                    COALESCE(ii.fba_inventory, 0) as fba_inventory,
                    (CASE
                        WHEN COUNT(ib.id) > 0 THEN COALESCE(SUM(ib.stock_level), 0)
                        ELSE ii.stock_level
                    END + COALESCE(ii.fba_inventory, 0)) as total_available,
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
                AND ii.is_active = true
                GROUP BY ii.id, ii.sku, ii.name, ii.type, ii.unit_type, ii.minimum_quantity
                ORDER BY ii.sku
                LIMIT $2 OFFSET $3
            `;
            
            const countQuery = `
                SELECT COUNT(DISTINCT ii.id) 
                FROM InventoryItems ii 
                WHERE (ii.sku ILIKE $1 OR ii.name ILIKE $1)
                AND ii.is_active = true
            `;
            
            const result = await pgPool.query(searchQuery, [`%${search}%`, limitNum, offset]);
            const countResult = await pgPool.query(countQuery, [`%${search}%`]);
            const totalItems = parseInt(countResult.rows[0].count);
            
            console.log(`Found ${result.rows.length} items for search term: "${search}" (page ${pageNum} of ${Math.ceil(totalItems/limitNum)})`);
            
            return res.json({
                items: result.rows,
                pagination: {
                    currentPage: pageNum,
                    totalPages: Math.ceil(totalItems / limitNum),
                    totalItems: totalItems,
                    limit: limitNum
                }
            });
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
                COALESCE(ii.fba_inventory, 0) as fba_inventory,
                (CASE
                    WHEN COUNT(ib.id) > 0 THEN COALESCE(SUM(ib.stock_level), 0)
                    ELSE ii.stock_level
                END + COALESCE(ii.fba_inventory, 0)) as total_available,
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
            WHERE ii.is_active = true
        `;
        
        let countQuery = `
            SELECT COUNT(*) FROM InventoryItems ii WHERE ii.is_active = true
        `;
        
        const queryParams = [];
        const countParams = [];
        
        if (type) {
            query += ` AND LOWER(ii.type) = LOWER($1)`;
            countQuery += ` AND LOWER(ii.type) = LOWER($1)`;
            queryParams.push(type);
            countParams.push(type);
        }
        
        query += ` GROUP BY ii.id`;
        
        // Add sorting
        if (sortBy && ['sku', 'name', 'type', 'total_stock', 'fba_inventory', 'minimum_quantity', 'unit_type'].includes(sortBy)) {
            if (sortBy === 'total_stock') {
                query += ` ORDER BY CASE 
                    WHEN COUNT(ib.id) > 0 THEN COALESCE(SUM(ib.stock_level), 0)
                    ELSE ii.stock_level
                END ${sortDir === 'desc' ? 'DESC' : 'ASC'}`;
            } else if (sortBy === 'fba_inventory') {
                query += ` ORDER BY COALESCE(ii.fba_inventory, 0) ${sortDir === 'desc' ? 'DESC' : 'ASC'}`;
            } else {
                query += ` ORDER BY ii.${sortBy} ${sortDir === 'desc' ? 'DESC' : 'ASC'}`;
            }
        } else {
            query += ` ORDER BY ii.sku ASC`;
        }
        
        // Add pagination
        query += ` LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}`;
        queryParams.push(limitNum, offset);
        
        const result = await pgPool.query(query, queryParams);
        const countResult = await pgPool.query(countQuery, countParams);
        
        const totalItems = parseInt(countResult.rows[0].count);
        const totalPages = Math.ceil(totalItems / limitNum);
        
        console.log(`Found ${result.rows.length} inventory items${type ? ` with type "${type}"` : ''} (page ${pageNum} of ${totalPages})`);
        
        return res.json({
            items: result.rows,
            pagination: {
                currentPage: pageNum,
                totalPages: totalPages,
                totalItems: totalItems,
                limit: limitNum
            }
        });
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