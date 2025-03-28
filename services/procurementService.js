const { Pool } = require('pg');
require('dotenv').config();

class ProcurementService {
    constructor() {
        this.pgPool = new Pool({
            user: process.env.PG_USER,
            host: process.env.PG_HOST,
            database: process.env.PG_DATABASE,
            password: process.env.PG_PASSWORD,
            port: process.env.PG_PORT
        });
    }

    async createProcurementOrder(orderData) {
        const client = await this.pgPool.connect();
        try {
            await client.query('BEGIN');

            // Insert procurement order
            const orderQuery = `
                INSERT INTO procurementorders 
                (supplier_id, order_date, status, notes)
                VALUES ($1, $2, $3, $4)
                RETURNING *
            `;
            
            const orderResult = await client.query(orderQuery, [
                orderData.supplier_id,
                orderData.order_date || new Date(),
                orderData.status || 'pending',
                orderData.notes
            ]);

            const order = orderResult.rows[0];

            // Insert order items
            if (orderData.items && orderData.items.length > 0) {
                const itemQuery = `
                    INSERT INTO procurementorderitems 
                    (procurement_order_id, inventory_item_id, quantity, unit_price)
                    VALUES ($1, $2, $3, $4)
                    RETURNING *
                `;

                for (const item of orderData.items) {
                    await client.query(itemQuery, [
                        order.id,
                        item.inventory_item_id,
                        item.quantity,
                        item.unit_price
                    ]);
                }
            }

            await client.query('COMMIT');
            return order;
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Error creating procurement order:', error);
            throw error;
        } finally {
            client.release();
        }
    }

    async updateProcurementOrder(id, updates) {
        const client = await this.pgPool.connect();
        try {
            await client.query('BEGIN');

            const allowedFields = ['status', 'notes'];
            const setClause = Object.keys(updates)
                .filter(key => allowedFields.includes(key))
                .map((key, index) => `${key} = $${index + 2}`)
                .join(', ');

            if (!setClause) {
                throw new Error('No valid fields to update');
            }

            const query = `
                UPDATE procurementorders 
                SET ${setClause}
                WHERE id = $1
                RETURNING *
            `;

            const values = [id, ...Object.values(updates).filter((_, index) => 
                allowedFields.includes(Object.keys(updates)[index]))];

            const result = await client.query(query, values);

            // Update order items if provided
            if (updates.items) {
                // Delete existing items
                await client.query('DELETE FROM procurementorderitems WHERE procurement_order_id = $1', [id]);

                // Insert new items
                const itemQuery = `
                    INSERT INTO procurementorderitems 
                    (procurement_order_id, inventory_item_id, quantity, unit_price)
                    VALUES ($1, $2, $3, $4)
                    RETURNING *
                `;

                for (const item of updates.items) {
                    await client.query(itemQuery, [
                        id,
                        item.inventory_item_id,
                        item.quantity,
                        item.unit_price
                    ]);
                }
            }

            await client.query('COMMIT');
            return result.rows[0];
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Error updating procurement order:', error);
            throw error;
        } finally {
            client.release();
        }
    }

    async getProcurementOrder(id) {
        try {
            const query = `
                SELECT 
                    po.*,
                    s.name as supplier_name,
                    s.email as supplier_email,
                    s.phone as supplier_phone,
                    COUNT(poi.id) as total_items,
                    SUM(poi.quantity) as total_quantity,
                    SUM(poi.quantity * poi.unit_price) as total_cost
                FROM procurementorders po
                LEFT JOIN suppliers s ON po.supplier_id = s.id
                LEFT JOIN procurementorderitems poi ON po.id = poi.procurement_order_id
                WHERE po.id = $1
                GROUP BY po.id, s.name, s.email, s.phone
            `;
            
            const result = await this.pgPool.query(query, [id]);
            return result.rows[0];
        } catch (error) {
            console.error('Error getting procurement order:', error);
            throw error;
        }
    }

    async getAllProcurementOrders() {
        try {
            const query = `
                SELECT 
                    po.*,
                    s.name as supplier_name,
                    COUNT(poi.id) as total_items,
                    SUM(poi.quantity) as total_quantity,
                    SUM(poi.quantity * poi.unit_price) as total_cost
                FROM procurementorders po
                LEFT JOIN suppliers s ON po.supplier_id = s.id
                LEFT JOIN procurementorderitems poi ON po.id = poi.procurement_order_id
                GROUP BY po.id, s.name
                ORDER BY po.order_date DESC
            `;
            
            const result = await this.pgPool.query(query);
            return result.rows;
        } catch (error) {
            console.error('Error getting all procurement orders:', error);
            throw error;
        }
    }

    async getProcurementOrderItems(orderId) {
        try {
            const query = `
                SELECT 
                    poi.*,
                    ii.name as item_name,
                    ii.sku as item_sku,
                    ii.unit_type
                FROM procurementorderitems poi
                JOIN inventoryitems ii ON poi.inventory_item_id = ii.id
                WHERE poi.procurement_order_id = $1
                ORDER BY ii.name
            `;
            
            const result = await this.pgPool.query(query, [orderId]);
            return result.rows;
        } catch (error) {
            console.error('Error getting procurement order items:', error);
            throw error;
        }
    }

    async deleteProcurementOrder(id) {
        const client = await this.pgPool.connect();
        try {
            await client.query('BEGIN');

            // Delete order items first
            await client.query('DELETE FROM procurementorderitems WHERE procurement_order_id = $1', [id]);

            // Delete the order
            const query = 'DELETE FROM procurementorders WHERE id = $1 RETURNING *';
            const result = await client.query(query, [id]);

            await client.query('COMMIT');
            return result.rows[0];
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Error deleting procurement order:', error);
            throw error;
        } finally {
            client.release();
        }
    }
}

module.exports = new ProcurementService(); 