const { Pool } = require('pg');
require('dotenv').config();

class InventoryService {
    constructor() {
        this.pgPool = new Pool({
            user: process.env.PG_USER,
            host: process.env.PG_HOST,
            database: process.env.PG_DATABASE,
            password: process.env.PG_PASSWORD,
            port: process.env.PG_PORT
        });
    }

    async checkLowStock() {
        try {
            const query = `
                SELECT 
                    ii.id,
                    ii.sku,
                    ii.name,
                    ii.stock_level,
                    ii.min_level,
                    ii.unit_type,
                    s.name as supplier_name,
                    s.id as supplier_id
                FROM inventoryitems ii
                LEFT JOIN suppliers s ON ii.supplier_id = s.id
                WHERE ii.stock_level <= ii.min_level
                AND ii.type = 'raw ingredient'
                ORDER BY (ii.stock_level - ii.min_level) ASC
            `;
            
            const result = await this.pgPool.query(query);
            return result.rows;
        } catch (error) {
            console.error('Error checking low stock:', error);
            throw error;
        }
    }

    async createProcurementOrder(supplierId, items) {
        const client = await this.pgPool.connect();
        try {
            await client.query('BEGIN');

            // Create procurement order
            const orderQuery = `
                INSERT INTO procurementorders 
                (supplier_id, status, expected_delivery_date, total_amount, notes)
                VALUES ($1, 'pending', $2, $3, $4)
                RETURNING id
            `;

            const totalAmount = items.reduce((sum, item) => sum + (item.quantity * item.unit_price), 0);
            const expectedDeliveryDate = new Date();
            expectedDeliveryDate.setDate(expectedDeliveryDate.getDate() + 7); // Default 7 days delivery

            const orderResult = await client.query(orderQuery, [
                supplierId,
                expectedDeliveryDate,
                totalAmount,
                'Auto-generated order for low stock items'
            ]);

            const orderId = orderResult.rows[0].id;

            // Add order items
            for (const item of items) {
                const itemQuery = `
                    INSERT INTO procurementorderitems 
                    (procurement_order_id, inventory_item_id, quantity, unit_price, total_price)
                    VALUES ($1, $2, $3, $4, $5)
                `;

                await client.query(itemQuery, [
                    orderId,
                    item.id,
                    item.quantity,
                    item.unit_price,
                    item.quantity * item.unit_price
                ]);
            }

            await client.query('COMMIT');
            return orderId;
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Error creating procurement order:', error);
            throw error;
        } finally {
            client.release();
        }
    }

    async getExpiringItems(daysThreshold = 30) {
        try {
            const query = `
                SELECT 
                    ii.id,
                    ii.sku,
                    ii.name,
                    ii.expiration_date,
                    ii.stock_level,
                    ii.unit_type,
                    ii.location
                FROM inventoryitems ii
                WHERE ii.expiration_date IS NOT NULL
                AND ii.expiration_date <= CURRENT_DATE + interval '$1 days'
                ORDER BY ii.expiration_date ASC
            `;
            
            const result = await this.pgPool.query(query, [daysThreshold]);
            return result.rows;
        } catch (error) {
            console.error('Error getting expiring items:', error);
            throw error;
        }
    }

    async updateInventoryItem(id, updates) {
        try {
            const allowedFields = [
                'stock_level', 'location', 'expiration_date', 
                'lot_number', 'min_level', 'supplier_id'
            ];

            const setClause = Object.keys(updates)
                .filter(key => allowedFields.includes(key))
                .map((key, index) => `${key} = $${index + 2}`)
                .join(', ');

            if (!setClause) {
                throw new Error('No valid fields to update');
            }

            const query = `
                UPDATE inventoryitems 
                SET ${setClause}
                WHERE id = $1
                RETURNING *
            `;

            const values = [id, ...Object.values(updates).filter((_, index) => 
                allowedFields.includes(Object.keys(updates)[index]))];

            const result = await this.pgPool.query(query, values);
            return result.rows[0];
        } catch (error) {
            console.error('Error updating inventory item:', error);
            throw error;
        }
    }

    async getSupplierInventory(supplierId) {
        try {
            const query = `
                SELECT 
                    ii.id,
                    ii.sku,
                    ii.name,
                    ii.stock_level,
                    ii.min_level,
                    ii.unit_type,
                    ii.location,
                    ii.expiration_date
                FROM inventoryitems ii
                WHERE ii.supplier_id = $1
                ORDER BY ii.name
            `;
            
            const result = await this.pgPool.query(query, [supplierId]);
            return result.rows;
        } catch (error) {
            console.error('Error getting supplier inventory:', error);
            throw error;
        }
    }
}

module.exports = new InventoryService(); 