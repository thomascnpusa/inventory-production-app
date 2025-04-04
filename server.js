// API route to get inventory item details
app.get('/api/inventory/:sku', async (req, res) => {
    // ... existing code ...
});

// API route to add Amazon SKU mapping
app.post('/api/mapping/amazon', async (req, res) => {
    try {
        const { amazonSku, internalSku } = req.body;
        
        if (!amazonSku || !internalSku) {
            return res.status(400).json({ error: 'Both amazonSku and internalSku are required' });
        }
        
        const success = await skuMapping.addSkuMapping(amazonSku, internalSku, 'amazon');
        
        if (success) {
            // Refresh FBA inventory for this specific item
            const amazon = new AmazonAPI();
            await amazon.updateSingleFbaInventory(internalSku, amazonSku);
            
            return res.json({ 
                success: true, 
                message: `Successfully mapped Amazon SKU ${amazonSku} to internal SKU ${internalSku}`
            });
        } else {
            return res.status(500).json({ error: 'Failed to add SKU mapping' });
        }
    } catch (error) {
        console.error('Error adding Amazon SKU mapping:', error);
        res.status(500).json({ error: error.message });
    }
});

// API route to get SKU mappings
app.get('/api/mapping', async (req, res) => {
    try {
        const { platform, search, limit = 100, offset = 0 } = req.query;
        const mappings = await skuMapping.getAllSkuMappings(platform, search, parseInt(limit), parseInt(offset));
        const total = await skuMapping.countSkuMappings(platform, search);
        
        res.json({
            success: true,
            mappings,
            total,
            limit: parseInt(limit),
            offset: parseInt(offset)
        });
    } catch (error) {
        console.error('Error getting SKU mappings:', error);
        res.status(500).json({ error: error.message });
    }
});

// API route to get all inventory items
// ... existing code ... 