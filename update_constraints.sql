-- First, drop the foreign key constraints that depend on the sku key
ALTER TABLE salesorderitems DROP CONSTRAINT salesorderitems_product_sku_fkey;
ALTER TABLE mmringredients DROP CONSTRAINT mmringredients_ingredient_sku_fkey;
ALTER TABLE mmrpackaging DROP CONSTRAINT mmrpackaging_packaging_sku_fkey;
ALTER TABLE mmrlabels DROP CONSTRAINT mmrlabels_label_sku_fkey;
ALTER TABLE inventoryreceipts DROP CONSTRAINT inventoryreceipts_sku_fkey;

-- Drop the existing unique constraint on sku
ALTER TABLE InventoryItems DROP CONSTRAINT inventoryitems_sku_key;

-- Drop the existing unique constraint if it exists
DO $$ 
BEGIN
    IF EXISTS (
        SELECT 1 
        FROM pg_constraint 
        WHERE conname = 'unique_sku_batch_number'
    ) THEN
        ALTER TABLE InventoryItems DROP CONSTRAINT unique_sku_batch_number;
    END IF;
END $$;

-- Add a new unique constraint on (sku, batch_number)
ALTER TABLE InventoryItems
ADD CONSTRAINT unique_sku_batch_number UNIQUE (sku, batch_number);

-- Create a unique index on sku for foreign key references
CREATE UNIQUE INDEX inventoryitems_sku_idx ON InventoryItems(sku);

-- Re-add the foreign key constraints
ALTER TABLE salesorderitems 
ADD CONSTRAINT salesorderitems_product_sku_fkey 
FOREIGN KEY (product_sku) REFERENCES InventoryItems(sku);

ALTER TABLE mmringredients 
ADD CONSTRAINT mmringredients_ingredient_sku_fkey 
FOREIGN KEY (ingredient_sku) REFERENCES InventoryItems(sku);

ALTER TABLE mmrpackaging 
ADD CONSTRAINT mmrpackaging_packaging_sku_fkey 
FOREIGN KEY (packaging_sku) REFERENCES InventoryItems(sku);

ALTER TABLE mmrlabels 
ADD CONSTRAINT mmrlabels_label_sku_fkey 
FOREIGN KEY (label_sku) REFERENCES InventoryItems(sku);

ALTER TABLE inventoryreceipts 
ADD CONSTRAINT inventoryreceipts_sku_fkey 
FOREIGN KEY (sku) REFERENCES InventoryItems(sku); 