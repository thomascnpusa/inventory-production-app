-- Create inventory_alerts table
CREATE TABLE IF NOT EXISTS inventory_alerts (
    id SERIAL PRIMARY KEY,
    inventory_item_id INTEGER NOT NULL REFERENCES inventoryitems(id),
    alert_type VARCHAR(50) NOT NULL CHECK (alert_type IN ('low_stock', 'expiration')),
    message TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'resolved')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP WITH TIME ZONE,
    UNIQUE(inventory_item_id, alert_type)
);

-- Create suppliers table
CREATE TABLE IF NOT EXISTS suppliers (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    contact_info TEXT,
    email VARCHAR(255),
    phone VARCHAR(50),
    address TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create procurementorders table
CREATE TABLE IF NOT EXISTS procurementorders (
    id SERIAL PRIMARY KEY,
    supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
    order_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(50) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'ordered', 'received', 'cancelled')),
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create procurementorderitems table
CREATE TABLE IF NOT EXISTS procurementorderitems (
    id SERIAL PRIMARY KEY,
    procurement_order_id INTEGER NOT NULL REFERENCES procurementorders(id),
    inventory_item_id INTEGER NOT NULL REFERENCES inventoryitems(id),
    quantity DECIMAL(10,2) NOT NULL,
    unit_price DECIMAL(10,2) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Add supplier_id to inventoryitems table if it doesn't exist
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'inventoryitems' 
        AND column_name = 'supplier_id'
    ) THEN
        ALTER TABLE inventoryitems ADD COLUMN supplier_id INTEGER REFERENCES suppliers(id);
    END IF;
END $$;

-- Add unit_price to inventoryitems table if it doesn't exist
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'inventoryitems' 
        AND column_name = 'unit_price'
    ) THEN
        ALTER TABLE inventoryitems ADD COLUMN unit_price DECIMAL(10,2);
    END IF;
END $$;

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_inventory_alerts_status ON inventory_alerts(status);
CREATE INDEX IF NOT EXISTS idx_inventory_alerts_inventory_item_id ON inventory_alerts(inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_procurementorders_supplier_id ON procurementorders(supplier_id);
CREATE INDEX IF NOT EXISTS idx_procurementorders_status ON procurementorders(status);
CREATE INDEX IF NOT EXISTS idx_procurementorderitems_procurement_order_id ON procurementorderitems(procurement_order_id);
CREATE INDEX IF NOT EXISTS idx_procurementorderitems_inventory_item_id ON procurementorderitems(inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_inventoryitems_supplier_id ON inventoryitems(supplier_id);

-- Create triggers to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Drop existing triggers if they exist
DO $$
BEGIN
    DROP TRIGGER IF EXISTS update_inventory_alerts_updated_at ON inventory_alerts;
    DROP TRIGGER IF EXISTS update_suppliers_updated_at ON suppliers;
    DROP TRIGGER IF EXISTS update_procurementorders_updated_at ON procurementorders;
    DROP TRIGGER IF EXISTS update_procurementorderitems_updated_at ON procurementorderitems;
EXCEPTION
    WHEN OTHERS THEN
        NULL;
END $$;

-- Create triggers
CREATE TRIGGER update_inventory_alerts_updated_at
    BEFORE UPDATE ON inventory_alerts
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_suppliers_updated_at
    BEFORE UPDATE ON suppliers
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_procurementorders_updated_at
    BEFORE UPDATE ON procurementorders
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_procurementorderitems_updated_at
    BEFORE UPDATE ON procurementorderitems
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column(); 