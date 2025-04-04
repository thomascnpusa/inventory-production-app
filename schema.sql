-- Users table
CREATE TABLE Users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP
);

-- User Sessions table
CREATE TABLE UserSessions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES Users(id),
    session_token VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for users and sessions
CREATE INDEX idx_users_username ON Users(username);
CREATE INDEX idx_users_email ON Users(email);
CREATE INDEX idx_sessions_token ON UserSessions(session_token);
CREATE INDEX idx_sessions_user_id ON UserSessions(user_id);

-- Inventory Items (raw materials and finished goods)
CREATE TABLE InventoryItems (
  id SERIAL PRIMARY KEY,
  sku VARCHAR(50) UNIQUE NOT NULL,
  name VARCHAR(100) NOT NULL,
  type VARCHAR(20) NOT NULL,  -- 'raw ingredient', 'finished good', 'packaging', 'label'
  stock_level INT NOT NULL,
  min_level INT NOT NULL DEFAULT 0,
  unit_type VARCHAR(20),      -- e.g., 'kg', 'units'
  batch_number VARCHAR(50),   -- Unique batch identifier
  location VARCHAR(50),       -- Storage location
  expiration_date DATE,       -- Expiration date for perishable items
  lot_number VARCHAR(50),     -- Manufacturing lot number
  supplier_id INT,            -- Link to supplier for raw materials
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Suppliers table
CREATE TABLE Suppliers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  contact_info TEXT,
  email VARCHAR(100),
  phone VARCHAR(20),
  address TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Procurement Orders table
CREATE TABLE ProcurementOrders (
  id SERIAL PRIMARY KEY,
  supplier_id INT REFERENCES Suppliers(id),
  status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending, ordered, received, cancelled
  order_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expected_delivery_date DATE,
  total_amount DECIMAL(10,2),
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Procurement Order Items table
CREATE TABLE ProcurementOrderItems (
  id SERIAL PRIMARY KEY,
  procurement_order_id INT REFERENCES ProcurementOrders(id),
  inventory_item_id INT REFERENCES InventoryItems(id),
  quantity INT NOT NULL,
  unit_price DECIMAL(10,2),
  total_price DECIMAL(10,2),
  status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending, ordered, received, cancelled
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Add trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_inventoryitems_updated_at
    BEFORE UPDATE ON InventoryItems
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_suppliers_updated_at
    BEFORE UPDATE ON Suppliers
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_procurementorders_updated_at
    BEFORE UPDATE ON ProcurementOrders
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_procurementorderitems_updated_at
    BEFORE UPDATE ON ProcurementOrderItems
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Add indexes for better performance
CREATE INDEX idx_inventoryitems_supplier ON InventoryItems(supplier_id);
CREATE INDEX idx_inventoryitems_location ON InventoryItems(location);
CREATE INDEX idx_inventoryitems_expiration ON InventoryItems(expiration_date);
CREATE INDEX idx_procurementorders_supplier ON ProcurementOrders(supplier_id);
CREATE INDEX idx_procurementorderitems_order ON ProcurementOrderItems(procurement_order_id);
CREATE INDEX idx_procurementorderitems_inventory ON ProcurementOrderItems(inventory_item_id);

-- Master Manufacturing Records (MMRs)
CREATE TABLE MMRs (
  id SERIAL PRIMARY KEY,
  product_sku VARCHAR(50) NOT NULL,
  version INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP,
  ingredients JSONB,  -- Array of {name, quantity, unit, sku}
  equipment JSONB,    -- Array of equipment names
  steps JSONB,        -- Array of {step_number, description, quality_checks}
  packaging JSONB,    -- Array of {name, quantity, unit, sku}
  labels JSONB,       -- Array of {name, quantity, unit, sku}
  created_by VARCHAR(100),
  is_active BOOLEAN DEFAULT true,
  UNIQUE(product_sku, version)
);

-- Update MMRSteps table to include step_type
ALTER TABLE MMRSteps
ADD COLUMN IF NOT EXISTS step_type VARCHAR(20) DEFAULT 'main';

-- Create MMRSubSteps table
CREATE TABLE IF NOT EXISTS MMRSubSteps (
    id SERIAL PRIMARY KEY,
    mmr_product_sku VARCHAR(50) NOT NULL,
    mmr_version INT NOT NULL,
    main_step_number INT NOT NULL,
    sub_step_number VARCHAR(20),
    description TEXT NOT NULL,
    step_type VARCHAR(20) NOT NULL, -- 'sub' or 'qc'
    FOREIGN KEY (mmr_product_sku, mmr_version) REFERENCES MMRs(product_sku, version)
);

-- Create MMREquipment table
CREATE TABLE IF NOT EXISTS MMREquipment (
    id SERIAL PRIMARY KEY,
    mmr_product_sku VARCHAR(50) NOT NULL,
    mmr_version INT NOT NULL,
    equipment_name VARCHAR(100) NOT NULL,
    FOREIGN KEY (mmr_product_sku, mmr_version) REFERENCES MMRs(product_sku, version)
);

-- Create MMRPackaging table
CREATE TABLE IF NOT EXISTS MMRPackaging (
    id SERIAL PRIMARY KEY,
    mmr_product_sku VARCHAR(50) NOT NULL,
    mmr_version INT NOT NULL,
    packaging_sku VARCHAR(50) NOT NULL,
    quantity DECIMAL(10,2) NOT NULL,
    unit_type VARCHAR(20) NOT NULL,
    FOREIGN KEY (mmr_product_sku, mmr_version) REFERENCES MMRs(product_sku, version),
    FOREIGN KEY (packaging_sku) REFERENCES InventoryItems(sku)
);

-- Create MMRLabels table
CREATE TABLE IF NOT EXISTS MMRLabels (
    id SERIAL PRIMARY KEY,
    mmr_product_sku VARCHAR(50) NOT NULL,
    mmr_version INT NOT NULL,
    label_sku VARCHAR(50) NOT NULL,
    quantity DECIMAL(10,2) NOT NULL,
    unit_type VARCHAR(20) NOT NULL,
    FOREIGN KEY (mmr_product_sku, mmr_version) REFERENCES MMRs(product_sku, version),
    FOREIGN KEY (label_sku) REFERENCES InventoryItems(sku)
);

-- Create indexes for the new tables
CREATE INDEX IF NOT EXISTS idx_mmr_substeps_mmr ON MMRSubSteps(mmr_product_sku, mmr_version);
CREATE INDEX IF NOT EXISTS idx_mmr_substeps_main_step ON MMRSubSteps(main_step_number);
CREATE INDEX IF NOT EXISTS idx_mmr_equipment_mmr ON MMREquipment(mmr_product_sku, mmr_version);
CREATE INDEX IF NOT EXISTS idx_mmr_packaging_mmr ON MMRPackaging(mmr_product_sku, mmr_version);
CREATE INDEX IF NOT EXISTS idx_mmr_labels_mmr ON MMRLabels(mmr_product_sku, mmr_version);

-- Production Orders
CREATE TABLE ProductionOrders (
  id SERIAL PRIMARY KEY,
  product_sku VARCHAR(50) NOT NULL,
  quantity INT NOT NULL,
  status VARCHAR(20) DEFAULT 'Pending',
  finished_batch_number VARCHAR(50),  -- Batch number assigned to finished goods
  mmr_product_sku VARCHAR(50) NOT NULL,  -- Reference to MMR product_sku
  mmr_version INT NOT NULL,              -- Reference to MMR version
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,  -- Track when records are updated
  FOREIGN KEY (mmr_product_sku, mmr_version) REFERENCES MMRs(product_sku, version)
);

-- Add trigger to update updated_at column for ProductionOrders
CREATE TRIGGER update_productionorders_updated_at
    BEFORE UPDATE ON ProductionOrders
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Production Batches (tracks raw materials, packaging, and labels used in production)
CREATE TABLE ProductionBatches (
  id SERIAL PRIMARY KEY,
  production_order_id INT REFERENCES ProductionOrders(id),
  item_id INT REFERENCES InventoryItems(id),
  batch_number VARCHAR(50),  -- Batch of raw material, packaging, or label used
  quantity_used DECIMAL,     -- Amount of raw material, packaging, or label consumed
  item_type VARCHAR(20)      -- 'raw_ingredient', 'packaging', or 'label'
);

-- Production Steps Table
CREATE TABLE ProductionSteps (
    id SERIAL PRIMARY KEY,
    production_order_id INT REFERENCES ProductionOrders(id),
    step_number INT NOT NULL,
    description TEXT,
    quality_checks JSONB,
    completed BOOLEAN DEFAULT FALSE,
    completed_by VARCHAR(50),
    completed_at TIMESTAMP,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(production_order_id, step_number)
);

-- Create ProductionReports table
CREATE TABLE IF NOT EXISTS ProductionReports (
    id SERIAL PRIMARY KEY,
    production_order_id INTEGER REFERENCES ProductionOrders(id),
    report_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    report_data JSONB,
    created_by VARCHAR(10)
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_production_reports_order_id ON ProductionReports(production_order_id);

-- Create indexes for faster lookups
CREATE INDEX idx_mmr_product_sku ON MMRs(product_sku);
CREATE INDEX idx_mmr_version ON MMRs(version);
CREATE INDEX idx_production_orders_mmr ON ProductionOrders(mmr_product_sku, mmr_version);
CREATE INDEX idx_inventory_type ON InventoryItems(type);
CREATE INDEX idx_production_steps_order_id ON ProductionSteps(production_order_id);

-- Create SalesOrders table
CREATE TABLE IF NOT EXISTS SalesOrders (
    id SERIAL PRIMARY KEY,
    platform VARCHAR(50) NOT NULL,
    platform_order_id VARCHAR(100) NOT NULL,
    store_name VARCHAR(100),
    order_date TIMESTAMP NOT NULL,
    customer_id VARCHAR(100),
    total_amount DECIMAL(10,2),
    status VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(platform, platform_order_id)
);

-- Create SalesOrderItems table
CREATE TABLE IF NOT EXISTS SalesOrderItems (
    id SERIAL PRIMARY KEY,
    sales_order_id INTEGER REFERENCES SalesOrders(id),
    product_sku VARCHAR(50) NOT NULL REFERENCES InventoryItems(sku),
    quantity INTEGER NOT NULL,
    unit_price DECIMAL(10,2),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create SalesInventoryMapping table
CREATE TABLE IF NOT EXISTS SalesInventoryMapping (
    id SERIAL PRIMARY KEY,
    sales_order_item_id INTEGER REFERENCES SalesOrderItems(id),
    inventory_batch_number VARCHAR(50) NOT NULL,
    quantity INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for sales tables
CREATE INDEX IF NOT EXISTS idx_sales_platform_order ON SalesOrders(platform, platform_order_id);
CREATE INDEX IF NOT EXISTS idx_sales_order_date ON SalesOrders(order_date);
CREATE INDEX IF NOT EXISTS idx_sales_items_order ON SalesOrderItems(sales_order_id);
CREATE INDEX IF NOT EXISTS idx_sales_items_sku ON SalesOrderItems(product_sku);
CREATE INDEX IF NOT EXISTS idx_sales_mapping_item ON SalesInventoryMapping(sales_order_item_id);
CREATE INDEX IF NOT EXISTS idx_sales_mapping_batch ON SalesInventoryMapping(inventory_batch_number);

-- Add created_at column to InventoryItems
DO $$ 
BEGIN 
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'inventoryitems' AND column_name = 'created_at'
    ) THEN
        ALTER TABLE InventoryItems ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
    END IF;
END $$;

-- Add customer_id column to SalesOrders if not exists
DO $$ 
BEGIN 
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'salesorders' AND column_name = 'customer_id'
    ) THEN
        ALTER TABLE SalesOrders ADD COLUMN customer_id VARCHAR(100);
    END IF;
END $$;

-- Drop existing Sales view if exists
DROP VIEW IF EXISTS Sales;

-- Create Sales view
CREATE VIEW Sales AS
SELECT 
    soi.id as id,
    so.platform_order_id as order_id,
    so.platform,
    so.store_name,
    soi.product_sku,
    soi.quantity,
    soi.unit_price,
    so.total_amount,
    so.order_date as sale_date,
    so.status
FROM SalesOrders so
JOIN SalesOrderItems soi ON so.id = soi.sales_order_id
ORDER BY so.order_date DESC;

-- Create indexes for the Sales view
CREATE INDEX IF NOT EXISTS idx_sales_view_order_id ON Sales(order_id);
CREATE INDEX IF NOT EXISTS idx_sales_view_platform ON Sales(platform);
CREATE INDEX IF NOT EXISTS idx_sales_view_product_sku ON Sales(product_sku);
CREATE INDEX IF NOT EXISTS idx_sales_view_batch_number ON Sales(batch_number);
CREATE INDEX IF NOT EXISTS idx_sales_view_sale_date ON Sales(sale_date);

-- Create InventoryReceipts table
CREATE TABLE IF NOT EXISTS InventoryReceipts (
    id SERIAL PRIMARY KEY,
    receipt_number VARCHAR(50) NOT NULL,
    sku VARCHAR(50) NOT NULL REFERENCES InventoryItems(sku),
    quantity INTEGER NOT NULL,
    batch_number VARCHAR(50),
    supplier VARCHAR(100) NOT NULL,
    delivery_date DATE NOT NULL,
    received_by VARCHAR(50) NOT NULL,
    shipment_temperature DECIMAL(5,2),
    quality_status VARCHAR(20) NOT NULL,
    expiration_date DATE,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (sku) REFERENCES InventoryItems(sku)
);

-- Create index for InventoryReceipts
CREATE INDEX IF NOT EXISTS idx_inventory_receipts_sku ON InventoryReceipts(sku);
CREATE INDEX IF NOT EXISTS idx_inventory_receipts_batch ON InventoryReceipts(batch_number);
CREATE INDEX IF NOT EXISTS idx_inventory_receipts_date ON InventoryReceipts(delivery_date);

-- Production Order Test Reports table
CREATE TABLE IF NOT EXISTS ProductionOrderTestReports (
    id SERIAL PRIMARY KEY,
    production_order_id INTEGER NOT NULL REFERENCES ProductionOrders(id) ON DELETE CASCADE,
    filename VARCHAR(255) NOT NULL,         -- The name of the file as stored on the server (could be sanitized/unique)
    original_filename VARCHAR(255) NOT NULL, -- The original name of the uploaded file
    file_path VARCHAR(512) NOT NULL UNIQUE,  -- The path where the file is stored on the server's filesystem
    mime_type VARCHAR(50) DEFAULT 'application/pdf',
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    uploaded_by_user_id INTEGER REFERENCES Users(id) -- Optional: track who uploaded
);

-- Create indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_prod_test_reports_order_id ON ProductionOrderTestReports(production_order_id);
CREATE INDEX IF NOT EXISTS idx_prod_test_reports_filename ON ProductionOrderTestReports(filename); 